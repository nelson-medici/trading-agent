"""
Detección determinística de patrones de precio (sin I/O, testeables).

Opera sobre un DataFrame de velas OHLCV con columnas
ts/open/high/low/close/volume, ordenado ascendente.

Patrones detectados:
  - Soportes / Resistencias (pivots)
  - Triángulos (simétrico, ascendente, descendente)
  - Fair Value Gap (FVG)
  - Rupturas confirmadas (breakout)
  - Velas de rechazo (rejection candles)
  - Doble techo / doble piso
  - Barrido de liquidez (liquidity sweep)
"""
from dataclasses import dataclass, field
from typing import Literal
import numpy as np
import pandas as pd


# ------------------------------------------------------------------
# Tipos
# ------------------------------------------------------------------

@dataclass
class Level:
    """Soporte o resistencia detectado."""
    price: float
    kind: Literal["support", "resistance"]
    touches: int  # cuántas veces se testeó
    first_ts: str
    last_ts: str
    strength: float  # 0-1 basado en touches y recencia


@dataclass
class Triangle:
    """Triángulo detectado en formación."""
    kind: Literal["ascending", "descending", "symmetrical"]
    upper_slope: float  # pendiente de la línea superior (por vela)
    lower_slope: float
    upper_start: float  # precio inicio línea superior
    lower_start: float
    apex_bars: int  # velas hasta convergencia
    start_idx: int  # índice de inicio en el df
    end_idx: int
    start_ts: str
    end_ts: str
    breakout: str | None = None  # "up" / "down" / None


@dataclass
class FVG:
    """Fair Value Gap — ineficiencia de precio."""
    kind: Literal["bullish", "bearish"]
    top: float
    bottom: float
    ts: str  # timestamp de la vela del medio
    idx: int
    filled: bool = False


@dataclass
class Breakout:
    """Ruptura confirmada de un nivel o patrón."""
    direction: Literal["up", "down"]
    level: float
    close: float
    volume_ratio: float  # volumen vs promedio
    ts: str
    idx: int
    source: str  # "support", "resistance", "triangle", "range"


@dataclass
class RejectionCandle:
    """Vela de rechazo en zona de S/R."""
    kind: Literal["bullish_rejection", "bearish_rejection"]
    price: float  # precio del cierre
    wick_ratio: float  # largo de mecha / cuerpo
    near_level: float  # nivel de S/R cercano
    ts: str
    idx: int


@dataclass
class DoubleFormation:
    """Doble techo o doble piso."""
    kind: Literal["double_top", "double_bottom"]
    level: float
    first_ts: str
    second_ts: str
    first_idx: int
    second_idx: int
    neckline: float  # nivel del valle (top) o pico (bottom) intermedio


@dataclass
class LiquiditySweep:
    """Barrido de liquidez — mecha rompe nivel y cierre vuelve."""
    kind: Literal["sweep_low", "sweep_high"]
    level: float
    wick_low: float
    wick_high: float
    close: float
    ts: str
    idx: int


@dataclass
class PatternResult:
    """Resultado completo de la detección de patrones."""
    levels: list[Level] = field(default_factory=list)
    triangles: list[Triangle] = field(default_factory=list)
    fvgs: list[FVG] = field(default_factory=list)
    breakouts: list[Breakout] = field(default_factory=list)
    rejections: list[RejectionCandle] = field(default_factory=list)
    doubles: list[DoubleFormation] = field(default_factory=list)
    sweeps: list[LiquiditySweep] = field(default_factory=list)


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    pc = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def _ts(df: pd.DataFrame, idx: int) -> str:
    return str(df["ts"].iloc[idx])


# ------------------------------------------------------------------
# 1. SOPORTES Y RESISTENCIAS (pivots)
# ------------------------------------------------------------------

def detect_levels(df: pd.DataFrame, lookback: int = 5, tolerance_atr: float = 0.5,
                  min_touches: int = 2, max_levels: int = 10) -> list[Level]:
    """
    Detecta soportes y resistencias agrupando pivots cercanos.
    Un pivot es un mínimo/máximo local con `lookback` velas a cada lado.
    Niveles cercanos (dentro de tolerance_atr × ATR) se agrupan.
    """
    if len(df) < lookback * 2 + 1:
        return []

    atr_val = float(_atr(df).iloc[-1])
    tol = tolerance_atr * atr_val
    highs = df["high"].values
    lows = df["low"].values
    n = len(df)

    pivots: list[tuple[float, str, str, int]] = []  # (price, kind, ts, idx)

    for i in range(lookback, n - lookback):
        # Pivot alto
        if highs[i] == max(highs[i - lookback:i + lookback + 1]):
            pivots.append((float(highs[i]), "resistance", _ts(df, i), i))
        # Pivot bajo
        if lows[i] == min(lows[i - lookback:i + lookback + 1]):
            pivots.append((float(lows[i]), "support", _ts(df, i), i))

    if not pivots:
        return []

    # Agrupar pivots cercanos
    pivots.sort(key=lambda x: x[0])
    groups: list[list[tuple[float, str, str, int]]] = []
    current_group: list[tuple[float, str, str, int]] = [pivots[0]]

    for p in pivots[1:]:
        if abs(p[0] - current_group[-1][0]) <= tol:
            current_group.append(p)
        else:
            groups.append(current_group)
            current_group = [p]
    groups.append(current_group)

    levels: list[Level] = []
    for group in groups:
        if len(group) < min_touches:
            continue
        prices = [p[0] for p in group]
        avg_price = sum(prices) / len(prices)
        kinds = [p[1] for p in group]
        kind = "support" if kinds.count("support") >= kinds.count("resistance") else "resistance"
        # Strength: más touches y más reciente = más fuerte
        recency = max(p[3] for p in group) / n
        strength = min(1.0, (len(group) / 5) * 0.6 + recency * 0.4)
        levels.append(Level(
            price=round(avg_price, 8),
            kind=kind,
            touches=len(group),
            first_ts=min(p[2] for p in group),
            last_ts=max(p[2] for p in group),
            strength=round(strength, 3),
        ))

    levels.sort(key=lambda x: x.strength, reverse=True)
    return levels[:max_levels]


# ------------------------------------------------------------------
# 2. TRIÁNGULOS
# ------------------------------------------------------------------

def detect_triangles(df: pd.DataFrame, min_bars: int = 15, max_bars: int = 80,
                     lookback: int = 3) -> list[Triangle]:
    """
    Detecta triángulos buscando secuencias de máximos y mínimos
    que convergen (simétrico), suben (ascendente) o bajan (descendente).
    """
    if len(df) < min_bars:
        return []

    highs = df["high"].values
    lows = df["low"].values
    n = len(df)

    # Encontrar pivots recientes
    pivot_highs: list[tuple[int, float]] = []
    pivot_lows: list[tuple[int, float]] = []

    for i in range(lookback, n - lookback):
        if highs[i] == max(highs[i - lookback:i + lookback + 1]):
            pivot_highs.append((i, float(highs[i])))
        if lows[i] == min(lows[i - lookback:i + lookback + 1]):
            pivot_lows.append((i, float(lows[i])))

    if len(pivot_highs) < 2 or len(pivot_lows) < 2:
        return []

    triangles: list[Triangle] = []

    # Buscar en ventanas deslizantes
    for window_end in range(n - 1, min_bars - 1, -max_bars // 2):
        window_start = max(0, window_end - max_bars)

        ph = [(i, p) for i, p in pivot_highs if window_start <= i <= window_end]
        pl = [(i, p) for i, p in pivot_lows if window_start <= i <= window_end]

        if len(ph) < 2 or len(pl) < 2:
            continue

        # Regresión lineal sobre los últimos pivots
        ph_recent = ph[-4:] if len(ph) >= 4 else ph
        pl_recent = pl[-4:] if len(pl) >= 4 else pl

        if len(ph_recent) < 2 or len(pl_recent) < 2:
            continue

        # Pendiente de máximos
        ph_x = np.array([p[0] for p in ph_recent], dtype=float)
        ph_y = np.array([p[1] for p in ph_recent])
        if ph_x[-1] == ph_x[0]:
            continue
        upper_slope = float(np.polyfit(ph_x, ph_y, 1)[0])

        # Pendiente de mínimos
        pl_x = np.array([p[0] for p in pl_recent], dtype=float)
        pl_y = np.array([p[1] for p in pl_recent])
        if pl_x[-1] == pl_x[0]:
            continue
        lower_slope = float(np.polyfit(pl_x, pl_y, 1)[0])

        # Clasificar
        atr_val = float(_atr(df).iloc[-1])
        flat_threshold = atr_val * 0.01  # pendiente ~plana

        # Las líneas deben converger
        if upper_slope >= lower_slope:
            continue  # divergen o paralelas

        upper_start = float(np.polyval(np.polyfit(ph_x, ph_y, 1), ph_x[0]))
        lower_start = float(np.polyval(np.polyfit(pl_x, pl_y, 1), pl_x[0]))

        if upper_start <= lower_start:
            continue  # líneas cruzadas

        # Bars hasta convergencia
        gap = upper_start - lower_start
        convergence_rate = abs(upper_slope - lower_slope)
        if convergence_rate < 1e-12:
            continue
        apex_bars = int(gap / convergence_rate)

        if apex_bars < 5 or apex_bars > 200:
            continue

        # Tipo
        if abs(upper_slope) < flat_threshold and lower_slope > flat_threshold:
            kind = "ascending"
        elif upper_slope < -flat_threshold and abs(lower_slope) < flat_threshold:
            kind = "descending"
        elif upper_slope < -flat_threshold and lower_slope > flat_threshold:
            kind = "symmetrical"
        else:
            continue

        start_idx = int(min(ph_x[0], pl_x[0]))
        end_idx = int(max(ph_x[-1], pl_x[-1]))

        # Detectar breakout
        breakout = None
        if end_idx < n - 1:
            last_close = float(df["close"].iloc[-1])
            upper_at_end = upper_start + upper_slope * (n - 1 - ph_x[0])
            lower_at_end = lower_start + lower_slope * (n - 1 - pl_x[0])
            if last_close > upper_at_end:
                breakout = "up"
            elif last_close < lower_at_end:
                breakout = "down"

        triangles.append(Triangle(
            kind=kind,
            upper_slope=round(upper_slope, 10),
            lower_slope=round(lower_slope, 10),
            upper_start=round(upper_start, 8),
            lower_start=round(lower_start, 8),
            apex_bars=apex_bars,
            start_idx=start_idx,
            end_idx=end_idx,
            start_ts=_ts(df, start_idx),
            end_ts=_ts(df, end_idx),
            breakout=breakout,
        ))
        break  # solo el triángulo más reciente

    return triangles


# ------------------------------------------------------------------
# 3. FAIR VALUE GAP (FVG)
# ------------------------------------------------------------------

def detect_fvg(df: pd.DataFrame, min_gap_atr: float = 0.3, max_results: int = 10) -> list[FVG]:
    """
    FVG: gap entre la mecha de la vela 1 y la mecha de la vela 3.
    Bullish FVG: low[i+1] > high[i-1] (gap alcista sin llenar)
    Bearish FVG: high[i+1] < low[i-1] (gap bajista sin llenar)
    """
    if len(df) < 5:
        return []

    atr_val = float(_atr(df).iloc[-1])
    min_gap = min_gap_atr * atr_val
    fvgs: list[FVG] = []
    last_close = float(df["close"].iloc[-1])

    for i in range(1, len(df) - 1):
        h_prev = float(df["high"].iloc[i - 1])
        l_next = float(df["low"].iloc[i + 1])
        h_next = float(df["high"].iloc[i + 1])
        l_prev = float(df["low"].iloc[i - 1])

        # Bullish FVG
        if l_next > h_prev and (l_next - h_prev) >= min_gap:
            filled = last_close < l_next  # precio llenó el gap
            fvgs.append(FVG(
                kind="bullish", top=l_next, bottom=h_prev,
                ts=_ts(df, i), idx=i, filled=filled,
            ))

        # Bearish FVG
        if h_next < l_prev and (l_prev - h_next) >= min_gap:
            filled = last_close > h_next
            fvgs.append(FVG(
                kind="bearish", top=l_prev, bottom=h_next,
                ts=_ts(df, i), idx=i, filled=filled,
            ))

    # Solo los más recientes sin llenar primero
    unfilled = [f for f in fvgs if not f.filled]
    filled = [f for f in fvgs if f.filled]
    result = unfilled[-max_results:] if len(unfilled) >= max_results else unfilled + filled[-(max_results - len(unfilled)):]
    return result[-max_results:]


# ------------------------------------------------------------------
# 4. RUPTURAS
# ------------------------------------------------------------------

def detect_breakouts(df: pd.DataFrame, levels: list[Level],
                     volume_threshold: float = 1.3, lookback_vol: int = 20) -> list[Breakout]:
    """Detecta rupturas de niveles de S/R confirmadas con volumen."""
    if len(df) < lookback_vol + 2 or not levels:
        return []

    avg_vol = float(df["volume"].iloc[-lookback_vol - 1:-1].mean())
    if avg_vol <= 0:
        return []

    breakouts: list[Breakout] = []
    last = df.iloc[-1]
    prev = df.iloc[-2]
    vol_ratio = float(last["volume"]) / avg_vol

    for level in levels:
        # Ruptura alcista de resistencia
        if level.kind == "resistance":
            if float(prev["close"]) <= level.price < float(last["close"]):
                if vol_ratio >= volume_threshold:
                    breakouts.append(Breakout(
                        direction="up", level=level.price, close=float(last["close"]),
                        volume_ratio=round(vol_ratio, 2), ts=_ts(df, len(df) - 1),
                        idx=len(df) - 1, source="resistance",
                    ))

        # Ruptura bajista de soporte
        if level.kind == "support":
            if float(prev["close"]) >= level.price > float(last["close"]):
                if vol_ratio >= volume_threshold:
                    breakouts.append(Breakout(
                        direction="down", level=level.price, close=float(last["close"]),
                        volume_ratio=round(vol_ratio, 2), ts=_ts(df, len(df) - 1),
                        idx=len(df) - 1, source="support",
                    ))

    return breakouts


# ------------------------------------------------------------------
# 5. VELAS DE RECHAZO
# ------------------------------------------------------------------

def detect_rejections(df: pd.DataFrame, levels: list[Level],
                      min_wick_ratio: float = 2.0, proximity_atr: float = 0.5) -> list[RejectionCandle]:
    """
    Vela de rechazo: mecha larga (> min_wick_ratio × cuerpo) cerca de un nivel de S/R.
    """
    if len(df) < 3 or not levels:
        return []

    atr_val = float(_atr(df).iloc[-1])
    proximity = proximity_atr * atr_val
    rejections: list[RejectionCandle] = []

    for i in range(max(1, len(df) - 10), len(df)):
        o, h, l, c = float(df["open"].iloc[i]), float(df["high"].iloc[i]), float(df["low"].iloc[i]), float(df["close"].iloc[i])
        body = abs(c - o)
        if body < 1e-12:
            body = atr_val * 0.01

        upper_wick = h - max(o, c)
        lower_wick = min(o, c) - l

        for level in levels:
            # Bullish rejection: mecha larga inferior cerca de soporte
            if level.kind == "support" and abs(l - level.price) <= proximity:
                if lower_wick / body >= min_wick_ratio:
                    rejections.append(RejectionCandle(
                        kind="bullish_rejection", price=c,
                        wick_ratio=round(lower_wick / body, 2),
                        near_level=level.price, ts=_ts(df, i), idx=i,
                    ))
                    break

            # Bearish rejection: mecha larga superior cerca de resistencia
            if level.kind == "resistance" and abs(h - level.price) <= proximity:
                if upper_wick / body >= min_wick_ratio:
                    rejections.append(RejectionCandle(
                        kind="bearish_rejection", price=c,
                        wick_ratio=round(upper_wick / body, 2),
                        near_level=level.price, ts=_ts(df, i), idx=i,
                    ))
                    break

    return rejections


# ------------------------------------------------------------------
# 6. DOBLE TECHO / DOBLE PISO
# ------------------------------------------------------------------

def detect_doubles(df: pd.DataFrame, lookback: int = 5,
                   tolerance_atr: float = 0.3, min_gap_bars: int = 10) -> list[DoubleFormation]:
    """
    Doble techo: dos pivots altos al mismo nivel (±tolerance) con un valle intermedio.
    Doble piso: dos pivots bajos al mismo nivel (±tolerance) con un pico intermedio.
    """
    if len(df) < min_gap_bars + lookback * 2:
        return []

    atr_val = float(_atr(df).iloc[-1])
    tol = tolerance_atr * atr_val
    highs = df["high"].values
    lows = df["low"].values
    n = len(df)

    pivot_highs: list[tuple[int, float]] = []
    pivot_lows: list[tuple[int, float]] = []

    for i in range(lookback, n - lookback):
        if highs[i] == max(highs[i - lookback:i + lookback + 1]):
            pivot_highs.append((i, float(highs[i])))
        if lows[i] == min(lows[i - lookback:i + lookback + 1]):
            pivot_lows.append((i, float(lows[i])))

    doubles: list[DoubleFormation] = []

    # Doble techo
    for j in range(len(pivot_highs) - 1, 0, -1):
        for k in range(j - 1, max(-1, j - 5), -1):
            i2, p2 = pivot_highs[j]
            i1, p1 = pivot_highs[k]
            if i2 - i1 < min_gap_bars:
                continue
            if abs(p1 - p2) <= tol:
                # Buscar valle intermedio
                valley = float(min(lows[i1:i2 + 1]))
                doubles.append(DoubleFormation(
                    kind="double_top", level=round((p1 + p2) / 2, 8),
                    first_ts=_ts(df, i1), second_ts=_ts(df, i2),
                    first_idx=i1, second_idx=i2, neckline=valley,
                ))
                break
        if doubles and doubles[-1].kind == "double_top":
            break

    # Doble piso
    for j in range(len(pivot_lows) - 1, 0, -1):
        for k in range(j - 1, max(-1, j - 5), -1):
            i2, p2 = pivot_lows[j]
            i1, p1 = pivot_lows[k]
            if i2 - i1 < min_gap_bars:
                continue
            if abs(p1 - p2) <= tol:
                peak = float(max(highs[i1:i2 + 1]))
                doubles.append(DoubleFormation(
                    kind="double_bottom", level=round((p1 + p2) / 2, 8),
                    first_ts=_ts(df, i1), second_ts=_ts(df, i2),
                    first_idx=i1, second_idx=i2, neckline=peak,
                ))
                break
        if len(doubles) >= 2:
            break

    return doubles


# ------------------------------------------------------------------
# 7. BARRIDO DE LIQUIDEZ
# ------------------------------------------------------------------

def detect_sweeps(df: pd.DataFrame, levels: list[Level],
                  proximity_atr: float = 0.3) -> list[LiquiditySweep]:
    """
    Barrido: la mecha rompe un nivel de S/R pero el cierre vuelve del otro lado.
    """
    if len(df) < 3 or not levels:
        return []

    atr_val = float(_atr(df).iloc[-1])
    sweeps: list[LiquiditySweep] = []

    for i in range(max(1, len(df) - 5), len(df)):
        o, h, l, c = float(df["open"].iloc[i]), float(df["high"].iloc[i]), float(df["low"].iloc[i]), float(df["close"].iloc[i])

        for level in levels:
            # Sweep bajo: mecha rompe soporte pero cierre arriba
            if level.kind == "support":
                if l < level.price and c > level.price and (level.price - l) >= atr_val * 0.1:
                    sweeps.append(LiquiditySweep(
                        kind="sweep_low", level=level.price,
                        wick_low=l, wick_high=h, close=c,
                        ts=_ts(df, i), idx=i,
                    ))
                    break

            # Sweep alto: mecha rompe resistencia pero cierre abajo
            if level.kind == "resistance":
                if h > level.price and c < level.price and (h - level.price) >= atr_val * 0.1:
                    sweeps.append(LiquiditySweep(
                        kind="sweep_high", level=level.price,
                        wick_low=l, wick_high=h, close=c,
                        ts=_ts(df, i), idx=i,
                    ))
                    break

    return sweeps


# ------------------------------------------------------------------
# DETECCIÓN COMPLETA
# ------------------------------------------------------------------

def detect_all(df: pd.DataFrame, pivot_lookback: int = 5) -> PatternResult:
    """Ejecuta todas las detecciones y devuelve un PatternResult."""
    if len(df) < 20:
        return PatternResult()

    levels = detect_levels(df, lookback=pivot_lookback)
    return PatternResult(
        levels=levels,
        triangles=detect_triangles(df),
        fvgs=detect_fvg(df),
        breakouts=detect_breakouts(df, levels),
        rejections=detect_rejections(df, levels),
        doubles=detect_doubles(df, lookback=pivot_lookback),
        sweeps=detect_sweeps(df, levels),
    )
