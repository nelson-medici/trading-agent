"""
Parameter Optimizer: toma un PerformanceReport y genera ajustes
concretos a la configuración del sistema.

Principios:
- Cambios conservadores (máx ±10% por iteración)
- Solo ajusta si hay suficientes datos (>= 10 muestras)
- Prioriza win rate sobre cantidad de trades
- Nunca baja protecciones de riesgo
- Registra cada ajuste con justificación
"""
import structlog
from dataclasses import dataclass
from datetime import datetime, timezone
from .analyzer import PerformanceReport

log = structlog.get_logger()

# Limits: how much each parameter can change per iteration
TUNABLE_PARAMS = {
    # Scalper
    "alert_threshold": {"min": 55, "max": 85, "step": 2, "config_key": "scalper.config"},
    "volume_mult": {"min": 1.0, "max": 2.5, "step": 0.1, "config_key": "scalper.config"},
    "breakout_lookback": {"min": 5, "max": 20, "step": 1, "config_key": "scalper.config"},
    "min_regime_score": {"min": 25, "max": 55, "step": 3, "config_key": "scalper.config"},
    "rsi_oversold": {"min": 20, "max": 35, "step": 2, "config_key": "scalper.config"},
    "target_rr": {"min": 1.5, "max": 3.5, "step": 0.25, "config_key": "scalper.config"},
    # Strategy thresholds
    "candidate": {"min": 65, "max": 85, "step": 2, "config_key": "strategy.thresholds"},
    "watchlist": {"min": 50, "max": 70, "step": 2, "config_key": "strategy.thresholds"},
}


@dataclass
class ParameterAdjustment:
    """A single parameter change recommendation."""
    param: str
    config_key: str
    current_value: float
    new_value: float
    reason: str
    confidence: str  # "high" (>= 20 samples), "medium" (>= 10), "low" (< 10)
    impact: str  # "increase_selectivity", "decrease_selectivity", "risk_adjustment"


async def compute_adjustments(report: PerformanceReport) -> list[ParameterAdjustment]:
    """
    Analyze report and compute parameter adjustments.
    Returns a list of adjustments to apply.
    """
    from src.core.db import get_db
    db = get_db()
    adjustments = []

    if report.evaluated < 10:
        log.info("optimizer_skip", reason="insufficient_data", evaluated=report.evaluated)
        return []

    # Load current config values
    current_config = {}
    try:
        rows = await db.select("config", ["key", "value"])
        for r in (rows or []):
            current_config[r["key"]] = r["value"]
    except Exception as e:
        log.error("optimizer_config_load_failed", error=str(e))
        return []

    # Rule 1: If win rate < 50%, increase selectivity (raise thresholds)
    if report.win_rate < 50 and report.evaluated >= 15:
        scalper_cfg = current_config.get("scalper.config", {})

        # Raise alert threshold
        current_threshold = float(scalper_cfg.get("alert_threshold", 68))
        spec = TUNABLE_PARAMS["alert_threshold"]
        new_val = min(current_threshold + spec["step"], spec["max"])
        if new_val != current_threshold:
            adjustments.append(ParameterAdjustment(
                param="alert_threshold", config_key="scalper.config",
                current_value=current_threshold, new_value=new_val,
                reason=f"Win rate {report.win_rate:.0f}% < 50% — raising selectivity",
                confidence="high" if report.evaluated >= 20 else "medium",
                impact="increase_selectivity",
            ))

        # Raise volume multiplier
        current_vol = float(scalper_cfg.get("volume_mult", 1.2))
        spec = TUNABLE_PARAMS["volume_mult"]
        new_vol = min(current_vol + spec["step"], spec["max"])
        if new_vol != current_vol:
            adjustments.append(ParameterAdjustment(
                param="volume_mult", config_key="scalper.config",
                current_value=current_vol, new_value=new_vol,
                reason=f"Win rate {report.win_rate:.0f}% — requiring stronger volume confirmation",
                confidence="high" if report.evaluated >= 20 else "medium",
                impact="increase_selectivity",
            ))

    # Rule 2: If win rate > 75%, can loosen slightly to get more trades
    if report.win_rate > 75 and report.evaluated >= 20:
        scalper_cfg = current_config.get("scalper.config", {})
        current_threshold = float(scalper_cfg.get("alert_threshold", 68))
        spec = TUNABLE_PARAMS["alert_threshold"]
        new_val = max(current_threshold - spec["step"], spec["min"])
        if new_val != current_threshold:
            adjustments.append(ParameterAdjustment(
                param="alert_threshold", config_key="scalper.config",
                current_value=current_threshold, new_value=new_val,
                reason=f"Win rate {report.win_rate:.0f}% > 75% — can capture more opportunities",
                confidence="high",
                impact="decrease_selectivity",
            ))

    # Rule 3: Adjust based on worst conditions
    for cond_str in report.worst_conditions:
        if "fg=extreme_fear" in cond_str and report.evaluated >= 10:
            scalper_cfg = current_config.get("scalper.config", {})
            current_regime = float(scalper_cfg.get("min_regime_score", 40))
            spec = TUNABLE_PARAMS["min_regime_score"]
            new_val = min(current_regime + spec["step"], spec["max"])
            if new_val != current_regime:
                adjustments.append(ParameterAdjustment(
                    param="min_regime_score", config_key="scalper.config",
                    current_value=current_regime, new_value=new_val,
                    reason=f"Extreme fear conditions have poor win rate — raising regime filter",
                    confidence="medium",
                    impact="increase_selectivity",
                ))
            break

    # Rule 4: RSI oversold level adjustment
    rsi_oversold = report.by_rsi_range.get("oversold")
    if rsi_oversold and rsi_oversold.total >= 5:
        if rsi_oversold.win_rate > 65:
            # RSI oversold bounces work well — keep or widen
            scalper_cfg = current_config.get("scalper.config", {})
            current_rsi = float(scalper_cfg.get("rsi_oversold", 25))
            spec = TUNABLE_PARAMS["rsi_oversold"]
            new_val = min(current_rsi + spec["step"], spec["max"])
            if new_val != current_rsi:
                adjustments.append(ParameterAdjustment(
                    param="rsi_oversold", config_key="scalper.config",
                    current_value=current_rsi, new_value=new_val,
                    reason=f"RSI oversold bounces have {rsi_oversold.win_rate:.0f}% win rate — widening to capture more",
                    confidence="medium" if rsi_oversold.total >= 10 else "low",
                    impact="decrease_selectivity",
                ))

    # Rule 5: Confidence calibration
    for key, stats in report.by_confidence_range.items():
        if stats.total >= 10 and stats.win_rate < 35:
            # This confidence range is unreliable — suggest raising threshold
            strat_thresholds = current_config.get("strategy.thresholds", {})
            current_cand = float(strat_thresholds.get("candidate", 75))
            spec = TUNABLE_PARAMS["candidate"]
            new_val = min(current_cand + spec["step"], spec["max"])
            if new_val != current_cand:
                adjustments.append(ParameterAdjustment(
                    param="candidate", config_key="strategy.thresholds",
                    current_value=current_cand, new_value=new_val,
                    reason=f"Confidence range {key} has {stats.win_rate:.0f}% win rate — calibrating threshold up",
                    confidence="high",
                    impact="increase_selectivity",
                ))
            break

    # Rule 6: If low volume entries lose, raise volume_mult
    low_vol = report.by_volume_range.get("low") or report.by_volume_range.get("very_low")
    if low_vol and low_vol.total >= 5 and low_vol.win_rate < 40:
        scalper_cfg = current_config.get("scalper.config", {})
        current_vol = float(scalper_cfg.get("volume_mult", 1.2))
        spec = TUNABLE_PARAMS["volume_mult"]
        new_val = min(current_vol + spec["step"], spec["max"])
        if new_val != current_vol:
            adjustments.append(ParameterAdjustment(
                param="volume_mult", config_key="scalper.config",
                current_value=current_vol, new_value=new_val,
                reason=f"Low volume entries have {low_vol.win_rate:.0f}% win rate — raising filter",
                confidence="medium",
                impact="increase_selectivity",
            ))

    # Deduplicate by param name (keep first = highest priority)
    seen = set()
    unique = []
    for adj in adjustments:
        if adj.param not in seen:
            seen.add(adj.param)
            unique.append(adj)

    return unique
