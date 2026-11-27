"""
Broker simulado.
Registra órdenes internamente, simula fills basado en precio actual.
No conecta a ningún exchange real.
"""
import uuid
from datetime import datetime
from typing import Optional
import structlog
from src.execution.broker_base import BrokerBase

log = structlog.get_logger()


class PaperBroker(BrokerBase):
    def __init__(self, initial_cash_usd: float = 200.0):
        self.cash = initial_cash_usd
        self.holdings: dict[str, float] = {}  # symbol -> units
        self.orders: dict[str, dict] = {}

    async def place_order(
        self,
        *,
        client_order_id: str,
        symbol: str,
        side: str,
        size: float,
        limit_price: Optional[float] = None,
    ) -> dict:
        broker_id = f"paper_{uuid.uuid4().hex[:12]}"
        # Simulación: se llena inmediatamente al limit_price (o mid si no hay)
        fill_price = limit_price or 0
        commission = size * fill_price * 0.001

        if side == "BUY":
            cost = size * fill_price + commission
            if cost > self.cash:
                return {"state": "REJECTED", "reason": "insufficient cash"}
            self.cash -= cost
            self.holdings[symbol] = self.holdings.get(symbol, 0) + size
        else:  # SELL
            if self.holdings.get(symbol, 0) < size:
                return {"state": "REJECTED", "reason": "insufficient holdings"}
            self.holdings[symbol] -= size
            self.cash += size * fill_price - commission

        order = {
            "broker_id": broker_id,
            "client_order_id": client_order_id,
            "state": "FILLED",
            "filled_units": size,
            "avg_fill_price": fill_price,
            "commission": commission,
            "timestamp": datetime.utcnow().isoformat(),
        }
        self.orders[broker_id] = order
        log.info("paper_order_filled", **order)
        return order

    async def get_order_state(self, broker_order_id: str) -> dict:
        return self.orders.get(broker_order_id, {"state": "UNKNOWN"})

    async def cancel_order(self, broker_order_id: str) -> dict:
        if broker_order_id in self.orders:
            self.orders[broker_order_id]["state"] = "CANCELED"
        return self.orders.get(broker_order_id, {})

    async def get_balance(self) -> dict:
        return {
            "cash_usd": self.cash,
            "holdings": self.holdings.copy(),
        }

    async def close(self) -> None:
        pass
