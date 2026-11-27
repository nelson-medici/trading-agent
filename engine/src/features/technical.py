"""Cálculo de features técnicas usando ta library."""
import pandas as pd
from ta.momentum import RSIIndicator
from ta.trend import MACD, SMAIndicator, ADXIndicator
from ta.volatility import AverageTrueRange
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

    # RSI
    df["rsi"] = RSIIndicator(close=df["close"], window=14).rsi()

    # MACD
    macd = MACD(close=df["close"], window_slow=26, window_fast=12, window_sign=9)
    df["macd"] = macd.macd()
    df["macd_signal"] = macd.macd_signal()
    df["macd_hist"] = macd.macd_diff()

    # SMAs
    df["sma_20"] = SMAIndicator(close=df["close"], window=20).sma_indicator()
    df["sma_50"] = SMAIndicator(close=df["close"], window=50).sma_indicator()
    df["sma_200"] = SMAIndicator(close=df["close"], window=200).sma_indicator()

    # ATR
    df["atr"] = AverageTrueRange(
        high=df["high"], low=df["low"], close=df["close"], window=14,
    ).average_true_range()

    # ADX
    try:
        adx = ADXIndicator(high=df["high"], low=df["low"], close=df["close"], window=14)
        df["adx"] = adx.adx()
    except Exception:
        df["adx"] = 0

    # Volume ratio vs SMA20 del volumen
    vol_sma20 = df["volume"].rolling(20).mean()
    df["volume_ratio"] = df["volume"] / vol_sma20

    last = df.iloc[-1]
    price = float(last["close"])

    # Régimen de volatilidad
    atr_val = float(last["atr"]) if pd.notna(last["atr"]) else 0
    atr_pct = (atr_val / price) * 100 if price > 0 else 0
    if atr_pct < 2:
        vol_regime = "low"
    elif atr_pct < 5:
        vol_regime = "medium"
    else:
        vol_regime = "high"

    def safe_float(v, default=0.0):
        try:
            return float(v) if pd.notna(v) else default
        except (ValueError, TypeError):
            return default

    sma_200_val = safe_float(last["sma_200"])

    return {
        "close": price,
        "rsi": safe_float(last["rsi"], 50.0),
        "macd": safe_float(last["macd"]),
        "macd_signal": safe_float(last["macd_signal"]),
        "macd_hist": safe_float(last["macd_hist"]),
        "sma_20": safe_float(last["sma_20"]),
        "sma_50": safe_float(last["sma_50"]),
        "sma_200": sma_200_val,
        "atr": atr_val,
        "adx": safe_float(last["adx"]),
        "volume_ratio": safe_float(last["volume_ratio"], 1.0),
        "price_above_sma200": bool(price > sma_200_val) if sma_200_val > 0 else False,
        "volatility_regime": vol_regime,
    }
