"""
Ejecución unificada de decisiones — funciona en paper, testnet y live.

Flujo:
  1. Obtiene el broker del factory
  2. Envía la orden al broker (paper simula, testnet/live van a Binance)
  3. Registra la orden, posición y actualiza la decisión en la DB
  4. En live: agrega guards adicionales (confirmación de fill, reconciliación)
"""
import uuid
from datetime import datetime, timezone
import structlog
from src.core.db import get_db
from src.execution.factory import get_broker, is_live, is_paper, current_mode

log = structlog.get_logger()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def execute_decision(decision: dict, pool_name: str, db_config: dict | None = None) -> dict | None:
    """
    Ejecuta una decisión de trading (BUY).
    Funciona con cualquier broker (paper, testnet, live).

    Returns:
        dict con la orden ejecutada, o None si falló.
    """
    db = get_db()
    broker = await get_broker(db_config)
    mode = current_mode()

    symbol = decision["symbol"]
    size = decision["size_units"]
    price = decision["entry_price"]
    notional = decision["notional_usd"]

    log.info("executing_decision",
             mode=mode, pool=pool_name, symbol=symbol,
             size=size, price=price, notional=notional)

    try:
        # En live: verificar que el kill switch no está activo
        if is_live():
            kill = await db.select("kill_switch", filters={"id": 1})
            if kill and kill[0].get("active"):
                log.warning("execution_blocked_kill_switch", symbol=symbol)
                await db.update("decisions",
                    {"status": "blocked", "executed_at": _utc_now_iso()},
                    {"id": decision["id"]})
                return None

        # Enviar orden al broker
        order_id = str(uuid.uuid4())

        if is_paper():
            # Paper: fill instantáneo simulado
            commission = notional * 0.001
            fill_result = {
                "broker_id": f"paper_{uuid.uuid4().hex[:12]}",
                "state": "FILLED",
                "filled_units": size,
                "avg_fill_price": price,
                "commission": commission,
            }
        else:
            # Testnet o live: orden real via CCXT
            fill_result = await broker.place_order(
                client_order_id=order_id,
                symbol=symbol,
                side="BUY",
                size=size,
                limit_price=price,
            )

            if fill_result.get("state") not in ("FILLED", "SUBMITTED"):
                log.error("order_not_filled",
                          mode=mode, symbol=symbol,
                          state=fill_result.get("state"),
                          error=fill_result.get("error"))
                await db.update("decisions",
                    {"status": "failed", "executed_at": _utc_now_iso()},
                    {"id": decision["id"]})
                return None

            commission = fill_result.get("commission", notional * 0.001)
            # Si es limit order en live, puede quedar SUBMITTED → reconciliar después
            if fill_result.get("state") == "SUBMITTED":
                log.info("order_pending_fill", mode=mode, symbol=symbol, broker_id=fill_result.get("broker_id"))

        # Registrar orden
        order = {
            "id": order_id,
            "decision_id": decision["id"],
            "symbol": symbol,
            "side": "BUY",
            "size_units": fill_result.get("filled_units", size),
            "limit_price": price,
            "stop_price": decision["stop_price"],
            "target_price": decision["target_price"],
            "state": fill_result.get("state", "FILLED"),
            "broker_order_id": fill_result.get("broker_id"),
            "filled_units": fill_result.get("filled_units", size),
            "avg_fill_price": fill_result.get("avg_fill_price", price),
            "commission_paid": commission,
            "pool": pool_name,
            "submitted_at": _utc_now_iso(),
            "filled_at": _utc_now_iso() if fill_result.get("state") == "FILLED" else None,
        }
        await db.insert("orders", order)

        # Registrar posición (solo si filled)
        actual_price = fill_result.get("avg_fill_price", price)
        if fill_result.get("state") == "FILLED":
            await db.insert("positions", {
                "symbol": symbol,
                "side": "LONG",
                "size_units": fill_result.get("filled_units", size),
                "entry_price": actual_price,
                "current_price": actual_price,
                "stop_price": decision["stop_price"],
                "target_price": decision["target_price"],
                "unrealized_pnl_usd": 0.0,
                "unrealized_pnl_pct": 0.0,
                "score_at_entry": decision.get("score", 0),
                "current_score": decision.get("score", 0),
                "pool": pool_name,
            })

        # Actualizar decisión
        await db.update("decisions",
            {"status": "executed", "executed_at": _utc_now_iso()},
            {"id": decision["id"]})

        log.info("decision_executed",
                 mode=mode, pool=pool_name, symbol=symbol,
                 size=fill_result.get("filled_units", size),
                 price=actual_price,
                 commission=commission)
        return order

    except Exception as e:
        log.error("execution_failed",
                  mode=mode, pool=pool_name, symbol=symbol,
                  error=str(e), exc_info=True)
        try:
            await db.update("decisions",
                {"status": "failed", "executed_at": _utc_now_iso()},
                {"id": decision["id"]})
        except Exception:
            pass
        return None


async def execute_sell(position: dict, exit_price: float, exit_reason: str,
                       pool_name: str, db_config: dict | None = None) -> dict | None:
    """
    Ejecuta una venta (cierre de posición).
    Funciona con cualquier broker.
    """
    db = get_db()
    broker = await get_broker(db_config)
    mode = current_mode()

    symbol = position["symbol"]
    size = float(position["size_units"])

    try:
        if is_paper():
            commission = size * exit_price * 0.001
            fill_result = {
                "broker_id": f"paper_{uuid.uuid4().hex[:12]}",
                "state": "FILLED",
                "filled_units": size,
                "avg_fill_price": exit_price,
                "commission": commission,
            }
        else:
            fill_result = await broker.place_order(
                client_order_id=str(uuid.uuid4()),
                symbol=symbol,
                side="SELL",
                size=size,
            )
            if fill_result.get("state") not in ("FILLED", "SUBMITTED"):
                log.error("sell_not_filled", mode=mode, symbol=symbol,
                          state=fill_result.get("state"))
                return None
            commission = fill_result.get("commission", size * exit_price * 0.001)
            exit_price = fill_result.get("avg_fill_price", exit_price)

        log.info("sell_executed", mode=mode, pool=pool_name, symbol=symbol,
                 price=exit_price, reason=exit_reason)
        return fill_result

    except Exception as e:
        log.error("sell_failed", mode=mode, symbol=symbol, error=str(e), exc_info=True)
        return None
