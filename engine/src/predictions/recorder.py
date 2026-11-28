"""
Prediction Recorder: registra predicciones del sistema para evaluación posterior.

Se llama desde:
- compute_features_and_score (cada hora, por cada símbolo scored)
- auto_analyzer (al crear triggers)
- scalper detector (al detectar oportunidades)
"""
import structlog
from datetime import datetime, timezone

log = structlog.get_logger()


async def record_prediction(
    db,
    symbol: str,
    bias: str,              # 'bullish', 'bearish', 'neutral'
    confidence: float,      # score 0-100
    price: float,
    source: str,            # 'scoring', 'pattern_trigger', 'auto_analyzer', 'scalper'
    source_id: str | None = None,
    pool: str | None = None,
    expected_target: float | None = None,
    expected_stop: float | None = None,
    eval_window_hours: float = 4,
    context: dict | None = None,
    notes: str | None = None,
) -> str | None:
    """
    Register a prediction. Returns the prediction ID or None on failure.

    Only records predictions with actionable bias (bullish/bearish with confidence >= 55).
    Deduplicates: won't create another prediction for the same symbol+source
    if one was created in the last eval_window_hours.
    """
    if bias == "neutral" or confidence < 55:
        return None

    # Dedup: check if we already have a pending prediction for this symbol+source
    try:
        existing = await db.select(
            "predictions",
            ["id", "predicted_at"],
            {"symbol": symbol, "source": source, "status": "pending"},
            order_by="-predicted_at",
            limit=1,
        )
        if existing:
            last = existing[0]
            from datetime import timedelta
            import pandas as pd
            last_time = pd.to_datetime(last["predicted_at"], utc=True).to_pydatetime()
            now = datetime.now(timezone.utc)
            if (now - last_time).total_seconds() / 3600 < eval_window_hours:
                return None  # already have a recent prediction
    except Exception:
        pass

    # Calculate expected move
    expected_move_pct = None
    if expected_target and price > 0:
        expected_move_pct = ((expected_target - price) / price) * 100

    row = {
        "symbol": symbol,
        "pool": pool,
        "source": source,
        "source_id": source_id,
        "bias": bias,
        "confidence": confidence,
        "price_at_prediction": price,
        "expected_target": expected_target,
        "expected_stop": expected_stop,
        "expected_move_pct": expected_move_pct,
        "eval_window_hours": eval_window_hours,
        "context": context or {},
        "notes": notes,
    }

    try:
        result = await db.insert("predictions", row)
        pred_id = result.get("id") if isinstance(result, dict) else None
        log.info("prediction_recorded", symbol=symbol, bias=bias, confidence=confidence,
                 source=source, price=price)
        return pred_id
    except Exception as e:
        log.error("prediction_record_failed", error=str(e), symbol=symbol)
        return None
