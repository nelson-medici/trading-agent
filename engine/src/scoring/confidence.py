"""
Validación de alta convicción (>=85 score).
Las 9 condiciones deben cumplirse simultáneamente.
"""
from dataclasses import dataclass, field
from typing import Literal
import structlog

log = structlog.get_logger()


@dataclass
class ConfidenceCheck:
    passes: bool
    score_threshold: float
    checks: dict[str, bool] = field(default_factory=dict)
    failed_reasons: list[str] = field(default_factory=list)


def evaluate_high_confidence(
    *,
    score_total: float,
    score_technical: float,
    indicators_aligned: int,
    price_above_sma200: bool,
    volume_ratio: float,
    market_regime: Literal["risk_on", "risk_off", "neutral"],
    has_event_in_48h: bool,
    risk_reward_ratio: float,
    score_history: list[float],
    bid_ask_spread_pct: float,
    required_signals: int = 3,
    sustained_periods: int = 2,
) -> ConfidenceCheck:
    """
    Las 9 condiciones:

    1. score_total >= 85
    2. score_technical >= 80 con N+ indicadores alineados
    3. Tendencia mayor a favor (precio > SMA200 para longs)
    4. Volumen confirma (> 1.5x SMA20)
    5. Régimen de mercado favorable
    6. Sin eventos en 48h
    7. Risk/reward >= 2.0
    8. Score sostenido >= 75 en N periodos
    9. Liquidez OK (spread < 0.2%)
    """
    checks: dict[str, bool] = {}
    failed: list[str] = []

    checks["score_85"] = score_total >= 85
    if not checks["score_85"]:
        failed.append(f"score_total={score_total:.1f} < 85")

    checks["technical_strong"] = (
        score_technical >= 80 and indicators_aligned >= required_signals
    )
    if not checks["technical_strong"]:
        failed.append(
            f"technical={score_technical:.1f} or aligned={indicators_aligned} < {required_signals}"
        )

    checks["trend_aligned"] = price_above_sma200
    if not checks["trend_aligned"]:
        failed.append("price not above SMA200")

    checks["volume_confirms"] = volume_ratio > 1.5
    if not checks["volume_confirms"]:
        failed.append(f"volume_ratio={volume_ratio:.2f} <= 1.5")

    checks["regime_ok"] = market_regime == "risk_on"
    if not checks["regime_ok"]:
        failed.append(f"regime={market_regime}")

    checks["no_event_soon"] = not has_event_in_48h
    if not checks["no_event_soon"]:
        failed.append("event in <48h")

    checks["rr_ok"] = risk_reward_ratio >= 2.0
    if not checks["rr_ok"]:
        failed.append(f"rr={risk_reward_ratio:.2f} < 2.0")

    sustained = (
        len(score_history) >= sustained_periods
        and all(s >= 75 for s in score_history[-sustained_periods:])
    )
    checks["sustained"] = sustained
    if not sustained:
        failed.append(f"score not sustained >=75 over last {sustained_periods}")

    checks["liquidity_ok"] = bid_ask_spread_pct < 0.002
    if not checks["liquidity_ok"]:
        failed.append(f"spread={bid_ask_spread_pct:.4f} >= 0.002")

    passes = all(checks.values())

    log.info(
        "confidence_check",
        passes=passes,
        checks=checks,
        failed_reasons=failed,
    )

    return ConfidenceCheck(
        passes=passes,
        score_threshold=85.0 if passes else 75.0,
        checks=checks,
        failed_reasons=failed,
    )
