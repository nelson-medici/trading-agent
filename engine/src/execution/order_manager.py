"""
Order manager con idempotencia.
Cada orden tiene UUID local; se persiste antes de submit.
"""
import uuid
from datetime import datetime
from enum import Enum
import structlog
from src.core.db import get_db

log = structlog.get_logger()


class OrderState(str, Enum):
    DRAFTED = "DRAFTED"
    SUBMITTED = "SUBMITTED"
    PARTIAL = "PARTIAL"
    FILLED = "FILLED"
    REJECTED = "REJECTED"
    CANCELED = "CANCELED"
    FAILED = "FAILED"


class OrderManager:
    def __init__(self, broker):
        self.db = get_db()
        self.broker = broker

    async def create_order(self, decision: dict) -> dict:
        order_id = str(uuid.uuid4())
        order = {
            "id": order_id,
            "decision_id": decision["id"],
            "symbol": decision["symbol"],
            "side": "BUY" if decision["action"] == "BUY" else "SELL",
            "size_units": decision["size_units"],
            "limit_price": decision.get("entry_price"),
            "stop_price": decision["stop_price"],
            "target_price": decision["target_price"],
            "state": OrderState.DRAFTED.value,
            "created_at": datetime.utcnow().isoformat(),
        }
        await self.db.insert("orders", order)
        log.info("order_drafted", order_id=order_id, symbol=order["symbol"])
        return order

    async def submit(self, order: dict) -> dict:
        await self.db.update(
            "orders",
            {"state": OrderState.SUBMITTED.value,
             "submitted_at": datetime.utcnow().isoformat()},
            {"id": order["id"]},
        )
        try:
            resp = await self.broker.place_order(
                client_order_id=order["id"],
                symbol=order["symbol"],
                side=order["side"],
                size=order["size_units"],
                limit_price=order["limit_price"],
            )
            await self.db.update(
                "orders",
                {
                    "broker_order_id": resp.get("broker_id"),
                    "state": resp.get("state", OrderState.SUBMITTED.value),
                    "filled_units": resp.get("filled_units", 0),
                    "avg_fill_price": resp.get("avg_fill_price"),
                    "commission_paid": resp.get("commission", 0),
                    "filled_at": datetime.utcnow().isoformat() if resp.get("state") == "FILLED" else None,
                },
                {"id": order["id"]},
            )
            log.info("order_submitted", order_id=order["id"], resp=resp)
            return resp
        except Exception as e:
            await self.db.update(
                "orders",
                {"state": OrderState.FAILED.value, "error_message": str(e)},
                {"id": order["id"]},
            )
            log.error("order_submit_failed", order_id=order["id"], error=str(e))
            raise

    async def reconcile(self) -> int:
        pending = await self.db.select(
            "orders",
            filters=None,
        )
        # Filtro manual porque select simple no soporta IN
        pending = [
            o for o in pending
            if o["state"] in (OrderState.SUBMITTED.value, OrderState.PARTIAL.value)
        ]
        reconciled = 0
        for order in pending:
            if not order.get("broker_order_id"):
                continue
            broker_state = await self.broker.get_order_state(order["broker_order_id"])
            if broker_state["state"] != order["state"]:
                await self.db.update(
                    "orders",
                    {
                        "state": broker_state["state"],
                        "filled_units": broker_state.get("filled_units", 0),
                        "avg_fill_price": broker_state.get("avg_fill_price"),
                    },
                    {"id": order["id"]},
                )
                reconciled += 1
                log.info(
                    "order_reconciled",
                    order_id=order["id"],
                    old=order["state"],
                    new=broker_state["state"],
                )
        return reconciled
