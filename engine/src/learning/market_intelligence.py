"""
Market Intelligence: aprende patrones de comportamiento del mercado
analizando qué condiciones producen movimientos reales vs falsos.

No es prueba y error — genera reglas fundamentadas:
1. Analiza el contexto completo de cada predicción (indicadores, régimen, volumen, etc.)
2. Identifica COMBINACIONES de condiciones que son predictivas
3. Genera "banderas de control" (flags) que el sistema usa como filtros
4. Cuando está atorado (no puede determinar una regla clara), genera un
   reporte estructurado para análisis externo por IA

Output:
- MarketRules: reglas aprendidas que se persisten y aplican
- ControlFlags: banderas activas que modifican el comportamiento
- StuckReport: reporte para análisis externo cuando el sistema no puede resolver
"""
import structlog
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from collections import defaultdict

log = structlog.get_logger()


@dataclass
class MarketRule:
    """Una regla aprendida del comportamiento del mercado."""
    id: str                          # unique slug
    description: str                 # human-readable
    conditions: dict                 # condiciones que activan la regla
    action: str                      # "block_entry", "reduce_size", "prefer_rsi", "raise_threshold", "require_volume"
    action_params: dict              # parámetros del action
    evidence: dict                   # datos que respaldan la regla
    sample_size: int                 # cuántas observaciones
    win_rate_with: float             # win rate cuando se sigue la regla
    win_rate_without: float          # win rate cuando no se sigue
    confidence: str                  # "proven" (>30 samples), "emerging" (10-30), "hypothesis" (<10)
    created_at: str
    last_validated: str


@dataclass
class ControlFlag:
    """Bandera de control activa que modifica el comportamiento del sistema."""
    name: str
    active: bool
    reason: str
    action: str                      # qué hace cuando está activa
    expires_at: str | None           # cuándo se re-evalúa
    source_rule: str | None          # qué regla la generó


@dataclass
class StuckReport:
    """Reporte para análisis externo cuando el sistema no puede resolver."""
    title: str
    situation: str                   # descripción del problema
    data_summary: dict               # datos relevantes compactados
    hypotheses: list[str]            # posibles explicaciones
    questions: list[str]             # preguntas específicas para el analista
    raw_data_ref: str                # referencia a datos completos
    priority: str                    # "high", "medium", "low"
    generated_at: str


async def learn_from_outcomes() -> dict:
    """
    Ciclo principal de aprendizaje. Analiza predicciones evaluadas
    y genera/actualiza reglas de mercado.

    Returns summary dict.
    """
    from src.core.db import get_db
    db = get_db()
    now = datetime.now(timezone.utc)

    # 1. Load evaluated predictions with full context
    try:
        preds = await db.select(
            "predictions", ["*"],
            filters={"status": "correct"},
            order_by="-predicted_at", limit=500,
        )
        preds_wrong = await db.select(
            "predictions", ["*"],
            filters={"status": "wrong"},
            order_by="-predicted_at", limit=500,
        )
        preds_all = (preds or []) + (preds_wrong or [])
    except Exception as e:
        log.error("learning_load_failed", error=str(e))
        return {"error": str(e)}

    if len(preds_all) < 10:
        return {"skip": "insufficient_data", "count": len(preds_all)}

    # 2. Discover patterns in the data
    rules = []
    flags = []
    stuck = []

    # Analyze: RSI + Volume combinations
    rsi_vol_analysis = _analyze_rsi_volume_patterns(preds_all)
    rules.extend(rsi_vol_analysis["rules"])
    if rsi_vol_analysis.get("stuck"):
        stuck.append(rsi_vol_analysis["stuck"])

    # Analyze: Regime impact
    regime_analysis = _analyze_regime_patterns(preds_all)
    rules.extend(regime_analysis["rules"])
    flags.extend(regime_analysis["flags"])

    # Analyze: Time-of-day patterns
    time_analysis = _analyze_time_patterns(preds_all)
    rules.extend(time_analysis["rules"])

    # Analyze: Momentum continuation vs reversal
    momentum_analysis = _analyze_momentum_patterns(preds_all)
    rules.extend(momentum_analysis["rules"])

    # Analyze: Volume confirmation
    volume_analysis = _analyze_volume_confirmation(preds_all)
    rules.extend(volume_analysis["rules"])

    # 3. Persist rules and flags
    for rule in rules:
        await _persist_rule(db, rule, now)

    for flag in flags:
        await _persist_flag(db, flag, now)

    # 4. Generate stuck reports if needed
    for report in stuck:
        await _persist_stuck_report(db, report, now)

    summary = {
        "analyzed": len(preds_all),
        "rules_generated": len(rules),
        "flags_set": len(flags),
        "stuck_reports": len(stuck),
        "timestamp": now.isoformat(),
    }

    log.info("learning_cycle_done", **summary)
    return summary


def _analyze_rsi_volume_patterns(preds: list[dict]) -> dict:
    """
    ¿Los RSI bounces funcionan solo con volumen alto?
    ¿RSI oversold sin volumen es trampa?
    """
    rules = []

    # Separate by RSI range + volume
    buckets = defaultdict(lambda: {"correct": 0, "wrong": 0, "total": 0, "moves": []})

    for p in preds:
        ctx = p.get("context") or {}
        rsi = ctx.get("rsi")
        vol = ctx.get("volume_ratio")
        if rsi is None or vol is None:
            continue

        rsi_bucket = "oversold" if rsi < 30 else "neutral" if rsi < 70 else "overbought"
        vol_bucket = "high" if vol > 1.5 else "low" if vol < 0.8 else "normal"
        key = f"{rsi_bucket}_{vol_bucket}"

        buckets[key]["total"] += 1
        if p["status"] == "correct":
            buckets[key]["correct"] += 1
        else:
            buckets[key]["wrong"] += 1
        if p.get("actual_move_pct") is not None:
            buckets[key]["moves"].append(float(p["actual_move_pct"]))

    # Rule: RSI oversold + low volume = trap
    trap = buckets.get("oversold_low", {"total": 0, "correct": 0})
    good = buckets.get("oversold_high", {"total": 0, "correct": 0})

    if trap["total"] >= 5 and good["total"] >= 5:
        trap_wr = trap["correct"] / trap["total"] * 100
        good_wr = good["correct"] / good["total"] * 100

        if trap_wr < 40 and good_wr > 55:
            rules.append(MarketRule(
                id="rsi_oversold_needs_volume",
                description=f"RSI oversold bounces only work with volume confirmation. "
                           f"Without volume: {trap_wr:.0f}% win rate ({trap['total']} samples). "
                           f"With volume: {good_wr:.0f}% win rate ({good['total']} samples).",
                conditions={"rsi": "<30", "volume_ratio": "<0.8"},
                action="block_entry",
                action_params={"reason": "RSI oversold sin volumen es trampa de mercado"},
                evidence={"trap_win_rate": trap_wr, "good_win_rate": good_wr,
                          "trap_samples": trap["total"], "good_samples": good["total"]},
                sample_size=trap["total"] + good["total"],
                win_rate_with=good_wr,
                win_rate_without=trap_wr,
                confidence="proven" if trap["total"] + good["total"] >= 30 else "emerging",
                created_at=datetime.now(timezone.utc).isoformat(),
                last_validated=datetime.now(timezone.utc).isoformat(),
            ))

    result = {"rules": rules}

    # Stuck: can't determine pattern with available data
    if trap["total"] < 5 and good["total"] < 5 and len(preds) >= 20:
        result["stuck"] = StuckReport(
            title="Insufficient RSI+Volume cross-analysis data",
            situation="The system has predictions but can't determine if RSI bounces need volume confirmation because there aren't enough samples in the RSI oversold range.",
            data_summary={
                "total_predictions": len(preds),
                "rsi_oversold_low_vol": trap["total"],
                "rsi_oversold_high_vol": good["total"],
                "buckets": {k: {"total": v["total"], "correct": v["correct"]} for k, v in buckets.items()},
            },
            hypotheses=[
                "RSI rarely reaches oversold in current market conditions",
                "The scoring threshold filters out oversold entries before they become predictions",
                "The RSI oversold level (25) might be too strict for the current volatility regime",
            ],
            questions=[
                "Should we lower the RSI oversold threshold to capture more bounce opportunities?",
                "Is the current market regime (risk_off with F&G=10) suppressing volume on bounces?",
                "Would a different RSI period (14 instead of 7) give more reliable signals?",
            ],
            raw_data_ref="predictions table, filter: context->>rsi < 30",
            priority="medium",
            generated_at=datetime.now(timezone.utc).isoformat(),
        )

    return result


def _analyze_regime_patterns(preds: list[dict]) -> dict:
    """
    ¿Qué regímenes producen wins vs losses?
    Genera flags de control por régimen.
    """
    rules = []
    flags = []

    regime_stats = defaultdict(lambda: {"correct": 0, "wrong": 0, "total": 0})

    for p in preds:
        ctx = p.get("context") or {}
        regime = ctx.get("regime", "unknown")
        regime_stats[regime]["total"] += 1
        if p["status"] == "correct":
            regime_stats[regime]["correct"] += 1
        else:
            regime_stats[regime]["wrong"] += 1

    for regime, stats in regime_stats.items():
        if stats["total"] < 5:
            continue
        wr = stats["correct"] / stats["total"] * 100

        if wr < 35:
            rules.append(MarketRule(
                id=f"regime_{regime}_poor",
                description=f"Régimen '{regime}' tiene {wr:.0f}% win rate en {stats['total']} predicciones. "
                           f"Las entradas en este régimen pierden más de lo que ganan.",
                conditions={"regime": regime},
                action="raise_threshold",
                action_params={"threshold_add": 10, "reason": f"Régimen {regime} hostil"},
                evidence=stats,
                sample_size=stats["total"],
                win_rate_with=0,
                win_rate_without=wr,
                confidence="proven" if stats["total"] >= 20 else "emerging",
                created_at=datetime.now(timezone.utc).isoformat(),
                last_validated=datetime.now(timezone.utc).isoformat(),
            ))

            flags.append(ControlFlag(
                name=f"hostile_regime_{regime}",
                active=True,
                reason=f"Win rate {wr:.0f}% en régimen {regime} ({stats['total']} predicciones)",
                action=f"Raise all entry thresholds by 10 points when regime={regime}",
                expires_at=(datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
                source_rule=f"regime_{regime}_poor",
            ))

    return {"rules": rules, "flags": flags}


def _analyze_time_patterns(preds: list[dict]) -> dict:
    """¿Hay horas del día que producen mejores resultados?"""
    rules = []
    hour_stats = defaultdict(lambda: {"correct": 0, "wrong": 0, "total": 0})

    for p in preds:
        try:
            import pandas as pd
            hour = pd.to_datetime(p["predicted_at"], utc=True).hour
            bucket = f"{(hour // 4) * 4:02d}-{((hour // 4) * 4 + 4) % 24:02d}UTC"
            hour_stats[bucket]["total"] += 1
            if p["status"] == "correct":
                hour_stats[bucket]["correct"] += 1
            else:
                hour_stats[bucket]["wrong"] += 1
        except Exception:
            continue

    for bucket, stats in hour_stats.items():
        if stats["total"] < 5:
            continue
        wr = stats["correct"] / stats["total"] * 100

        if wr > 70 and stats["total"] >= 10:
            rules.append(MarketRule(
                id=f"good_hours_{bucket}",
                description=f"Las horas {bucket} tienen {wr:.0f}% win rate ({stats['total']} predicciones). "
                           f"El mercado es más predecible en este horario.",
                conditions={"hour_bucket": bucket},
                action="prefer_window",
                action_params={"boost": 5},
                evidence=stats,
                sample_size=stats["total"],
                win_rate_with=wr, win_rate_without=0,
                confidence="proven" if stats["total"] >= 20 else "emerging",
                created_at=datetime.now(timezone.utc).isoformat(),
                last_validated=datetime.now(timezone.utc).isoformat(),
            ))

    return {"rules": rules}


def _analyze_momentum_patterns(preds: list[dict]) -> dict:
    """
    ¿Los breakouts momentum funcionan o son trampas?
    ¿Los RSI reversals son más confiables?
    """
    rules = []
    source_bias = defaultdict(lambda: {"correct": 0, "wrong": 0, "total": 0})

    for p in preds:
        ctx = p.get("context") or {}
        # Try to identify if it was momentum vs RSI
        state = ctx.get("state", "unknown")
        adx = ctx.get("adx")
        rsi = ctx.get("rsi")

        if adx is not None and float(adx) > 25:
            mode = "momentum"
        elif rsi is not None and float(rsi) < 35:
            mode = "reversal"
        else:
            mode = "mixed"

        source_bias[mode]["total"] += 1
        if p["status"] == "correct":
            source_bias[mode]["correct"] += 1
        else:
            source_bias[mode]["wrong"] += 1

    for mode, stats in source_bias.items():
        if stats["total"] < 5:
            continue
        wr = stats["correct"] / stats["total"] * 100

        if wr > 65:
            rules.append(MarketRule(
                id=f"mode_{mode}_effective",
                description=f"Modo {mode} tiene {wr:.0f}% win rate ({stats['total']} muestras). "
                           f"Este tipo de setup es confiable en las condiciones actuales.",
                conditions={"mode": mode},
                action="prefer_mode",
                action_params={"mode": mode, "confidence_boost": 5},
                evidence=stats,
                sample_size=stats["total"],
                win_rate_with=wr, win_rate_without=0,
                confidence="proven" if stats["total"] >= 20 else "emerging",
                created_at=datetime.now(timezone.utc).isoformat(),
                last_validated=datetime.now(timezone.utc).isoformat(),
            ))

    return {"rules": rules}


def _analyze_volume_confirmation(preds: list[dict]) -> dict:
    """¿El volumen confirma la dirección? ¿Entradas sin volumen fallan?"""
    rules = []
    vol_stats = defaultdict(lambda: {"correct": 0, "wrong": 0, "total": 0})

    for p in preds:
        ctx = p.get("context") or {}
        vol = ctx.get("volume_ratio")
        if vol is None:
            continue
        vol = float(vol)
        bucket = "very_high" if vol > 2.0 else "high" if vol > 1.5 else "normal" if vol > 0.8 else "low"
        vol_stats[bucket]["total"] += 1
        if p["status"] == "correct":
            vol_stats[bucket]["correct"] += 1
        else:
            vol_stats[bucket]["wrong"] += 1

    low = vol_stats.get("low", {"total": 0, "correct": 0})
    high = vol_stats.get("high", {"total": 0, "correct": 0})
    vhigh = vol_stats.get("very_high", {"total": 0, "correct": 0})

    if low["total"] >= 5:
        low_wr = low["correct"] / low["total"] * 100
        combined_high = {
            "total": high["total"] + vhigh["total"],
            "correct": high["correct"] + vhigh["correct"],
        }
        if combined_high["total"] >= 5:
            high_wr = combined_high["correct"] / combined_high["total"] * 100
            if low_wr < 40 and high_wr > 55:
                rules.append(MarketRule(
                    id="volume_confirms_direction",
                    description=f"Volumen confirma dirección: "
                               f"vol bajo → {low_wr:.0f}% win rate, "
                               f"vol alto → {high_wr:.0f}% win rate. "
                               f"No entrar sin confirmación de volumen.",
                    conditions={"volume_ratio": "<0.8"},
                    action="require_volume",
                    action_params={"min_volume_ratio": 1.0},
                    evidence={"low_wr": low_wr, "high_wr": high_wr,
                              "low_samples": low["total"], "high_samples": combined_high["total"]},
                    sample_size=low["total"] + combined_high["total"],
                    win_rate_with=high_wr,
                    win_rate_without=low_wr,
                    confidence="proven" if low["total"] + combined_high["total"] >= 30 else "emerging",
                    created_at=datetime.now(timezone.utc).isoformat(),
                    last_validated=datetime.now(timezone.utc).isoformat(),
                ))

    return {"rules": rules}


# ============================================================
# PERSISTENCE
# ============================================================

async def _persist_rule(db, rule: MarketRule, now: datetime) -> None:
    """Save or update a market rule in market_rules table."""
    try:
        row = {
            "id": rule.id,
            "description": rule.description,
            "conditions": rule.conditions,
            "action": rule.action,
            "action_params": rule.action_params,
            "evidence": rule.evidence,
            "sample_size": rule.sample_size,
            "win_rate_with": rule.win_rate_with,
            "win_rate_without": rule.win_rate_without,
            "confidence": rule.confidence,
            "active": True,
            "last_validated": now.isoformat(),
        }
        await db.upsert("market_rules", row, on_conflict="id")
        log.info("rule_persisted", id=rule.id, confidence=rule.confidence,
                 win_rate_with=rule.win_rate_with)
    except Exception as e:
        log.error("rule_persist_failed", id=rule.id, error=str(e))


async def _persist_flag(db, flag: ControlFlag, now: datetime) -> None:
    """Save a control flag in control_flags table + alert for visibility."""
    try:
        await db.upsert("control_flags", {
            "name": flag.name,
            "active": flag.active,
            "reason": flag.reason,
            "action": flag.action,
            "source_rule": flag.source_rule,
            "expires_at": flag.expires_at,
        }, on_conflict="name")

        await db.insert("alerts", {
            "level": "info",
            "category": "learning",
            "title": f"[bandera] {flag.name}",
            "message": f"{flag.reason} → {flag.action}",
            "metadata": {
                "flag_name": flag.name, "active": flag.active,
                "action": flag.action, "source_rule": flag.source_rule,
            },
        })
    except Exception as e:
        log.error("flag_persist_failed", name=flag.name, error=str(e))


async def _persist_stuck_report(db, report: StuckReport, now: datetime) -> None:
    """
    Save a stuck report as a structured alert + prediction for retrieval.
    This is what gets sent to external AI for deeper analysis.
    """
    try:
        # Alert for visibility
        await db.insert("alerts", {
            "level": "warn",
            "category": "learning",
            "title": f"[análisis requerido] {report.title}",
            "message": f"{report.situation[:200]}",
            "metadata": {
                "type": "stuck_report",
                "priority": report.priority,
                "hypotheses": report.hypotheses,
                "questions": report.questions,
                "data_summary": report.data_summary,
            },
        })

        # Full report in predictions for structured retrieval
        await db.insert("predictions", {
            "symbol": "_STUCK_",
            "source": "market_intelligence",
            "bias": "neutral",
            "confidence": 0,
            "price_at_prediction": 0,
            "eval_window_hours": 0,
            "status": "pending",
            "predicted_at": now.isoformat(),
            "context": {
                "type": "stuck_report",
                "title": report.title,
                "situation": report.situation,
                "data_summary": report.data_summary,
                "hypotheses": report.hypotheses,
                "questions": report.questions,
                "raw_data_ref": report.raw_data_ref,
                "priority": report.priority,
            },
            "notes": f"STUCK: {report.title}",
        })

        log.info("stuck_report_saved", title=report.title, priority=report.priority)

    except Exception as e:
        log.error("stuck_report_failed", error=str(e))


async def get_active_rules(vertical: str | None = None) -> list[dict]:
    """Load active market rules, optionally filtered by vertical."""
    from src.core.db import get_db
    db = get_db()
    try:
        rows = await db.select("market_rules", ["*"],
                               filters={"active": True},
                               order_by="-sample_size", limit=100)
        if vertical:
            rows = [r for r in (rows or [])
                    if r.get("vertical") is None or r.get("vertical") == vertical]
        return rows or []
    except Exception:
        return []


async def get_active_flags() -> list[dict]:
    """Load active control flags."""
    from src.core.db import get_db
    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    try:
        rows = await db.select("control_flags", ["*"],
                               filters={"active": True}, limit=50)
        # Filter expired
        return [r for r in (rows or [])
                if not r.get("expires_at") or r["expires_at"] > now]
    except Exception:
        return []


async def get_stuck_reports() -> list[dict]:
    """Load unresolved stuck reports for external analysis."""
    from src.core.db import get_db
    db = get_db()
    try:
        rows = await db.select("predictions", ["context", "predicted_at"],
                               filters={"symbol": "_STUCK_", "status": "pending"},
                               order_by="-predicted_at", limit=10)
        return [r["context"] for r in (rows or []) if r.get("context")]
    except Exception:
        return []
