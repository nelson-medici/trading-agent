"""
Risk gate: filtro final con poder de veto.
"""
from dataclasses import dataclass
import structlog

log = structlog.get_logger()


@dataclass
class GateDecision:
    approved: bool
    reasons: list[str]


class RiskGate:
    def __init__(self, kill_switch, dd_tracker, portfolio, risk_limits, dd_limits):
        self.kill = kill_switch
        self.dd = dd_tracker
        self.portfolio = portfolio
        self.risk_limits = risk_limits
        self.dd_limits = dd_limits

    async def evaluate(self, order: dict) -> GateDecision:
        if await self.kill.is_active():
            return GateDecision(False, ["kill switch active"])

        total_dd = await self.dd.total_dd_pct()
        if total_dd >= self.dd_limits["total_kill_pct"]:
            await self.kill.activate(f"total DD breached: {total_dd:.2%}")
            return GateDecision(False, ["total DD breached, kill activated"])

        weekly_dd = await self.dd.weekly_dd_pct()
        if weekly_dd >= self.dd_limits["weekly_conservative_pct"]:
            if order.get("side") == "BUY":
                return GateDecision(False, ["weekly DD conservative mode"])

        daily_dd = await self.dd.daily_dd_pct()
        if daily_dd >= self.dd_limits["daily_pause_pct"]:
            return GateDecision(False, ["daily DD pause"])

        if not order.get("stop_price"):
            return GateDecision(False, ["no stop defined"])

        if order.get("size_units", 0) <= 0:
            return GateDecision(False, ["invalid size"])

        symbol = order["symbol"]
        if await self.portfolio.has_pending_order(symbol):
            return GateDecision(False, ["pending order exists"])

        # Cap por activo
        new_exposure = await self.portfolio.simulated_exposure_pct(order)
        cap = (
            self.risk_limits["max_position_btc_eth_pct"]
            if symbol in ("BTC/USDT", "ETH/USDT")
            else self.risk_limits["max_position_pct"]
        )
        if new_exposure > cap:
            return GateDecision(False, [f"exposure {new_exposure:.2%} > cap {cap:.2%}"])

        # Max posiciones simultáneas
        open_count = await self.portfolio.open_positions_count()
        if open_count >= self.risk_limits["max_open_positions"]:
            return GateDecision(False, [f"max open positions {open_count} reached"])

        log.info("risk_gate_approved", symbol=symbol)
        return GateDecision(True, ["all checks passed"])
