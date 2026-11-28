"""
Performance Analyzer: analiza resultados históricos para identificar
qué condiciones producen wins y cuáles producen losses.

Genera un PerformanceReport con:
- Win rate global y por fuente (scoring, scalper, pattern)
- Win rate segmentado por condición (RSI range, ADX range, F&G range, régimen, etc.)
- Mejores y peores condiciones
- Confidence calibration: accuracy real vs confidence reportada
"""
import structlog
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

log = structlog.get_logger()


@dataclass
class ConditionStats:
    """Stats para una condición específica (ej: RSI 20-30)."""
    label: str
    total: int = 0
    correct: int = 0
    wrong: int = 0
    partial: int = 0
    avg_confidence: float = 0
    avg_actual_move: float = 0

    @property
    def win_rate(self) -> float:
        return self.correct / self.total * 100 if self.total > 0 else 0

    @property
    def sample_quality(self) -> str:
        if self.total >= 30: return "high"
        if self.total >= 10: return "medium"
        return "low"


@dataclass
class PerformanceReport:
    """Reporte completo de performance del sistema."""
    period_hours: int
    total_predictions: int = 0
    evaluated: int = 0
    win_rate: float = 0
    avg_confidence: float = 0

    # Segmented stats
    by_source: dict[str, ConditionStats] = field(default_factory=dict)
    by_rsi_range: dict[str, ConditionStats] = field(default_factory=dict)
    by_adx_range: dict[str, ConditionStats] = field(default_factory=dict)
    by_fg_range: dict[str, ConditionStats] = field(default_factory=dict)
    by_regime: dict[str, ConditionStats] = field(default_factory=dict)
    by_volume_range: dict[str, ConditionStats] = field(default_factory=dict)
    by_confidence_range: dict[str, ConditionStats] = field(default_factory=dict)

    # Actionable insights
    best_conditions: list[str] = field(default_factory=list)   # conditions with >70% win rate
    worst_conditions: list[str] = field(default_factory=list)  # conditions with <40% win rate
    recommendations: list[str] = field(default_factory=list)   # parameter change suggestions

    # Trade-level stats (from actual trades, not just predictions)
    total_trades: int = 0
    trade_win_rate: float = 0
    avg_win_usd: float = 0
    avg_loss_usd: float = 0
    profit_factor: float = 0

    generated_at: str = ""


def _bucket_rsi(rsi: float | None) -> str:
    if rsi is None: return "unknown"
    if rsi < 20: return "oversold_extreme"
    if rsi < 30: return "oversold"
    if rsi < 45: return "weak"
    if rsi < 55: return "neutral"
    if rsi < 70: return "strong"
    if rsi < 80: return "overbought"
    return "overbought_extreme"


def _bucket_adx(adx: float | None) -> str:
    if adx is None: return "unknown"
    if adx < 15: return "no_trend"
    if adx < 25: return "weak_trend"
    if adx < 35: return "trend"
    if adx < 50: return "strong_trend"
    return "extreme_trend"


def _bucket_fg(fg: float | None) -> str:
    if fg is None: return "unknown"
    if fg < 15: return "extreme_fear"
    if fg < 30: return "fear"
    if fg < 50: return "neutral"
    if fg < 70: return "greed"
    return "extreme_greed"


def _bucket_volume(vol: float | None) -> str:
    if vol is None: return "unknown"
    if vol < 0.5: return "very_low"
    if vol < 1.0: return "low"
    if vol < 1.5: return "normal"
    if vol < 2.5: return "high"
    return "very_high"


def _bucket_confidence(conf: float | None) -> str:
    if conf is None: return "unknown"
    if conf < 60: return "low_55-60"
    if conf < 65: return "mid_60-65"
    if conf < 70: return "mid_65-70"
    if conf < 75: return "high_70-75"
    if conf < 80: return "high_75-80"
    return "very_high_80+"


def _add_to_bucket(buckets: dict[str, ConditionStats], key: str, pred: dict) -> None:
    if key not in buckets:
        buckets[key] = ConditionStats(label=key)
    b = buckets[key]
    b.total += 1
    status = pred["status"]
    if status == "correct":
        b.correct += 1
    elif status == "wrong":
        b.wrong += 1
    elif status == "partial":
        b.partial += 1
    b.avg_confidence = (b.avg_confidence * (b.total - 1) + float(pred.get("confidence") or 0)) / b.total
    if pred.get("actual_move_pct") is not None:
        b.avg_actual_move = (b.avg_actual_move * (b.total - 1) + float(pred["actual_move_pct"])) / b.total


async def analyze_performance(period_hours: int = 168) -> PerformanceReport:
    """
    Analiza la performance del sistema en las últimas N horas (default 7 días).
    """
    from src.core.db import get_db
    db = get_db()
    now = datetime.now(timezone.utc)
    since = (now - timedelta(hours=period_hours)).isoformat()

    report = PerformanceReport(period_hours=period_hours, generated_at=now.isoformat())

    # 1. Load evaluated predictions
    try:
        all_preds = await db.select(
            "predictions", ["*"],
            filters={},  # can't filter by date range easily, so get all and filter
            order_by="-predicted_at",
            limit=1000,
        )
        # Filter by period
        preds = [p for p in (all_preds or []) if p.get("predicted_at", "") >= since]
        evaluated = [p for p in preds if p["status"] not in ("pending",)]
    except Exception as e:
        log.error("perf_analyze_predictions_failed", error=str(e))
        preds, evaluated = [], []

    report.total_predictions = len(preds)
    report.evaluated = len(evaluated)

    if evaluated:
        correct = sum(1 for p in evaluated if p["status"] == "correct")
        report.win_rate = correct / len(evaluated) * 100
        report.avg_confidence = sum(float(p.get("confidence") or 0) for p in evaluated) / len(evaluated)

        # Segment by conditions
        for pred in evaluated:
            ctx = pred.get("context") or {}

            _add_to_bucket(report.by_source, pred.get("source", "unknown"), pred)
            _add_to_bucket(report.by_rsi_range, _bucket_rsi(ctx.get("rsi")), pred)
            _add_to_bucket(report.by_adx_range, _bucket_adx(ctx.get("adx")), pred)
            _add_to_bucket(report.by_fg_range, _bucket_fg(ctx.get("fear_greed")), pred)
            _add_to_bucket(report.by_regime, ctx.get("regime", "unknown"), pred)
            _add_to_bucket(report.by_volume_range, _bucket_volume(ctx.get("volume_ratio")), pred)
            _add_to_bucket(report.by_confidence_range, _bucket_confidence(pred.get("confidence")), pred)

    # 2. Load trades for trade-level stats
    try:
        trades = await db.select("trades", ["pnl_usd", "pnl_pct"],
                                 filters={}, order_by="-exit_at", limit=500)
        trades = [t for t in (trades or []) if True]  # all trades for now
    except Exception:
        trades = []

    if trades:
        report.total_trades = len(trades)
        wins = [t for t in trades if float(t["pnl_usd"]) > 0]
        losses = [t for t in trades if float(t["pnl_usd"]) <= 0]
        report.trade_win_rate = len(wins) / len(trades) * 100 if trades else 0
        report.avg_win_usd = sum(float(t["pnl_usd"]) for t in wins) / len(wins) if wins else 0
        report.avg_loss_usd = sum(float(t["pnl_usd"]) for t in losses) / len(losses) if losses else 0
        total_wins = sum(float(t["pnl_usd"]) for t in wins)
        total_losses = abs(sum(float(t["pnl_usd"]) for t in losses))
        report.profit_factor = total_wins / total_losses if total_losses > 0 else 0

    # 3. Identify best/worst conditions
    all_buckets = []
    for name, bmap in [
        ("rsi", report.by_rsi_range), ("adx", report.by_adx_range),
        ("fg", report.by_fg_range), ("regime", report.by_regime),
        ("volume", report.by_volume_range), ("confidence", report.by_confidence_range),
    ]:
        for key, stats in bmap.items():
            if stats.total >= 5:  # minimum sample
                all_buckets.append((f"{name}={key}", stats))

    report.best_conditions = [
        f"{label} → {s.win_rate:.0f}% win ({s.total} samples)"
        for label, s in sorted(all_buckets, key=lambda x: -x[1].win_rate)
        if s.win_rate >= 70
    ][:5]

    report.worst_conditions = [
        f"{label} → {s.win_rate:.0f}% win ({s.total} samples)"
        for label, s in sorted(all_buckets, key=lambda x: x[1].win_rate)
        if s.win_rate < 40
    ][:5]

    # 4. Generate recommendations
    report.recommendations = _generate_recommendations(report)

    log.info("performance_analyzed", period_hours=period_hours,
             predictions=report.total_predictions, evaluated=report.evaluated,
             win_rate=round(report.win_rate, 1),
             best=len(report.best_conditions), worst=len(report.worst_conditions))

    return report


def _generate_recommendations(report: PerformanceReport) -> list[str]:
    """Generate actionable parameter recommendations based on the analysis."""
    recs = []

    # Confidence calibration
    for key, stats in report.by_confidence_range.items():
        if stats.total >= 5:
            if stats.win_rate < 40 and stats.avg_confidence > 65:
                recs.append(f"Confidence {key} overestimates: win rate {stats.win_rate:.0f}% vs avg confidence {stats.avg_confidence:.0f}. Consider raising threshold.")
            if stats.win_rate > 75 and stats.avg_confidence < 70:
                recs.append(f"Confidence {key} underestimates: win rate {stats.win_rate:.0f}%. These are reliable signals.")

    # Regime insights
    for regime, stats in report.by_regime.items():
        if stats.total >= 5 and stats.win_rate < 35:
            recs.append(f"Regime '{regime}' has {stats.win_rate:.0f}% win rate — consider blocking entries in this regime.")

    # Fear & Greed insights
    for fg, stats in report.by_fg_range.items():
        if stats.total >= 5 and stats.win_rate < 35:
            recs.append(f"F&G '{fg}' has {stats.win_rate:.0f}% win rate — reduce position size or block entries.")

    # RSI insights
    for rsi, stats in report.by_rsi_range.items():
        if stats.total >= 5 and stats.win_rate > 70:
            recs.append(f"RSI '{rsi}' has {stats.win_rate:.0f}% win rate — increase weight for these setups.")

    # Volume insights
    for vol, stats in report.by_volume_range.items():
        if stats.total >= 5:
            if vol in ("very_low", "low") and stats.win_rate < 40:
                recs.append(f"Low volume entries have {stats.win_rate:.0f}% win rate — raise volume_mult filter.")

    return recs[:8]  # max 8 recommendations
