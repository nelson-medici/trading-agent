"""
Detección de régimen de mercado.

Combina 3 señales para clasificar como risk_on / neutral / risk_off:
- BTC dominance (CoinGecko, gratis)
- Fear & Greed Index (alternative.me, gratis)
- BTC trend (precio > SMA50 diario)
"""
from typing import Literal
import httpx
import structlog

log = structlog.get_logger()


Regime = Literal["risk_on", "neutral", "risk_off"]


async def fetch_btc_dominance() -> float:
    """
    Retorna BTC dominance como float 0-1 (ej: 0.52 = 52%).
    Fallback: 0.50 si falla la API.
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get("https://api.coingecko.com/api/v3/global")
            r.raise_for_status()
            data = r.json()
            btc_dom_pct = data.get("data", {}).get("market_cap_percentage", {}).get("btc", 50)
            return float(btc_dom_pct) / 100.0
    except Exception as e:
        log.warning("btc_dominance_fetch_failed", error=str(e))
        return 0.50


async def fetch_fear_greed() -> int:
    """
    Retorna Fear & Greed Index 0-100 (0=extreme fear, 100=extreme greed).
    Fallback: 50 (neutral) si falla.
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get("https://api.alternative.me/fng/?limit=1")
            r.raise_for_status()
            data = r.json()
            val = data.get("data", [{}])[0].get("value", 50)
            return int(val)
    except Exception as e:
        log.warning("fear_greed_fetch_failed", error=str(e))
        return 50


def classify_regime(
    btc_dominance: float,
    fear_greed: int,
    btc_above_sma50: bool,
) -> Regime:
    """
    Lógica de clasificación:
    - risk_on: fear_greed >= 55 AND btc_above_sma50 (confianza + trend)
    - risk_off: fear_greed <= 30 OR not btc_above_sma50 (miedo o downtrend)
    - neutral: cualquier otra combinación

    BTC dominance se usa para ajustar bias (dom muy alta = más defensivo).
    """
    # Primero chequeo risk_off (más estricto)
    if fear_greed <= 30:
        return "risk_off"
    if not btc_above_sma50:
        return "risk_off"

    # Después risk_on
    if fear_greed >= 55 and btc_above_sma50:
        # Si dominance está disparatadamente alta (>60%), rebajar a neutral
        if btc_dominance > 0.60:
            return "neutral"
        return "risk_on"

    return "neutral"


async def detect_regime(btc_above_sma50: bool) -> dict:
    """
    Detecta régimen y retorna dict con todos los componentes.
    btc_above_sma50 lo pasamos desde el scoring (ya tenemos la data OHLCV).
    """
    btc_dom = await fetch_btc_dominance()
    fg = await fetch_fear_greed()
    regime = classify_regime(btc_dom, fg, btc_above_sma50)

    log.info(
        "regime_detected",
        regime=regime,
        btc_dominance=round(btc_dom, 4),
        fear_greed=fg,
        btc_above_sma50=btc_above_sma50,
    )

    return {
        "regime": regime,
        "btc_dominance": btc_dom,
        "fear_greed": fg,
        "btc_above_sma50": btc_above_sma50,
    }
