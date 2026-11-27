"""Adaptadores reales (Supabase + Binance) para el scalper y entry points de los jobs."""
from datetime import datetime
import pandas as pd
import structlog

log = structlog.get_logger()

_market = None


class SupabaseStore:
    def __init__(self):
        from src.core.db import get_db
        self.db = get_db()
        self.c = self.db.client

    async def live_session(self) -> dict | None:
        r = (self.c.table("scalper_sessions").select("*").in_("status", ["requested", "active"])
             .order("requested_at", desc=True).limit(1).execute())
        return r.data[0] if r.data else None

    async def update_session(self, sid: str, data: dict) -> None:
        await self.db.update("scalper_sessions", data, {"id": sid})

    async def open_trade(self, sid: str) -> dict | None:
        rows = await self.db.select("scalper_trades", filters={"session_id": sid, "status": "open"}, limit=1)
        return rows[0] if rows else None

    async def insert_trade(self, data: dict) -> dict:
        return await self.db.insert("scalper_trades", data)

    async def update_trade(self, tid: str, data: dict) -> None:
        await self.db.update("scalper_trades", data, {"id": tid})

    async def insert_ledger_trade(self, data: dict) -> None:
        await self.db.insert("trades", data)

    async def insert_alert(self, level: str, category: str, title: str, message: str, metadata: dict) -> None:
        await self.db.insert("alerts", {
            "level": level, "category": category, "title": title, "message": message, "metadata": metadata,
        })

    async def kill_active(self) -> bool:
        rows = await self.db.select("kill_switch", ["active"], {"id": 1})
        return bool(rows and rows[0]["active"])

    async def pool_cash(self, pool: str) -> float:
        rows = await self.db.select("equity_snapshots", ["cash_usd"], {"pool": pool}, order_by="-ts", limit=1)
        return float(rows[0]["cash_usd"]) if rows else 0.0

    async def config(self) -> dict:
        return await self.db.get_config_value("scalper.config") or {}

    async def upsert_scan(self, row: dict) -> None:
        await self.db.upsert("scalper_scan", row, on_conflict="symbol")

    async def last_opportunity_at(self, symbol: str) -> datetime | None:
        rows = await self.db.select("scalper_opportunities", ["detected_at"], {"symbol": symbol},
                                    order_by="-detected_at", limit=1)
        return pd.to_datetime(rows[0]["detected_at"], utc=True).to_pydatetime() if rows else None

    async def insert_opportunity(self, row: dict) -> None:
        await self.db.insert("scalper_opportunities", row)

    async def insert_session(self, row: dict) -> None:
        await self.db.insert("scalper_sessions", row)

    async def sessions_since(self, since: datetime) -> list[dict]:
        r = (self.c.table("scalper_sessions").select("id,auto,status,realized_pnl_usd,ended_at,requested_at")
             .gte("requested_at", since.isoformat()).execute())
        return r.data or []


class BinanceMarket:
    """Velas 1m y cotización en vivo. Reutiliza una sola conexión CCXT."""

    def __init__(self):
        from src.data.market_crypto import CryptoMarketData
        self.md = CryptoMarketData()

    async def fetch_candles(self, symbol: str, limit: int = 360) -> pd.DataFrame:
        rows = await self.md.fetch_ohlcv(symbol, "1m", limit)
        if not rows:
            raise RuntimeError(f"sin velas 1m para {symbol}")
        return pd.DataFrame(rows)

    async def fetch_quote(self, symbol: str) -> tuple[float, float]:
        t = await self.md.fetch_ticker(symbol)
        bid, ask = float(t.get("bid") or 0), float(t.get("ask") or 0)
        if bid <= 0 or ask <= 0:
            last = float(t.get("last") or 0)
            bid = bid or last
            ask = ask or last
        return bid, ask


def _get_market() -> BinanceMarket:
    global _market
    if _market is None:
        _market = BinanceMarket()
    return _market


async def run_tick() -> None:
    from src.scalper.session import tick
    store = SupabaseStore()
    if await store.live_session() is None:
        return  # camino barato: sin sesión no se toca el exchange
    await tick(store, _get_market())


async def run_scan() -> None:
    from src.scalper.detector import scan
    await scan(SupabaseStore(), _get_market())
