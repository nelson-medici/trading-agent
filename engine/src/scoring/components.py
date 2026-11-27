"""Cálculo de sub-scores. Cada componente devuelve 0-100."""
from dataclasses import dataclass


@dataclass
class ScoreComponents:
    technical: float
    fundamental: float
    sentiment: float
    risk: float
    timing: float
    indicators_aligned: int


def score_technical(features: dict) -> tuple[float, int]:
    """
    Score técnico basado en: RSI, MACD, SMAs, ADX, volumen.
    Retorna (score, indicators_aligned).
    """
    score = 50.0
    aligned = 0

    rsi = features.get("rsi", 50)
    if 40 <= rsi <= 70:
        score += 10
        aligned += 1
    elif rsi < 30:
        score += 15
        aligned += 1
    elif rsi > 75:
        score -= 15

    macd = features.get("macd", 0)
    macd_sig = features.get("macd_signal", 0)
    macd_hist = features.get("macd_hist", 0)
    if macd > macd_sig and macd_hist > 0:
        score += 12
        aligned += 1

    price = features.get("close", 0)
    sma_20 = features.get("sma_20", 0)
    sma_50 = features.get("sma_50", 0)
    sma_200 = features.get("sma_200", 0)
    if price > sma_20 > sma_50 > sma_200:
        score += 15
        aligned += 1
    elif price > sma_50 > sma_200:
        score += 8
        aligned += 1

    adx = features.get("adx", 0)
    if adx > 25:
        score += 8
        aligned += 1

    vol_ratio = features.get("volume_ratio", 1)
    if vol_ratio > 1.5:
        score += 10
        aligned += 1
    elif vol_ratio < 0.7:
        score -= 5

    return max(0, min(100, score)), aligned


def score_fundamental(features: dict, is_crypto: bool = True) -> float:
    """
    Para cripto: usar régimen y BTC dominance.
    Para stocks: earnings, P/E, growth (fase 2).
    """
    if is_crypto:
        score = 50.0
        regime = features.get("regime", "neutral")
        if regime == "risk_on":
            score += 20
        elif regime == "risk_off":
            score -= 15
        btc_dom = features.get("btc_dominance", 0.5)
        if 0.42 <= btc_dom <= 0.55:
            score += 10
        return max(0, min(100, score))
    return 50.0


def score_sentiment(features: dict) -> float:
    """Score de sentimiento 0-100 desde noticias procesadas por LLM."""
    raw = features.get("sentiment_score", 0)
    news_count = features.get("news_count_7d", 0)
    # Normalizar -1..1 a 0..100 con peso por volumen de noticias
    base = (raw + 1) * 50
    # Si hay muy pocas noticias, atenuar hacia 50 (neutral)
    if news_count < 3:
        base = base * 0.3 + 50 * 0.7
    fear_greed = features.get("fear_greed", 50)
    fg_norm = fear_greed  # 0-100
    combined = 0.6 * base + 0.4 * fg_norm
    return max(0, min(100, combined))


def score_risk(features: dict) -> float:
    """
    Score de riesgo: activos con menor volatilidad y mayor liquidez → score más alto.
    """
    score = 70.0
    spread = features.get("bid_ask_spread_pct", 0.001)
    if spread < 0.001:
        score += 15
    elif spread > 0.003:
        score -= 20

    vol_regime = features.get("volatility_regime", "medium")
    if vol_regime == "low":
        score += 10
    elif vol_regime == "high":
        score -= 15

    vol_24h = features.get("volume_24h_usd", 0)
    if vol_24h > 100_000_000:
        score += 5
    elif vol_24h < 10_000_000:
        score -= 20

    return max(0, min(100, score))


def score_timing(features: dict) -> float:
    """
    Score de timing: confluencia con régimen macro,
    ausencia de eventos disruptivos próximos.
    """
    score = 60.0
    if features.get("has_event_in_48h", False):
        score -= 30
    regime = features.get("regime", "neutral")
    if regime == "risk_on":
        score += 15
    return max(0, min(100, score))


def compute_all_components(features: dict, is_crypto: bool = True) -> ScoreComponents:
    tech, aligned = score_technical(features)
    return ScoreComponents(
        technical=tech,
        fundamental=score_fundamental(features, is_crypto),
        sentiment=score_sentiment(features),
        risk=score_risk(features),
        timing=score_timing(features),
        indicators_aligned=aligned,
    )
