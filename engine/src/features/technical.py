"""Cálculo de features técnicas usando pandas_ta."""
import pandas as pd
import pandas_ta as ta
import structlog

log = structlog.get_logger()


def compute_technical_features(df: pd.DataFrame) -> dict:
    """
    df: DataFrame con columnas open, high, low, close, volume, ts
    Retorna dict con features del último punto.
    """
    if len(df) < 200:
        log.warning("insufficient_data_for_features", rows=len(df))
        return {}

    df = df.sort_values("ts").reset_index(drop=True)

    df["rsi"] = ta.rsi(df["close"], length=14)
    macd = ta.macd(df["close"], fast=12, slow=26, signal=9)
    df["macd"] = macd["MACD_12_26_9"]
    df["macd_signal"] = macd["MACDs_12_26_9"]
    df["macd_hist"] = macd["MACDh_12_26_9"]
    df["sma_20"] = ta.sma(df["close"], length=20)
    df["sma_50"] = ta.sma(df["close"], length=50)
    df["sma_200"] = ta.sma(df["close"], length=200)
    df["atr"] = ta.atr(df["high"], df["low"], df["close"], length=14)
    adx = ta.adx(df["high"], df["low"], df["close"], length=14)
    df["adx"] = adx["ADX_14"] if adx is not None else 0

    vol_sma20 = df["volume"].rolling(20).mean()
    df["volume_ratio"] = df["volume"] / vol_sma20

    last = df.iloc[-1]
    price = last["close"]

    # Régimen de volatilidad
    atr_pct = (last["atr"] / price) * 100 if price > 0 else 0
    if atr_pct < 2:
        vol_regime = "low"
    elif atr_pct < 5:
        vol_regime = "medium"
    else:
        vol_regime = "high"

    return {
        "close": float(price),
        "rsi": float(last["rsi"] or 0),
        "macd": float(last["macd"] or 0),
        "macd_signal": float(last["macd_signal"] or 0),
        "macd_hist": float(last["macd_hist"] or 0),
        "sma_20": float(last["sma_20"] or 0),
        "sma_50": float(last["sma_50"] or 0),
        "sma_200": float(last["sma_200"] or 0),
        "atr": float(last["atr"] or 0),
        "adx": float(last["adx"] or 0),
        "volume_ratio": float(last["volume_ratio"] or 1),
        "price_above_sma200": bool(price > (last["sma_200"] or 0)),
        "volatility_regime": vol_regime,
    }
