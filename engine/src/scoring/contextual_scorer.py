"""
Contextual Pattern Scorer — el corazón del engine de decisión.

Evalúa cada señal detectada combinando 6 dimensiones:
  1. Pattern Quality (tipo, formación, claridad)
  2. Market Phase (Wyckoff: acumulación/avance/distribución/caída)
  3. Multi-Timeframe Alignment (tendencia del TF superior)
  4. Volume Confirmation (Bulkowski: breakout volume vs avg)
  5. Structural Position (dónde estamos en la estructura HH/HL/LH/LL)
  6. Momentum & Indicators (RSI, EMA alignment, ATR)

Output: score 0-100 donde:
  < 40  → NO OPERAR (ruido)
  40-60 → OBSERVAR (patrón débil o sin confirmación)
  60-75 → ENTRADA MODERADA (patrón válido, contexto parcial)
  75-85 → ENTRADA FUERTE (patrón + contexto alineados)
  > 85  → ALTA CERTEZA (todo alineado — raro pero accionable)

Basado en:
- Lo, Mamaysky & Wang (2000): validación estadística de patrones
- Bulkowski (2005): failure rates y volume confirmation
- Lo (2004): Adaptive Markets Hypothesis
- Bookmap: BOS/CHoCH, confirmación de cierre
"""
from dataclasses import dataclass
from typing import Literal
import numpy as np
import structlog

log = structlog.get_logger()


@dataclass
class ContextScore:
    """Score detallado por dimensión."""
    total: float            # 0-100 — score final
    pattern_score: float    # 0-100 — calidad del patrón
    phase_score: float      # 0-100 — alineación con fase de mercado
    mtf_score: float        # 0-100 — confirmación multi-timeframe
    volume_score: float     # 0-100 — volumen en breakout
    structure_score: float  # 0-100 — posición en la estructura
    momentum_score: float   # 0-100 — indicadores técnicos

    action: Literal["BUY", "SELL", "WATCH", "WAIT"]
    bias: Literal["bullish", "bearish", "neutral"]
    confidence_label: str   # "Alta certeza", "Entrada fuerte", etc.
    reasoning: list[str]    # factores clave (máx 4)


# ------------------------------------------------------------------
# Pesos de cada dimensión (suman 100)
# Basados en la literatura:
# - Pattern (25%): Lo et al. demostró significancia estadística
# - Phase (20%): contexto macro es el diferenciador #1 según Bulkowski
# - MTF (15%): confirmación de TF superior valida la señal
# - Volume (20%): Bulkowski: "volume is the lie detector of patterns"
# - Structure (10%): posición en HH/HL/LH/LL
# - Momentum (10%): RSI/EMA como filtro adicional
# ------------------------------------------------------------------
WEIGHTS = {
    "pattern": 25,
    "phase": 20,
    "mtf": 15,
    "volume": 20,
    "structure": 10,
    "momentum": 10,
}

# ------------------------------------------------------------------
# Win rates base por patrón (Bulkowski + CryptoGenesisLab)
# ------------------------------------------------------------------
PATTERN_BASE_RATES = {
    # Continuación — alto win rate en tendencia
    "bull_flag": 77,
    "bear_flag": 72,
    "pennant": 70,
    "ascending_triangle": 68,
    "descending_triangle": 58,
    "symmetrical_triangle": 65,
    "rectangle": 55,
    "channel": 60,

    # Reversión — alto win rate en extremos
    "head_shoulders": 70,
    "inverse_head_shoulders": 68,
    "double_top": 72,
    "double_bottom": 72,
    "triple_top": 75,
    "triple_bottom": 75,
    "rising_wedge": 65,
    "falling_wedge": 65,
    "rounding_bottom": 60,
    "diamond": 55,

    # Armónicos — Fibonacci-based
    "abcd": 65,
    "gartley": 70,
    "butterfly": 65,

    # Velas individuales
    "marubozu": 60,
    "hammer": 55,
    "shooting_star": 55,
    "engulfing": 65,
    "dark_cloud": 55,
    "harami": 50,
    "doji": 45,

    # RSI/indicadores
    "rsi_oversold": 60,
    "rsi_overbought": 60,
    "trend_alignment": 55,
    "fvg": 45,
    "rejection": 50,
    "breakout": 55,
    "liquidity_sweep": 50,
}


def _normalize_pattern_name(name: str) -> str:
    """Normaliza nombre de patrón a key del diccionario."""
    mapping = {
        "Triángulo Ascendente": "ascending_triangle",
        "Triángulo Descendente": "descending_triangle",
        "Triángulo Simétrico": "symmetrical_triangle",
        "Bandera Alcista": "bull_flag",
        "Bandera Bajista": "bear_flag",
        "Banderín Alcista": "pennant",
        "Hombro-Cabeza-Hombro": "head_shoulders",
        "HCH Invertido": "inverse_head_shoulders",
        "Doble Techo": "double_top",
        "Doble Piso": "double_bottom",
        "Triple Techo": "triple_top",
        "Triple Piso": "triple_bottom",
        "Cuña Ascendente": "rising_wedge",
        "Cuña Descendente": "falling_wedge",
        "Canal Descendente": "channel",
        "Canal Ascendente": "channel",
        "Piso Redondeado": "rounding_bottom",
        "Diamante": "diamond",
        "ABCD": "abcd",
        "Gartley": "gartley",
        "Butterfly": "butterfly",
        "Rango Lateral": "rectangle",
        "RSI Sobreventa": "rsi_oversold",
        "RSI Sobrecompra": "rsi_overbought",
        "Tendencia bajista": "trend_alignment",
        "Tendencia alcista": "trend_alignment",
        "FVG Alcista": "fvg",
        "FVG Bajista": "fvg",
        "Rechazo Alcista": "rejection",
        "Rechazo Bajista": "rejection",
        "Marubozu Alcista": "marubozu",
        "Marubozu Bajista": "marubozu",
        "Martillo": "hammer",
        "Estrella Fugaz": "shooting_star",
        "Envolvente Alcista": "engulfing",
        "Envolvente Bajista": "engulfing",
        "Nube Oscura": "dark_cloud",
        "Harami Alcista": "harami",
        "Harami Bajista": "harami",
    }
    return mapping.get(name, name.lower().replace(" ", "_"))


# ------------------------------------------------------------------
# 1. PATTERN QUALITY SCORE
# ------------------------------------------------------------------

def _score_pattern(patterns: list[dict]) -> tuple[float, list[str]]:
    """
    Score basado en:
    - Base win rate del patrón (Bulkowski)
    - Si está confirmado (+20) o en formación (-10)
    - Cantidad de patrones alineados en la misma dirección
    """
    if not patterns:
        return 0, ["Sin patrones detectados"]

    reasons = []
    scores = []

    for p in patterns:
        key = _normalize_pattern_name(p.get("name", ""))
        base = PATTERN_BASE_RATES.get(key, 50)
        confirmed = p.get("confirmed", False)
        strength = p.get("strength", 50)

        score = base
        if confirmed:
            score += 15  # confirmación sube la confianza
        else:
            score -= 10  # en formación, penalizar

        # Strength del patrón modifica
        score = score * (strength / 100) + score * 0.3

        scores.append(min(100, max(0, score)))

    # Score promedio de todos los patrones, con bonus por múltiples alineados
    avg = np.mean(scores)
    bullish_count = sum(1 for p in patterns if p.get("bias") == "bullish")
    bearish_count = sum(1 for p in patterns if p.get("bias") == "bearish")

    # Bonus por confluencia (múltiples patrones en la misma dirección)
    dominant = max(bullish_count, bearish_count)
    if dominant >= 3:
        avg = min(100, avg + 15)
        reasons.append(f"{dominant} patrones confluyen")
    elif dominant >= 2:
        avg = min(100, avg + 8)
        reasons.append(f"{dominant} patrones alineados")

    # Penalización por señales contradictorias
    if bullish_count > 0 and bearish_count > 0:
        conflict_ratio = min(bullish_count, bearish_count) / max(bullish_count, bearish_count)
        avg *= (1 - conflict_ratio * 0.3)
        reasons.append("Señales contradictorias")

    best = patterns[0] if patterns else {}
    reasons.insert(0, f"{best.get('name', '?')} ({PATTERN_BASE_RATES.get(_normalize_pattern_name(best.get('name', '')), 50)}% base)")

    return min(100, max(0, avg)), reasons


# ------------------------------------------------------------------
# 2. MARKET PHASE SCORE
# ------------------------------------------------------------------

PHASE_PATTERN_ALIGNMENT = {
    # Fase → patrones que son más confiables en esa fase
    "accumulation": {
        "bullish": {"double_bottom": 90, "triple_bottom": 92, "inverse_head_shoulders": 88,
                    "falling_wedge": 85, "rounding_bottom": 85, "hammer": 75, "engulfing": 70},
        "bearish": {"head_shoulders": 30, "rising_wedge": 35},  # Contra-fase = baja confianza
    },
    "advance": {
        "bullish": {"bull_flag": 90, "pennant": 88, "ascending_triangle": 85,
                    "channel": 70, "breakout": 80, "trend_alignment": 85},
        "bearish": {"head_shoulders": 60, "double_top": 50, "rising_wedge": 55},
    },
    "distribution": {
        "bearish": {"head_shoulders": 90, "double_top": 88, "triple_top": 90,
                    "rising_wedge": 85, "diamond": 75, "shooting_star": 70},
        "bullish": {"inverse_head_shoulders": 35, "double_bottom": 30},
    },
    "decline": {
        "bearish": {"bear_flag": 90, "descending_triangle": 85,
                    "channel": 70, "breakout": 80, "trend_alignment": 85},
        "bullish": {"double_bottom": 55, "falling_wedge": 60, "inverse_head_shoulders": 55},
    },
}


def _score_phase(phase: str, patterns: list[dict]) -> tuple[float, list[str]]:
    """Score de alineación patrón ↔ fase del mercado."""
    if not patterns or not phase:
        return 50, ["Fase no determinada"]

    alignment = PHASE_PATTERN_ALIGNMENT.get(phase, {})
    reasons = []
    scores = []

    for p in patterns:
        key = _normalize_pattern_name(p.get("name", ""))
        bias = p.get("bias", "neutral")
        bias_map = alignment.get(bias, {})

        if key in bias_map:
            s = bias_map[key]
            scores.append(s)
            if s >= 80:
                reasons.append(f"{p['name']} ideal en {phase}")
            elif s <= 40:
                reasons.append(f"{p['name']} contra-fase")
        else:
            scores.append(50)  # neutral — no hay data

    avg = np.mean(scores) if scores else 50
    return min(100, max(0, avg)), reasons[:2]


# ------------------------------------------------------------------
# 3. MULTI-TIMEFRAME SCORE
# ------------------------------------------------------------------

def _score_mtf(signal_bias: str, htf_bias: str) -> tuple[float, list[str]]:
    """Score de alineación con timeframe superior."""
    if htf_bias == signal_bias:
        return 90, [f"HTF confirma ({htf_bias})"]
    elif htf_bias == "neutral":
        return 60, ["HTF neutral"]
    else:
        return 20, [f"HTF contradice ({htf_bias})"]


# ------------------------------------------------------------------
# 4. VOLUME SCORE
# ------------------------------------------------------------------

def _score_volume(volume_ratio: float, is_breakout: bool) -> tuple[float, list[str]]:
    """
    Score de volumen según Bulkowski:
    - Breakout con vol > 1.5x avg = alta confianza
    - Vol < 0.5x = head fake probable
    - Rectangles necesitan > 1.5x (50% above avg)
    """
    reasons = []

    if is_breakout:
        if volume_ratio >= 2.0:
            score = 95
            reasons.append(f"Breakout con alto volumen ({volume_ratio:.1f}×)")
        elif volume_ratio >= 1.5:
            score = 80
            reasons.append(f"Volumen confirma ({volume_ratio:.1f}×)")
        elif volume_ratio >= 1.0:
            score = 60
            reasons.append("Volumen normal")
        elif volume_ratio >= 0.5:
            score = 35
            reasons.append(f"Volumen bajo ({volume_ratio:.1f}×) — posible head fake")
        else:
            score = 15
            reasons.append(f"Volumen muy bajo ({volume_ratio:.1f}×) — señal débil")
    else:
        # Pattern en formación: volumen decreciente es normal
        if volume_ratio < 0.8:
            score = 70  # volumen bajando durante formación = normal
            reasons.append("Vol decrece en formación (normal)")
        elif volume_ratio > 1.5:
            score = 50  # alto volumen durante formación = ambiguo
            reasons.append("Vol alto en formación — posible ruptura prematura")
        else:
            score = 60

    return min(100, max(0, score)), reasons


# ------------------------------------------------------------------
# 5. STRUCTURAL POSITION SCORE
# ------------------------------------------------------------------

def _score_structure(
    structure_trend: str,
    signal_bias: str,
    price: float,
    nearest_support: float | None,
    nearest_resistance: float | None,
) -> tuple[float, list[str]]:
    """
    Score basado en:
    - ¿El bias de la señal coincide con la estructura? (HH/HL = bullish)
    - ¿Estamos cerca de soporte (ideal para long) o resistencia (ideal para short)?
    """
    reasons = []
    score = 50

    # Alineación con estructura
    if structure_trend == "uptrend" and signal_bias == "bullish":
        score += 25
        reasons.append("Estructura alcista confirma")
    elif structure_trend == "downtrend" and signal_bias == "bearish":
        score += 25
        reasons.append("Estructura bajista confirma")
    elif structure_trend == "uptrend" and signal_bias == "bearish":
        score -= 20
        reasons.append("Contra estructura alcista")
    elif structure_trend == "downtrend" and signal_bias == "bullish":
        score -= 15
        reasons.append("Contra estructura bajista")

    # Proximidad a S/R (comprando cerca de soporte = mejor entry)
    if signal_bias == "bullish" and nearest_support and price > 0:
        dist_pct = (price - nearest_support) / price * 100
        if dist_pct < 1.5:
            score += 15
            reasons.append(f"Cerca de soporte ({dist_pct:.1f}%)")
        elif dist_pct > 5:
            score -= 10
            reasons.append("Lejos de soporte")

    if signal_bias == "bearish" and nearest_resistance and price > 0:
        dist_pct = (nearest_resistance - price) / price * 100
        if dist_pct < 1.5:
            score += 15
            reasons.append(f"Cerca de resistencia ({dist_pct:.1f}%)")

    return min(100, max(0, score)), reasons[:2]


# ------------------------------------------------------------------
# 6. MOMENTUM SCORE
# ------------------------------------------------------------------

def _score_momentum(
    rsi: float,
    ema_aligned: bool,  # True if EMAs are stacked in signal direction
    atr_pct: float,
    signal_bias: str,
) -> tuple[float, list[str]]:
    """
    Score de momentum:
    - RSI en zona extrema + reversión = bonus
    - EMAs alineadas = bonus
    - ATR alto = más oportunidad (pero más riesgo)
    """
    score = 50
    reasons = []

    # RSI
    if signal_bias == "bullish":
        if rsi < 30:
            score += 20
            reasons.append(f"RSI sobreventa ({rsi:.0f})")
        elif rsi > 70:
            score -= 15
            reasons.append(f"RSI sobrecompra ({rsi:.0f}) — contra señal")
        elif 40 < rsi < 60:
            score += 5
    elif signal_bias == "bearish":
        if rsi > 70:
            score += 20
            reasons.append(f"RSI sobrecompra ({rsi:.0f})")
        elif rsi < 30:
            score -= 15
            reasons.append(f"RSI sobreventa ({rsi:.0f}) — contra señal")

    # EMA alignment
    if ema_aligned:
        score += 15
        reasons.append("EMAs alineadas")
    else:
        score -= 5

    # ATR: volatilidad moderada es ideal (0.5-2%)
    if 0.5 < atr_pct < 2.0:
        score += 10
    elif atr_pct > 3.0:
        score -= 5
        reasons.append(f"Alta volatilidad ({atr_pct:.1f}%)")
    elif atr_pct < 0.3:
        score -= 10
        reasons.append("Baja volatilidad")

    return min(100, max(0, score)), reasons[:2]


# ------------------------------------------------------------------
# SCORER PRINCIPAL
# ------------------------------------------------------------------

def compute_contextual_score(
    patterns: list[dict],       # patrones detectados [{name, bias, confirmed, strength, ...}]
    phase: str,                 # "accumulation" | "advance" | "distribution" | "decline"
    htf_bias: str,              # "bullish" | "bearish" | "neutral"
    volume_ratio: float,        # volumen actual / promedio
    structure_trend: str,       # "uptrend" | "downtrend" | "ranging"
    rsi: float,
    ema_aligned: bool,
    atr_pct: float,
    price: float,
    nearest_support: float | None = None,
    nearest_resistance: float | None = None,
    is_breakout: bool = False,
) -> ContextScore:
    """Calcula el score contextual combinando las 6 dimensiones."""

    # Determinar bias dominante
    bullish = sum(1 for p in patterns if p.get("bias") == "bullish")
    bearish = sum(1 for p in patterns if p.get("bias") == "bearish")
    signal_bias = "bullish" if bullish > bearish else "bearish" if bearish > bullish else "neutral"

    # Calcular cada dimensión
    pat_score, pat_reasons = _score_pattern(patterns)
    phase_score, phase_reasons = _score_phase(phase, patterns)
    mtf_score, mtf_reasons = _score_mtf(signal_bias, htf_bias)
    vol_score, vol_reasons = _score_volume(volume_ratio, is_breakout)
    struct_score, struct_reasons = _score_structure(
        structure_trend, signal_bias, price, nearest_support, nearest_resistance)
    mom_score, mom_reasons = _score_momentum(rsi, ema_aligned, atr_pct, signal_bias)

    # Score ponderado
    total = (
        pat_score * WEIGHTS["pattern"] / 100 +
        phase_score * WEIGHTS["phase"] / 100 +
        mtf_score * WEIGHTS["mtf"] / 100 +
        vol_score * WEIGHTS["volume"] / 100 +
        struct_score * WEIGHTS["structure"] / 100 +
        mom_score * WEIGHTS["momentum"] / 100
    )

    # Clamp
    total = min(100, max(0, total))

    # Determinar acción
    if total >= 75 and signal_bias == "bullish":
        action = "BUY"
    elif total >= 75 and signal_bias == "bearish":
        action = "SELL"
    elif total >= 40:
        action = "WATCH"
    else:
        action = "WAIT"

    # Label
    if total >= 85:
        label = "Alta certeza"
    elif total >= 75:
        label = "Entrada fuerte"
    elif total >= 60:
        label = "Entrada moderada"
    elif total >= 40:
        label = "Observar"
    else:
        label = "Sin setup"

    # Top reasoning (máx 4 factores más relevantes)
    all_reasons = pat_reasons + phase_reasons + mtf_reasons + vol_reasons + struct_reasons + mom_reasons
    # Filtrar vacíos y tomar los primeros 4
    reasoning = [r for r in all_reasons if r][:4]

    log.info("contextual_score",
             total=round(total, 1), action=action, bias=signal_bias,
             pattern=round(pat_score, 1), phase=round(phase_score, 1),
             mtf=round(mtf_score, 1), volume=round(vol_score, 1),
             structure=round(struct_score, 1), momentum=round(mom_score, 1))

    return ContextScore(
        total=round(total, 1),
        pattern_score=round(pat_score, 1),
        phase_score=round(phase_score, 1),
        mtf_score=round(mtf_score, 1),
        volume_score=round(vol_score, 1),
        structure_score=round(struct_score, 1),
        momentum_score=round(mom_score, 1),
        action=action,
        bias=signal_bias,
        confidence_label=label,
        reasoning=reasoning,
    )
