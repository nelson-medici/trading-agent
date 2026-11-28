"""
Monitor de pattern triggers — verifica condiciones de confirmación y ejecuta.

Corre cada ~1 min. Para cada trigger en estado 'watching':
  1. Obtiene velas recientes del símbolo
  2. Verifica la condición de disparo (breakout, RSI cross, etc.)
  3. Si se confirma → crea decisión y ejecuta (o solo alerta)
  4. Si expiró → marca como expired

Tipos de trigger:
  - breakout_above: cierre por encima de trigger_price (con volumen)
  - breakout_below: cierre por debajo de trigger_price (con volumen)
  - rsi_cross_above: RSI cruza arriba de trigger_rsi
  - rsi_cross_below: RSI cruza abajo de trigger_rsi
  - price_touch: precio toca trigger_price (mecha o cierre)
"""
import uuid
from datetime import datetime, timezone
import numpy as np
import pandas as pd
import structlog

log = structlog.get_logger()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_now_iso() -> str:
    return _utc_now().isoformat()


def _rsi(closes: list[float], period: int = 14) -> float:
    if len(closes) < period + 1:
        return 50.0
    gains, losses = 0.0, 0.0
    for i in range(len(closes) - period, len(closes)):
        diff = closes[i] - closes[i - 1]
        if diff > 0:
            gains += diff
        else:
            losses -= diff
    if losses == 0:
        return 100.0
    rs = (gains / period) / (losses / period)
    return 100 - 100 / (1 + rs)


async def run_trigger_monitor() -> None:
    """Job principal: verifica todos los triggers activos."""
    from src.core.db import get_db
    db = get_db()

    try:
        # Obtener triggers activos
        triggers = await db.select("pattern_triggers", filters={"status": "watching"})
        if not triggers:
            return

        now = _utc_now()
        for trigger in triggers:
            try:
                await _check_trigger(db, trigger, now)
            except Exception as e:
                log.error("trigger_check_failed", trigger_id=trigger["id"], error=str(e))

    except Exception as e:
        log.error("trigger_monitor_failed", error=str(e))


async def _check_trigger(db, trigger: dict, now: datetime) -> None:
    trigger_id = trigger["id"]
    symbol = trigger["symbol"]
    timeframe = trigger.get("timeframe", "1h")

    # Verificar expiración
    expires_at = trigger.get("expires_at")
    if expires_at:
        exp = pd.to_datetime(expires_at, utc=True).to_pydatetime()
        if now > exp:
            await db.update("pattern_triggers",
                {"status": "expired", "trigger_detail": "Expiró sin confirmarse"},
                {"id": trigger_id})
            log.info("trigger_expired", id=trigger_id, symbol=symbol)
            return

    # Obtener velas
    candles = await db.select(
        "ohlcv",
        filters={"symbol": symbol, "timeframe": timeframe},
        order_by="-ts",
        limit=50,
    )
    if not candles or len(candles) < 5:
        return

    candles_asc = sorted(candles, key=lambda c: c["ts"])
    closes = [float(c["close"]) for c in candles_asc]
    last = candles_asc[-1]
    last_close = float(last["close"])
    last_high = float(last["high"])
    last_low = float(last["low"])
    last_volume = float(last.get("volume", 0))

    # Volumen promedio
    avg_vol = np.mean([float(c.get("volume", 0)) for c in candles_asc[-21:-1]]) if len(candles_asc) >= 21 else last_volume
    vol_ok = not trigger.get("require_volume", True) or (avg_vol > 0 and last_volume >= avg_vol)

    # Verificar condición según tipo
    trigger_type = trigger["trigger_type"]
    trigger_price = float(trigger["trigger_price"]) if trigger.get("trigger_price") else None
    trigger_rsi = float(trigger["trigger_rsi"]) if trigger.get("trigger_rsi") else None
    confirmed = False
    detail = ""

    if trigger_type == "breakout_above" and trigger_price:
        if last_close > trigger_price and vol_ok:
            confirmed = True
            vol_ratio = last_volume / avg_vol if avg_vol > 0 else 1
            detail = f"Breakout confirmado: cierre {last_close:.2f} > {trigger_price:.2f} con volumen {vol_ratio:.1f}×"

    elif trigger_type == "breakout_below" and trigger_price:
        if last_close < trigger_price and vol_ok:
            confirmed = True
            vol_ratio = last_volume / avg_vol if avg_vol > 0 else 1
            detail = f"Quiebre confirmado: cierre {last_close:.2f} < {trigger_price:.2f} con volumen {vol_ratio:.1f}×"

    elif trigger_type == "rsi_cross_above" and trigger_rsi:
        rsi_now = _rsi(closes, 14)
        rsi_prev = _rsi(closes[:-1], 14) if len(closes) > 1 else rsi_now
        if rsi_prev <= trigger_rsi and rsi_now > trigger_rsi:
            confirmed = True
            detail = f"RSI cruzó arriba de {trigger_rsi:.0f}: {rsi_prev:.1f} → {rsi_now:.1f}"

    elif trigger_type == "rsi_cross_below" and trigger_rsi:
        rsi_now = _rsi(closes, 14)
        rsi_prev = _rsi(closes[:-1], 14) if len(closes) > 1 else rsi_now
        if rsi_prev >= trigger_rsi and rsi_now < trigger_rsi:
            confirmed = True
            detail = f"RSI cruzó abajo de {trigger_rsi:.0f}: {rsi_prev:.1f} → {rsi_now:.1f}"

    elif trigger_type == "price_touch" and trigger_price:
        if last_low <= trigger_price <= last_high:
            confirmed = True
            detail = f"Precio tocó nivel {trigger_price:.2f} (rango {last_low:.2f}–{last_high:.2f})"

    if not confirmed:
        return

    # ¡Trigger confirmado!
    log.info("trigger_confirmed", id=trigger_id, symbol=symbol, detail=detail)

    action = trigger.get("action", "ALERT_ONLY")
    pool = trigger.get("pool", "tactical")

    if action == "ALERT_ONLY":
        # Solo alertar
        await db.update("pattern_triggers",
            {"status": "triggered", "triggered_at": _utc_now_iso(), "trigger_detail": detail},
            {"id": trigger_id})
        await db.insert("alerts", {
            "level": "info",
            "category": "pattern",
            "title": f"[patrón] {trigger['pattern_name']} confirmado · {symbol}",
            "message": detail,
            "metadata": {"trigger_id": trigger_id, "symbol": symbol, "href": f"/charts?symbol={symbol}"},
        })
        return

    # Crear decisión y ejecutar
    try:
        # Calcular ATR para stops
        atr_vals = []
        for i in range(1, min(15, len(candles_asc))):
            c = candles_asc[i]
            p = candles_asc[i - 1]
            tr = max(float(c["high"]) - float(c["low"]),
                     abs(float(c["high"]) - float(p["close"])),
                     abs(float(c["low"]) - float(p["close"])))
            atr_vals.append(tr)
        atr = np.mean(atr_vals) if atr_vals else last_close * 0.01

        stop_mult = float(trigger.get("stop_atr_mult", 2.0))
        target_mult = float(trigger.get("target_atr_mult", 4.0))
        stop = last_close - atr * stop_mult
        target = last_close + atr * target_mult
        max_capital = float(trigger.get("max_capital_usd", 25))

        # Sizing simple
        risk_per_unit = last_close - stop
        if risk_per_unit <= 0:
            risk_per_unit = last_close * 0.01
        size = min(max_capital / last_close, (max_capital * 0.02) / risk_per_unit)
        notional = size * last_close

        decision = {
            "symbol": symbol,
            "action": action,
            "score": 0,
            "pool": pool,
            "justification": f"[pattern trigger] {trigger['pattern_name']} · {detail}",
            "risks": [],
            "stop_price": stop,
            "target_price": target,
            "size_units": size,
            "notional_usd": notional,
            "entry_price": last_close,
            "status": "pending",
            "requires_confirmation": False,
        }

        inserted = await db.insert("decisions", decision)

        from src.execution.executor import execute_decision
        await execute_decision(inserted, pool)

        await db.update("pattern_triggers", {
            "status": "triggered",
            "triggered_at": _utc_now_iso(),
            "trigger_detail": detail,
            "decision_id": inserted.get("id"),
        }, {"id": trigger_id})

        await db.insert("alerts", {
            "level": "info",
            "category": "pattern",
            "title": f"[patrón] {trigger['pattern_name']} → {action} {symbol}",
            "message": f"{detail} · Notional ${notional:.2f} · Stop ${stop:.2f} · Target ${target:.2f}",
            "metadata": {"trigger_id": trigger_id, "symbol": symbol, "decision_id": inserted.get("id"),
                         "href": f"/charts?symbol={symbol}", "timeframe": trigger.get("timeframe", "1h")},
        })

        log.info("trigger_executed", id=trigger_id, symbol=symbol, action=action, notional=round(notional, 2))

    except Exception as e:
        log.error("trigger_execution_failed", id=trigger_id, error=str(e))
        await db.update("pattern_triggers",
            {"status": "triggered", "triggered_at": _utc_now_iso(),
             "trigger_detail": f"{detail} — EJECUCIÓN FALLÓ: {e}"},
            {"id": trigger_id})
        await db.insert("alerts", {
            "level": "warn",
            "category": "pattern",
            "title": f"[patrón] {trigger['pattern_name']} confirmado pero falló ejecución · {symbol}",
            "message": str(e),
            "metadata": {"trigger_id": trigger_id, "symbol": symbol},
        })
