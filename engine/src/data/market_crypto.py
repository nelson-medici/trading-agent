"""Ingesta de OHLCV desde Binance via CCXT."""
import ccxt.async_support as ccxt
from datetime import datetime
import structlog
from src.core.db import get_db
from src.core.config import get_env

log = structlog.get_logger()


class CryptoMarketData:
    def __init__(self, use_testnet: bool = False):
        env = get_env()
        self.db = get_db()
        opts: dict = {
            "enableRateLimit": True,
            # Auto-sync local clock with Binance server time on each request
            # This prevents -1021 "Timestamp ahead of server" errors when
            # the local machine clock drifts by >1s
            "options": {
                "adjustForTimeDifference": True,
                "recvWindow": 10000,  # 10s tolerance (default is 5s)
            },
        }
        if use_testnet:
            opts["apiKey"] = env.binance_testnet_api_key
            opts["secret"] = env.binance_testnet_api_secret
            opts["options"]["defaultType"] = "spot"
            self.exchange = ccxt.binance(opts)
            self.exchange.set_sandbox_mode(True)
        else:
            if env.binance_api_key:
                opts["apiKey"] = env.binance_api_key
                opts["secret"] = env.binance_api_secret
            self.exchange = ccxt.binance(opts)

    async def close(self):
        await self.exchange.close()

    async def fetch_ohlcv(
        self,
        symbol: str,
        timeframe: str = "1h",
        limit: int = 500,
    ) -> list[dict]:
        try:
            ohlcv = await self.exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
            return [
                {
                    "symbol": symbol,
                    "timeframe": timeframe,
                    "ts": datetime.utcfromtimestamp(row[0] / 1000).isoformat() + "Z",
                    "open": row[1],
                    "high": row[2],
                    "low": row[3],
                    "close": row[4],
                    "volume": row[5],
                }
                for row in ohlcv
            ]
        except Exception as e:
            log.error("fetch_ohlcv_failed", symbol=symbol, error=str(e))
            return []

    async def fetch_ticker(self, symbol: str) -> dict:
        return await self.exchange.fetch_ticker(symbol)

    async def fetch_orderbook(self, symbol: str, limit: int = 20) -> dict:
        return await self.exchange.fetch_order_book(symbol, limit=limit)

    async def bid_ask_spread(self, symbol: str) -> float:
        ob = await self.fetch_orderbook(symbol, limit=5)
        bid = ob["bids"][0][0] if ob["bids"] else 0
        ask = ob["asks"][0][0] if ob["asks"] else 0
        if bid == 0 or ask == 0:
            return 0.01
        return (ask - bid) / ((ask + bid) / 2)

    async def ingest_universe(
        self,
        symbols: list[str],
        timeframe: str = "1h",
        limit: int = 500,
    ) -> int:
        total = 0
        for symbol in symbols:
            rows = await self.fetch_ohlcv(symbol, timeframe, limit)
            if rows:
                await self.db.upsert("ohlcv", rows, on_conflict="symbol,timeframe,ts")
                total += len(rows)
                log.info("ohlcv_ingested", symbol=symbol, rows=len(rows))
        return total
