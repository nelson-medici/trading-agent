"""
Ingesta de OHLCV de acciones y ETFs desde Yahoo Finance.
Gratis, sin API key.

Yahoo intervals: 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d, 5d, 1wk, 1mo, 3mo
Nosotros usamos 1h (= 60m en Yahoo) para alinear con cripto.
"""
import asyncio
from datetime import datetime, timedelta, timezone
import pandas as pd
import structlog
import yfinance as yf
from src.core.db import get_db

log = structlog.get_logger()


# Mapeo de nuestros timeframes a los de Yahoo
TF_MAP = {
    "1h": "60m",
    "15m": "15m",
    "4h": "1h",   # Yahoo no tiene 4h, usamos 1h
    "1d": "1d",
}

# Límite de días históricos que Yahoo permite por timeframe
PERIOD_LIMITS = {
    "1m": 7,
    "5m": 60,
    "15m": 60,
    "30m": 60,
    "60m": 730,
    "1h": 730,
    "1d": 10_000,
}


class EquitiesMarketData:
    def __init__(self):
        self.db = get_db()

    async def fetch_ohlcv(
        self,
        symbol: str,
        timeframe: str = "1h",
        lookback_days: int = 60,
    ) -> list[dict]:
        """
        symbol en formato Yahoo (ej: 'SPY', 'AAPL', 'QQQ', 'TSLA')
        Retorna rows listos para upsert en ohlcv table.
        """
        yf_interval = TF_MAP.get(timeframe, "60m")
        max_days = PERIOD_LIMITS.get(yf_interval, 60)
        lookback = min(lookback_days, max_days)
        period = f"{lookback}d"

        def _download():
            try:
                ticker = yf.Ticker(symbol)
                df = ticker.history(period=period, interval=yf_interval, auto_adjust=False)
                return df
            except Exception as e:
                log.error("yahoo_download_failed", symbol=symbol, error=str(e))
                return None

        # yfinance es síncrono → corremos en thread pool
        df = await asyncio.to_thread(_download)
        if df is None or df.empty:
            log.warning("yahoo_empty", symbol=symbol)
            return []

        df = df.reset_index()
        # La columna de tiempo puede ser 'Datetime' o 'Date'
        ts_col = "Datetime" if "Datetime" in df.columns else "Date"

        rows = []
        for _, r in df.iterrows():
            ts = pd.to_datetime(r[ts_col])
            if ts.tzinfo is None:
                ts = ts.tz_localize("UTC")
            else:
                ts = ts.tz_convert("UTC")
            rows.append({
                "symbol": symbol,
                "timeframe": timeframe,
                "ts": ts.isoformat(),
                "open": float(r["Open"]),
                "high": float(r["High"]),
                "low": float(r["Low"]),
                "close": float(r["Close"]),
                "volume": float(r["Volume"]),
            })
        return rows

    async def ingest_universe(
        self,
        symbols: list[str],
        timeframe: str = "1h",
        lookback_days: int = 60,
    ) -> int:
        total = 0
        for symbol in symbols:
            rows = await self.fetch_ohlcv(symbol, timeframe, lookback_days)
            if rows:
                await self.db.upsert("ohlcv", rows, on_conflict="symbol,timeframe,ts")
                total += len(rows)
                log.info("equities_ingested", symbol=symbol, rows=len(rows), tf=timeframe)
        return total

    async def fetch_ticker(self, symbol: str) -> dict:
        """Precio actual de un símbolo (para watch_positions)."""
        def _info():
            try:
                ticker = yf.Ticker(symbol)
                info = ticker.fast_info
                return {
                    "last": float(info.get("last_price") or info.get("lastPrice") or 0),
                    "bid": float(info.get("bid") or 0),
                    "ask": float(info.get("ask") or 0),
                }
            except Exception:
                try:
                    hist = yf.Ticker(symbol).history(period="1d", interval="1m")
                    if not hist.empty:
                        return {"last": float(hist["Close"].iloc[-1])}
                except Exception:
                    pass
                return {"last": 0}

        return await asyncio.to_thread(_info)

    async def bid_ask_spread(self, symbol: str) -> float:
        """Spread aproximado. Yahoo no da level-2 confiable, asumimos 0.05% para bluechips."""
        return 0.0005

    async def close(self):
        pass
