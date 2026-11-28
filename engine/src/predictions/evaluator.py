"""
Prediction Evaluator: revisa predicciones pendientes cuya ventana de evaluación
venció y registra qué pasó realmente.

Corre cada 15 min como job del scheduler.
"""
import structlog
import pandas as pd
from datetime import datetime, timezone

log = structlog.get_logger()


async def evaluate_predictions() -> int:
    """
    Evalúa predicciones pendientes cuya ventana expiró.
    Returns: number of predictions evaluated.
    """
    from src.core.db import get_db
    db = get_db()
    now = datetime.now(timezone.utc)

    # Get pending predictions whose eval window has passed
    try:
        pending = await db.select(
            "predictions",
            ["*"],
            {"status": "pending"},
            order_by="predicted_at",
            limit=50,
        )
    except Exception as e:
        log.error("prediction_eval_fetch_failed", error=str(e))
        return 0

    if not pending:
        return 0

    evaluated = 0
    for pred in pending:
        predicted_at = pd.to_datetime(pred["predicted_at"], utc=True).to_pydatetime()
        window_hours = float(pred.get("eval_window_hours", 4))

        # Check if eval window has passed
        elapsed_hours = (now - predicted_at).total_seconds() / 3600
        if elapsed_hours < window_hours:
            continue

        symbol = pred["symbol"]
        price_at_pred = float(pred["price_at_prediction"])
        bias = pred["bias"]

        # Get price data for the evaluation window
        try:
            candles = await db.select(
                "ohlcv",
                ["ts", "high", "low", "close"],
                {"symbol": symbol, "timeframe": "1h"},
                order_by="-ts",
                limit=int(window_hours * 2) + 5,  # extra buffer
            )
        except Exception as e:
            log.error("prediction_eval_candles_failed", error=str(e), symbol=symbol)
            continue

        if not candles:
            # No data — mark as expired
            await _update_prediction(db, pred["id"], {
                "status": "expired",
                "eval_at": now.isoformat(),
                "notes": (pred.get("notes") or "") + " | sin datos OHLCV para evaluar",
            })
            evaluated += 1
            continue

        # Filter candles within the evaluation window
        window_candles = []
        for c in candles:
            c_time = pd.to_datetime(c["ts"], utc=True).to_pydatetime()
            if c_time >= predicted_at and c_time <= predicted_at + pd.Timedelta(hours=window_hours):
                window_candles.append(c)

        if not window_candles:
            await _update_prediction(db, pred["id"], {
                "status": "expired",
                "eval_at": now.isoformat(),
                "notes": (pred.get("notes") or "") + " | sin velas en la ventana de evaluación",
            })
            evaluated += 1
            continue

        # Calculate actual results
        high_after = max(float(c["high"]) for c in window_candles)
        low_after = min(float(c["low"]) for c in window_candles)
        last_close = float(window_candles[0]["close"])  # most recent (ordered desc)
        actual_move_pct = ((last_close - price_at_pred) / price_at_pred) * 100

        # Check if target/stop were hit
        expected_target = float(pred["expected_target"]) if pred.get("expected_target") else None
        expected_stop = float(pred["expected_stop"]) if pred.get("expected_stop") else None

        hit_target = expected_target is not None and high_after >= expected_target if bias == "bullish" else (
            expected_target is not None and low_after <= expected_target if bias == "bearish" else False
        )
        hit_stop = expected_stop is not None and low_after <= expected_stop if bias == "bullish" else (
            expected_stop is not None and high_after >= expected_stop if bias == "bearish" else False
        )

        # Find when target/stop were hit
        target_hit_at = None
        stop_hit_at = None
        for c in sorted(window_candles, key=lambda x: x["ts"]):
            c_time = pd.to_datetime(c["ts"], utc=True).to_pydatetime()
            if hit_target and target_hit_at is None:
                if bias == "bullish" and float(c["high"]) >= expected_target:
                    target_hit_at = c_time
                elif bias == "bearish" and float(c["low"]) <= expected_target:
                    target_hit_at = c_time
            if hit_stop and stop_hit_at is None:
                if bias == "bullish" and float(c["low"]) <= expected_stop:
                    stop_hit_at = c_time
                elif bias == "bearish" and float(c["high"]) >= expected_stop:
                    stop_hit_at = c_time

        # Determine outcome
        if hit_target and not hit_stop:
            status = "correct"
        elif hit_stop and not hit_target:
            status = "wrong"
        elif hit_target and hit_stop:
            # Both hit — which came first?
            if target_hit_at and stop_hit_at:
                status = "correct" if target_hit_at < stop_hit_at else "wrong"
            else:
                status = "partial"
        else:
            # Neither hit — judge by direction
            if bias == "bullish":
                status = "correct" if actual_move_pct > 0.5 else ("wrong" if actual_move_pct < -0.5 else "partial")
            elif bias == "bearish":
                status = "correct" if actual_move_pct < -0.5 else ("wrong" if actual_move_pct > 0.5 else "partial")
            else:
                status = "partial"

        update = {
            "status": status,
            "eval_at": now.isoformat(),
            "price_at_eval": last_close,
            "actual_move_pct": actual_move_pct,
            "high_after": high_after,
            "low_after": low_after,
            "hit_target": hit_target,
            "hit_stop": hit_stop,
            "target_hit_at": target_hit_at.isoformat() if target_hit_at else None,
            "stop_hit_at": stop_hit_at.isoformat() if stop_hit_at else None,
        }
        await _update_prediction(db, pred["id"], update)
        evaluated += 1
        log.info("prediction_evaluated", symbol=symbol, bias=bias,
                 confidence=pred.get("confidence"), status=status,
                 actual_move_pct=round(actual_move_pct, 2))

    if evaluated:
        log.info("predictions_evaluated", count=evaluated)
    return evaluated


async def _update_prediction(db, pred_id: str, data: dict) -> None:
    try:
        await db.update("predictions", data, {"id": pred_id})
    except Exception as e:
        log.error("prediction_update_failed", error=str(e), id=pred_id)
