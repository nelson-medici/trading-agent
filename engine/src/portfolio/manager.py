"""Portfolio state manager."""
from src.core.db import get_db


class PortfolioManager:
    def __init__(self):
        self.db = get_db()

    async def get_positions(self) -> list[dict]:
        return await self.db.select("positions")

    async def get_position(self, symbol: str) -> dict | None:
        rows = await self.db.select("positions", filters={"symbol": symbol})
        return rows[0] if rows else None

    async def open_positions_count(self) -> int:
        return len(await self.get_positions())

    async def has_open_position(self, symbol: str) -> bool:
        return (await self.get_position(symbol)) is not None

    async def has_pending_order(self, symbol: str) -> bool:
        orders = await self.db.select(
            "orders", filters={"symbol": symbol, "state": "SUBMITTED"},
        )
        return len(orders) > 0

    async def current_equity(self) -> float:
        rows = await self.db.select(
            "equity_snapshots", ["total_equity_usd"],
            order_by="-ts", limit=1,
        )
        return rows[0]["total_equity_usd"] if rows else 200.0  # default inicial

    async def current_position_pct(self, symbol: str) -> float:
        pos = await self.get_position(symbol)
        equity = await self.current_equity()
        if not pos or equity == 0:
            return 0.0
        return (pos["size_units"] * (pos.get("current_price") or pos["entry_price"])) / equity

    async def simulated_exposure_pct(self, order: dict) -> float:
        current_pct = await self.current_position_pct(order["symbol"])
        equity = await self.current_equity()
        if equity == 0:
            return 0.0
        additional = order.get("size_units", 0) * order.get("limit_price", 0) / equity
        return current_pct + additional
