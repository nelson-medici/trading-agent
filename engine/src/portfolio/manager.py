"""Portfolio state manager — multi-pool aware."""
from src.core.db import get_db


class PortfolioManager:
    def __init__(self):
        self.db = get_db()

    async def get_positions(self, pool: str | None = None) -> list[dict]:
        filters = {"pool": pool} if pool else None
        return await self.db.select("positions", filters=filters)

    async def get_position(self, symbol: str, pool: str = "core") -> dict | None:
        rows = await self.db.select("positions", filters={"symbol": symbol, "pool": pool})
        return rows[0] if rows else None

    async def open_positions_count(self, pool: str | None = None) -> int:
        return len(await self.get_positions(pool))

    async def has_open_position(self, symbol: str, pool: str = "core") -> bool:
        return (await self.get_position(symbol, pool)) is not None

    async def has_pending_order(self, symbol: str, pool: str = "core") -> bool:
        orders = await self.db.select(
            "orders", filters={"symbol": symbol, "state": "SUBMITTED", "pool": pool},
        )
        return len(orders) > 0

    async def current_equity(self) -> float:
        """Equity total agregado de todos los pools."""
        pools = ["core", "tactical"]
        total = 0.0
        for p in pools:
            total += await self.current_equity_pool(p)
        return total

    async def current_equity_pool(self, pool: str) -> float:
        rows = await self.db.select(
            "equity_snapshots", ["total_equity_usd"],
            filters={"pool": pool},
            order_by="-ts", limit=1,
        )
        if rows:
            return float(rows[0]["total_equity_usd"])
        # Fallback: usar deposits si no hay snapshot
        events = await self.db.select("capital_events", ["amount_usd", "event_type"], filters={"pool": pool})
        return sum(float(e["amount_usd"]) * (1 if e["event_type"] == "deposit" else -1) for e in events)

    async def current_position_pct(self, symbol: str, pool: str = "core") -> float:
        pos = await self.get_position(symbol, pool)
        equity = await self.current_equity_pool(pool)
        if not pos or equity == 0:
            return 0.0
        return (pos["size_units"] * (pos.get("current_price") or pos["entry_price"])) / equity

    async def current_position_pct_pool(self, symbol: str, pool: str) -> float:
        return await self.current_position_pct(symbol, pool)

    async def simulated_exposure_pct(self, order: dict, pool: str = "core") -> float:
        current_pct = await self.current_position_pct(order["symbol"], pool)
        equity = await self.current_equity_pool(pool)
        if equity == 0:
            return 0.0
        additional = order.get("size_units", 0) * order.get("limit_price", 0) / equity
        return current_pct + additional
