"""
Auto-Tuner: ejecuta el ciclo completo de aprendizaje.

Corre cada 6 horas:
1. Analiza performance de las últimas 72h
2. Calcula ajustes recomendados
3. Aplica los de alta confianza automáticamente
4. Registra todo en un audit log para transparencia

Principios:
- Solo aplica ajustes con confidence "high" (>= 20 muestras)
- Cambios "medium" se registran como sugerencia pero no se aplican solos
- Nunca toca parámetros de riesgo (stops, drawdown limits)
- Cada ajuste se guarda con justificación para review humano
- Max 3 ajustes por iteración para evitar sobre-optimización
"""
import structlog
from datetime import datetime, timezone

from .analyzer import analyze_performance
from .optimizer import compute_adjustments, ParameterAdjustment
from .market_intelligence import learn_from_outcomes

log = structlog.get_logger()

MAX_AUTO_ADJUSTMENTS = 3  # max changes per run


async def run_auto_tuner() -> dict:
    """
    Ciclo completo: analizar → optimizar → aplicar → registrar.
    Returns summary dict.
    """
    from src.core.db import get_db
    db = get_db()
    now = datetime.now(timezone.utc)

    summary = {
        "ran_at": now.isoformat(),
        "analyzed": False,
        "adjustments_computed": 0,
        "adjustments_applied": 0,
        "adjustments_suggested": 0,
    }

    # 0. Market Intelligence: learn patterns and rules from outcomes
    try:
        mi_result = await learn_from_outcomes()
        summary["intelligence"] = mi_result
        log.info("market_intelligence_done",
                 rules=mi_result.get("rules_generated", 0),
                 flags=mi_result.get("flags_set", 0),
                 stuck=mi_result.get("stuck_reports", 0))
    except Exception as e:
        log.error("market_intelligence_failed", error=str(e))

    # 1. Analyze
    try:
        report = await analyze_performance(period_hours=72)
        summary["analyzed"] = True
        summary["predictions_evaluated"] = report.evaluated
        summary["win_rate"] = round(report.win_rate, 1)
        summary["trade_win_rate"] = round(report.trade_win_rate, 1)
        summary["best_conditions"] = report.best_conditions[:3]
        summary["worst_conditions"] = report.worst_conditions[:3]
        summary["recommendations"] = report.recommendations[:3]
    except Exception as e:
        log.error("auto_tuner_analyze_failed", error=str(e))
        return summary

    if report.evaluated < 10:
        log.info("auto_tuner_skip", reason="insufficient_data", evaluated=report.evaluated)
        summary["skip_reason"] = "insufficient_data"
        return summary

    # 2. Compute adjustments
    try:
        adjustments = await compute_adjustments(report)
        summary["adjustments_computed"] = len(adjustments)
    except Exception as e:
        log.error("auto_tuner_optimize_failed", error=str(e))
        return summary

    if not adjustments:
        log.info("auto_tuner_no_changes", win_rate=report.win_rate)
        return summary

    # 3. Apply high-confidence adjustments, suggest medium ones
    applied = []
    suggested = []

    for adj in adjustments:
        if adj.confidence == "high" and len(applied) < MAX_AUTO_ADJUSTMENTS:
            # Auto-apply
            success = await _apply_adjustment(db, adj)
            if success:
                applied.append(adj)
                log.info("auto_tuner_applied",
                         param=adj.param, old=adj.current_value, new=adj.new_value,
                         reason=adj.reason)
        else:
            suggested.append(adj)
            log.info("auto_tuner_suggested",
                     param=adj.param, old=adj.current_value, new=adj.new_value,
                     reason=adj.reason, confidence=adj.confidence)

    summary["adjustments_applied"] = len(applied)
    summary["adjustments_suggested"] = len(suggested)

    # 4. Register in audit log
    await _save_tuning_report(db, report, applied, suggested, now)

    # 5. Create alert if changes were made
    if applied:
        changes_text = " · ".join(
            f"{a.param}: {a.current_value}→{a.new_value}" for a in applied
        )
        await db.insert("alerts", {
            "level": "info",
            "category": "learning",
            "title": f"[auto-tuner] {len(applied)} parámetro{'s' if len(applied) > 1 else ''} ajustado{'s' if len(applied) > 1 else ''}",
            "message": f"Win rate: {report.win_rate:.0f}% ({report.evaluated} predicciones) · {changes_text}",
            "metadata": {
                "adjustments": [
                    {"param": a.param, "old": a.current_value, "new": a.new_value, "reason": a.reason}
                    for a in applied
                ],
                "win_rate": report.win_rate,
                "evaluated": report.evaluated,
            },
        })

    if suggested:
        suggestions_text = " · ".join(
            f"{a.param}: {a.current_value}→{a.new_value} ({a.confidence})" for a in suggested
        )
        await db.insert("alerts", {
            "level": "info",
            "category": "learning",
            "title": f"[auto-tuner] {len(suggested)} sugerencia{'s' if len(suggested) > 1 else ''} pendiente{'s' if len(suggested) > 1 else ''}",
            "message": f"Requieren más datos para aplicar automáticamente: {suggestions_text}",
            "metadata": {
                "suggestions": [
                    {"param": a.param, "old": a.current_value, "new": a.new_value,
                     "reason": a.reason, "confidence": a.confidence}
                    for a in suggested
                ],
            },
        })

    return summary


async def _apply_adjustment(db, adj: ParameterAdjustment) -> bool:
    """Apply a single parameter adjustment to the config."""
    try:
        rows = await db.select("config", ["value"], {"key": adj.config_key})
        if not rows:
            return False

        config = rows[0]["value"]
        if isinstance(config, dict):
            config[adj.param] = adj.new_value
            await db.update("config", {"value": config}, {"key": adj.config_key})
            return True
        return False
    except Exception as e:
        log.error("auto_tuner_apply_failed", param=adj.param, error=str(e))
        return False


async def _save_tuning_report(db, report, applied, suggested, now) -> None:
    """Save the tuning run as a prediction for auditing."""
    try:
        await db.insert("predictions", {
            "symbol": "_SYSTEM_",
            "source": "auto_tuner",
            "bias": "neutral",
            "confidence": report.win_rate,
            "price_at_prediction": 0,
            "eval_window_hours": 0,
            "status": "correct" if applied else "partial",
            "predicted_at": now.isoformat(),
            "eval_at": now.isoformat(),
            "context": {
                "type": "tuning_report",
                "win_rate": report.win_rate,
                "evaluated": report.evaluated,
                "total_trades": report.total_trades,
                "trade_win_rate": report.trade_win_rate,
                "profit_factor": report.profit_factor,
                "applied": [
                    {"param": a.param, "old": a.current_value, "new": a.new_value, "reason": a.reason}
                    for a in applied
                ],
                "suggested": [
                    {"param": a.param, "old": a.current_value, "new": a.new_value, "reason": a.reason}
                    for a in suggested
                ],
                "best_conditions": report.best_conditions,
                "worst_conditions": report.worst_conditions,
                "recommendations": report.recommendations,
            },
            "notes": f"Auto-tuner run: {len(applied)} applied, {len(suggested)} suggested",
        })
    except Exception as e:
        log.error("auto_tuner_save_report_failed", error=str(e))
