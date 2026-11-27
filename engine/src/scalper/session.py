"""
Motor de una sesión de scalping (paper).

`tick()` se llama cada ~15 s. Es determinista dado (store, market, now):
no hay IA ni estado en memoria; todo el estado vive en scalper_sessions /
scalper_trades, así que sobrevive a reinicios del engine.

Cortes de sesión (stop_reason):
  time_expired · max_trades · loss_limit · consecutive_losses · profit_lock ·
  regime_deteriorated · flash_crash · kill_switch · manual
"""
from datetime import datetime, timedelta, timezone
import pandas as pd
import structlog
from src.scalper.indicators import merged_params, entry_signal, scalp_score, flash_crash, prepare

log = structlog.get_logger()

MIN_NOTIONAL_USD = 10.0
STALE_REQUEST_MIN = 5
PROTECTIVE_STOPS = {"loss_limit", "consecutive_losses", "regime_deteriorated", "flash_crash", "kill_switch"}


def _dt(v) -> datetime | None:
    if v is None:
        return None
    return pd.to_datetime(v, utc=True).to_pydatetime()


def _iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat()


async def tick(store, market, now: datetime | None = None) -> None:
    now = now or datetime.now(timezone.utc)
    sess = await store.live_session()
    if not sess:
        return
    if sess["status"] == "requested":
        sess = await _activate(store, sess, now)
        if not sess:
            return
    await _run_active(store, market, sess, now)


async def _activate(store, sess: dict, now: datetime) -> dict | None:
    age_min = (now - _dt(sess["requested_at"])).total_seconds() / 60
    if age_min > STALE_REQUEST_MIN:
        await _reject(store, sess, now, "engine_offline",
                      f"El pedido quedó {age_min:.0f} min sin atender (engine apagado). No se inicia tarde.")
        return None
    if await store.kill_active():
        await _reject(store, sess, now, "kill_switch", "Kill switch activo: no se abren sesiones.")
        return None

    cfg = merged_params(await store.config())
    pool = (await store.config() or {}).get("capital_pool", "tactical")
    cash = await store.pool_cash(pool)
    capital = min(float(sess["max_capital_usd"]), cash)
    if capital < MIN_NOTIONAL_USD:
        await _reject(store, sess, now, "insufficient_cash",
                      f"Cash disponible en {pool}: ${cash:.2f} (mínimo ${MIN_NOTIONAL_USD:.0f}).")
        return None

    cfg["capital_pool"] = pool
    upd = {
        "status": "active",
        "started_at": _iso(now),
        "ends_at": _iso(now + timedelta(minutes=int(sess["duration_min"]))),
        "capital_usd": capital,
        "params": cfg,
        "last_note": "sesión iniciada, buscando ruptura",
        "last_tick_at": _iso(now),
    }
    await store.update_session(sess["id"], upd)
    await store.insert_alert("info", "scalper", f"[scalper] Sesión iniciada · {sess['symbol']}",
                             f"{sess['duration_min']} min · capital ${capital:.2f} · máx {sess['max_trades']} trades",
                             {"session_id": sess["id"], "symbol": sess["symbol"]})
    log.info("scalper_session_started", symbol=sess["symbol"], capital=capital)
    return {**sess, **upd}


async def _reject(store, sess: dict, now: datetime, reason: str, detail: str) -> None:
    await store.update_session(sess["id"], {
        "status": "rejected", "stop_reason": reason, "stop_detail": detail, "ended_at": _iso(now),
    })
    await store.insert_alert("warn", "scalper", f"[scalper] Sesión rechazada · {sess['symbol']}", detail,
                             {"session_id": sess["id"], "reason": reason})
    log.warning("scalper_session_rejected", reason=reason)


async def _run_active(store, market, sess: dict, now: datetime) -> None:
    p = merged_params(sess.get("params"))
    symbol = sess["symbol"]
    trade = await store.open_trade(sess["id"])

    try:
        df = prepare(await market.fetch_candles(symbol, 360))
        bid, ask = await market.fetch_quote(symbol)
    except Exception as e:  # sin datos no se decide nada; si expiró igual se cierra abajo
        log.error("scalper_market_fetch_failed", error=str(e))
        df, bid, ask = None, 0.0, 0.0

    have_data = df is not None and len(df) > 0 and bid > 0 and ask > 0
    st = {  # estado mutable de la sesión para este tick
        "trades_count": int(sess["trades_count"]), "wins": int(sess["wins"]), "losses": int(sess["losses"]),
        "consecutive_losses": int(sess["consecutive_losses"]),
        "realized_pnl_usd": float(sess["realized_pnl_usd"]), "peak_pnl_usd": float(sess["peak_pnl_usd"]),
        "cooldown_until": sess.get("cooldown_until"), "low_score_streak": int(sess["low_score_streak"]),
        "last_score": sess.get("last_score"), "last_note": sess.get("last_note"),
    }
    capital = float(sess["capital_usd"])

    # 1) Gestionar trade abierto
    if trade and have_data:
        trade = await _manage_trade(store, sess, trade, df, bid, p, st, now)

    # 2) Cortes de sesión
    reason, detail = None, ""
    unreal = 0.0
    if trade and have_data:
        unreal = (bid - float(trade["entry_price"])) * float(trade["size_units"])
    if sess.get("stop_requested"):
        reason, detail = "manual", "Detenida manualmente desde el portal."
    elif await store.kill_active():
        reason, detail = "kill_switch", "Kill switch activado durante la sesión."
    elif now >= _dt(sess["ends_at"]):
        reason, detail = "time_expired", "Se cumplió la duración de la sesión."
    elif have_data and (fc := flash_crash(df, p["flash_crash_pct"])) is not None:
        reason, detail = "flash_crash", f"Caída de {fc * 100:.2f}% en 5 min: se sale para no operar en pánico."
    elif st["realized_pnl_usd"] + unreal <= -p["max_session_loss_pct"] * capital:
        reason = "loss_limit"
        detail = f"Pérdida de sesión ${st['realized_pnl_usd'] + unreal:.2f} alcanzó el límite ({p['max_session_loss_pct'] * 100:.1f}% del capital)."
    elif not trade:
        if st["consecutive_losses"] >= p["max_consecutive_losses"]:
            reason, detail = "consecutive_losses", f"{st['consecutive_losses']} pérdidas seguidas: el mercado no acompaña la estrategia."
        elif (st["peak_pnl_usd"] >= p["profit_lock_trigger_pct"] * capital
              and st["realized_pnl_usd"] <= st["peak_pnl_usd"] * (1 - p["profit_lock_giveback"])):
            reason, detail = "profit_lock", f"Se devolvió más del {p['profit_lock_giveback'] * 100:.0f}% de la ganancia pico (${st['peak_pnl_usd']:.2f}): se protege lo ganado."
        elif st["trades_count"] >= int(sess["max_trades"]):
            reason, detail = "max_trades", f"Se completaron los {sess['max_trades']} trades de la sesión."

    # 3) Régimen (solo en vela nueva y sin posición)
    if not reason and not trade and have_data:
        last_closed = df["ts"].iloc[-2].isoformat() if len(df) > 1 else ""
        if p.get("_regime_candle") != last_closed:
            score, _, note = scalp_score(df, p)
            st["last_score"] = score
            st["low_score_streak"] = st["low_score_streak"] + 1 if score < p["min_regime_score"] else 0
            p["_regime_candle"] = last_closed
            if st["low_score_streak"] >= p["regime_streak_to_stop"]:
                reason = "regime_deteriorated"
                detail = f"Scalp score {score:.0f} < {p['min_regime_score']} por {st['low_score_streak']} min seguidos{' (' + note + ')' if note else ''}: el mercado dejó de ser scalpeable."

    if reason:
        if trade:
            if have_data:
                await _close_trade(store, sess, trade, bid, "session_end", st, p, now)
            elif reason in ("time_expired", "manual", "kill_switch"):
                # sin cotización: se cierra al último precio conocido para no dejar la posición huérfana
                px = float(trade.get("last_price") or trade["entry_price"])
                await _close_trade(store, sess, trade, px, "session_end", st, p, now)
            else:
                return
        await _end_session(store, sess, st, reason, detail, now)
        return

    # 4) Entrada
    if not trade and have_data:
        st["last_note"] = await _maybe_enter(store, sess, df, bid, ask, p, st, capital, now)

    await store.update_session(sess["id"], {
        **{k: st[k] for k in ("trades_count", "wins", "losses", "consecutive_losses", "realized_pnl_usd",
                              "peak_pnl_usd", "cooldown_until", "low_score_streak", "last_score", "last_note")},
        "params": p, "last_tick_at": _iso(now),
    })


async def _maybe_enter(store, sess, df, bid, ask, p, st, capital, now) -> str:
    mins_left = (_dt(sess["ends_at"]) - now).total_seconds() / 60
    if mins_left < p["no_entry_last_min"]:
        return f"últimos {p['no_entry_last_min']} min: no se abren trades nuevos"
    cd = _dt(st["cooldown_until"])
    if cd and now < cd:
        return f"cooldown tras pérdida ({(cd - now).total_seconds():.0f}s)"

    sig = entry_signal(df, bid, ask, p)
    if not sig.ok:
        return sig.reason
    if p.get("_last_entry_candle") == sig.candle_ts:
        return "ya se operó esta vela de ruptura"

    notional = capital + min(st["realized_pnl_usd"], 0.0)  # las pérdidas achican el tamaño; las ganancias no lo agrandan
    if notional < MIN_NOTIONAL_USD:
        return "capital remanente por debajo del mínimo"
    size = notional / sig.entry
    await store.insert_trade({
        "session_id": sess["id"], "symbol": sess["symbol"], "status": "open", "size_units": size,
        "entry_price": sig.entry, "initial_stop": sig.stop, "stop_price": sig.stop, "target_price": sig.target,
        "high_water": sig.entry, "last_price": bid, "opened_at": _iso(now), "entry_reason": sig.reason,
    })
    p["_last_entry_candle"] = sig.candle_ts
    st["trades_count"] += 1
    log.info("scalper_entry", symbol=sess["symbol"], entry=sig.entry, stop=sig.stop, target=sig.target)
    return f"EN POSICIÓN · {sig.reason}"


async def _manage_trade(store, sess, trade, df, bid, p, st, now) -> dict | None:
    entry = float(trade["entry_price"])
    stop = float(trade["stop_price"])
    target = float(trade["target_price"])
    r = entry - float(trade["initial_stop"])
    opened = _dt(trade["opened_at"])
    be_moved = bool(trade["breakeven_moved"])

    def stop_label() -> str:
        if stop <= float(trade["initial_stop"]) + 1e-12:
            return "stop"
        return "trailing_stop" if stop > entry * (1 + 2 * p["commission_per_side_pct"]) + 1e-12 else "breakeven_stop"

    # Mechas entre ticks: velas que empezaron después de la entrada
    after = df[df["ts"] >= pd.Timestamp(opened).ceil("min")]
    if len(after) and float(after["low"].min()) <= stop:
        return await _close_trade(store, sess, trade, stop if bid >= stop else bid, stop_label(), st, p, now)
    if bid <= stop:
        return await _close_trade(store, sess, trade, bid, stop_label(), st, p, now)
    if bid >= target or (len(after) and float(after["high"].max()) >= target):
        return await _close_trade(store, sess, trade, target, "target", st, p, now)

    hw = max(float(trade["high_water"]), bid, float(after["high"].max()) if len(after) else bid)
    if not be_moved and hw >= entry + p["breakeven_at_r"] * r:
        stop = max(stop, entry * (1 + 2 * p["commission_per_side_pct"]))
        be_moved = True
    if hw >= entry + p["trail_at_r"] * r:
        stop = max(stop, hw - r)

    held_min = (now - opened).total_seconds() / 60
    if held_min >= p["time_stop_min"] and bid < entry + p["time_stop_min_r"] * r:
        return await _close_trade(store, sess, trade, bid, "time_stop", st, p, now)

    upd = {"stop_price": stop, "high_water": hw, "last_price": bid, "breakeven_moved": be_moved}
    await store.update_trade(trade["id"], upd)
    st["last_note"] = f"EN POSICIÓN · stop {stop:.6g} · target {target:.6g}"
    return {**trade, **upd}


async def _close_trade(store, sess, trade, exit_price, reason, st, p, now) -> None:
    entry = float(trade["entry_price"])
    size = float(trade["size_units"])
    commission = p["commission_per_side_pct"] * size * (entry + exit_price)
    pnl = (exit_price - entry) * size - commission
    pnl_pct = (exit_price - entry) / entry
    opened = _dt(trade["opened_at"])

    await store.update_trade(trade["id"], {
        "status": "closed", "closed_at": _iso(now), "exit_price": exit_price, "exit_reason": reason,
        "pnl_usd": pnl, "pnl_pct": pnl_pct, "commission_usd": commission, "last_price": exit_price,
    })
    await store.insert_ledger_trade({
        "symbol": trade["symbol"], "side": "LONG", "size_units": size, "entry_price": entry,
        "exit_price": exit_price, "entry_at": trade["opened_at"], "exit_at": _iso(now),
        "pnl_usd": pnl, "pnl_pct": pnl_pct, "commission_usd": commission, "exit_reason": reason,
        "hold_hours": (now - opened).total_seconds() / 3600,
        "pool": p.get("capital_pool", "tactical"), "strategy_name": sess.get("strategy") or "scalper_momentum_1m",
    })

    st["realized_pnl_usd"] += pnl
    st["peak_pnl_usd"] = max(st["peak_pnl_usd"], st["realized_pnl_usd"])
    if pnl > 0:
        st["wins"] += 1
        st["consecutive_losses"] = 0
    else:
        st["losses"] += 1
        st["consecutive_losses"] += 1
        st["cooldown_until"] = _iso(now + timedelta(minutes=p["cooldown_after_loss_min"]))
    st["last_note"] = f"último trade: {reason} ${pnl:+.2f}"
    log.info("scalper_exit", symbol=trade["symbol"], reason=reason, pnl=round(pnl, 4))
    return None


async def _end_session(store, sess, st, reason, detail, now) -> None:
    status = "completed" if reason in ("time_expired", "max_trades") else "stopped"
    await store.update_session(sess["id"], {
        **{k: st[k] for k in ("trades_count", "wins", "losses", "consecutive_losses", "realized_pnl_usd",
                              "peak_pnl_usd", "low_score_streak", "last_score")},
        "status": status, "stop_reason": reason, "stop_detail": detail, "ended_at": _iso(now),
        "last_tick_at": _iso(now), "last_note": detail,
    })
    level = "warn" if reason in PROTECTIVE_STOPS else "info"
    await store.insert_alert(
        level, "scalper", f"[scalper] Sesión finalizada · {sess['symbol']} · {reason}",
        f"PnL ${st['realized_pnl_usd']:+.2f} · {st['trades_count']} trades ({st['wins']}W/{st['losses']}L) · {detail}",
        {"session_id": sess["id"], "reason": reason, "pnl_usd": st["realized_pnl_usd"]},
    )
    log.info("scalper_session_ended", reason=reason, pnl=round(st["realized_pnl_usd"], 4))
