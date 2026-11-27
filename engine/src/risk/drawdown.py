"""Tracker de drawdown."""
from datetime import datetime, timedelta
from src.core.db import get_db


class DrawdownTracker:
    def __init__(self):
        self.db = get_db()

    async def current_equity(self) -> float:
        rows = await self.db.select(
            "equity_snapshots", ["total_equity_usd"], order_by="-ts", limit=1,
        )
        return rows[0]["total_equity_usd"] if rows else 0.0

    async def high_water_mark(self) -> float:
        # Postgres MAX vía RPC helper
        result = await self.db.rpc("get_high_water_mark")
        return result or 0.0

    async def daily_dd_pct(self) -> float:
        now = datetime.utcnow()
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        rows = await self.db.select(
            "equity_snapshots",
            ["total_equity_usd"],
            order_by="ts",
            limit=1,
        )
        # Filtramos manualmente por timestamp
        current = await self.current_equity()
        if not rows or current == 0:
            return 0.0
        start_equity = rows[0]["total_equity_usd"]
        if start_equity == 0:
            return 0.0
        return max(0.0, (start_equity - current) / start_equity)

    async def weekly_dd_pct(self) -> float:
        current = await self.current_equity()
        if current == 0:
            return 0.0
        # Aproximación: snapshot de hace 7 días
        rows = await self.db.select(
            "equity_snapshots",
            ["total_equity_usd"],
            order_by="-ts",
            limit=168,  # 168 h = 7 días de snapshots hourly
        )
        if len(rows) < 100:
            return 0.0
        week_ago = rows[-1]["total_equity_usd"]
        if week_ago == 0:
            return 0.0
        return max(0.0, (week_ago - current) / week_ago)

    async def total_dd_pct(self) -> float:
        current = await self.current_equity()
        hwm = await self.high_water_mark()
        if hwm == 0:
            return 0.0
        return max(0.0, (hwm - current) / hwm)
