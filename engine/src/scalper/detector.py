"""
Detector de oportunidades de scalping.

Corre cada ~3 min sobre la watchlist: calcula el scalp score de cada símbolo,
actualiza el radar (scalper_scan) y, si supera el umbral:
  - emite UNA alerta accionable (cooldown por símbolo, silenciada con sesión viva)
  - si auto_start está habilitado, lanza una sesión sobre el mejor candidato,
    sujeto a los frenos de auto-inicio (máx. por 24h, separación mínima,
    pérdida acumulada 24h, kill switch).
"""
from datetime import datetime, timedelta, timezone
import pandas as pd
import structlog
from src.scalper.indicators import merged_params, scalp_score

log = structlog.get_logger()

AUTO_DEFAULTS = {
    "enabled": True, "duration_min": 30, "capital_usd": 25, "max_trades": 5,
    "max_sessions_24h": 4, "min_gap_min": 30, "loss_limit_24h_usd": 1.0,
}


async def scan(store, market, now: datetime | None = None) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    raw = await store.config() or {}
    if not raw.get("detector_enabled", True):
        return []
    p = merged_params(raw)
    watchlist = raw.get("watchlist") or ["BTC/USDT", "ETH/USDT"]
    session_live = await store.live_session() is not None
    alerted, candidates = [], []

    for symbol in watchlist:
        try:
            df = await market.fetch_candles(symbol, 400)
            score, comp, note = scalp_score(df, p)
            price = float(pd.to_numeric(df["close"]).iloc[-1]) if len(df) else None
            await store.upsert_scan({
                "symbol": symbol, "score": score, "components": comp, "price": price,
                "note": note, "updated_at": now.isoformat(),
            })
            if score < p["alert_threshold"] or session_live:
                continue
            candidates.append({"symbol": symbol, "score": score})
            last = await store.last_opportunity_at(symbol)
            if last and (now - last).total_seconds() / 60 < p["alert_cooldown_min"]:
                continue
            await store.insert_opportunity({"symbol": symbol, "score": score, "components": comp, "price": price})
            await store.insert_alert(
                "warn", "scalper_opportunity", f"[scalper] {symbol} — oportunidad (score {score:.0f})",
                f"Vol {comp.get('vol_ratio')}× · ATR {comp.get('atr_pct')}% · ADX {comp.get('adx')} · rango 5m {comp.get('range5_pct')}%",
                {"symbol": symbol, "score": score, "href": f"/scalper?symbol={symbol}"},
            )
            alerted.append({"symbol": symbol, "score": score})
            log.info("scalper_opportunity", symbol=symbol, score=score)
        except Exception as e:
            log.error("scalper_scan_failed", symbol=symbol, error=str(e))

    if candidates:
        log.info("scalper_candidates_found", count=len(candidates),
                 symbols=[c["symbol"] for c in candidates],
                 scores=[c["score"] for c in candidates])
        launched = await _maybe_auto_start(store, raw, candidates, now)
        if not launched:
            log.info("scalper_auto_start_skipped", candidates=len(candidates))
    return alerted


async def _maybe_auto_start(store, raw: dict, candidates: list[dict], now: datetime) -> str | None:
    """Lanza una sesión sobre el mejor candidato. Devuelve el símbolo lanzado o None."""
    auto = {**AUTO_DEFAULTS, **(raw.get("auto_start") or {})}
    if not auto["enabled"]:
        log.info("scalper_auto_skip", reason="disabled")
        return None
    if await store.kill_active():
        log.info("scalper_auto_skip", reason="kill_switch")
        return None

    recent = await store.sessions_since(now - timedelta(hours=24))
    autos = [s for s in recent if s.get("auto") and s.get("status") != "rejected"]
    if len(autos) >= int(auto["max_sessions_24h"]):
        log.info("scalper_auto_skip", reason="max_sessions_24h")
        return None
    pnl_24h = sum(float(s.get("realized_pnl_usd") or 0) for s in autos)
    if pnl_24h <= -float(auto["loss_limit_24h_usd"]):
        log.info("scalper_auto_skip", reason="loss_limit_24h", pnl=pnl_24h)
        return None
    ended = [pd.to_datetime(s["ended_at"], utc=True).to_pydatetime() for s in recent if s.get("ended_at")]
    if ended and (now - max(ended)).total_seconds() / 60 < float(auto["min_gap_min"]):
        log.info("scalper_auto_skip", reason="min_gap")
        return None

    best = max(candidates, key=lambda c: c["score"])
    log.info("scalper_auto_start_attempting", symbol=best["symbol"], score=best["score"],
             auto_config=auto, recent_sessions=len(recent), recent_autos=len(autos))
    try:
        await store.insert_session({
            "symbol": best["symbol"], "duration_min": int(auto["duration_min"]),
            "max_capital_usd": float(auto["capital_usd"]), "max_trades": int(auto["max_trades"]),
            "status": "requested", "auto": True, "requested_at": now.isoformat(),
            "last_note": f"auto-inicio por score {best['score']:.0f}",
        })
    except Exception as e:
        log.error("scalper_auto_start_failed", error=str(e), exc_info=True,
                  symbol=best["symbol"], score=best["score"])
        # Also create an alert so the user sees why it failed
        try:
            await store.insert_alert(
                "error", "scalper", f"[scalper] Auto-start falló · {best['symbol']}",
                f"Score {best['score']:.0f} pero no pudo crear sesión: {str(e)[:200]}",
                {"symbol": best["symbol"], "score": best["score"], "error": str(e)[:200]},
            )
        except Exception:
            pass
        return None
    log.info("scalper_auto_started", symbol=best["symbol"], score=best["score"])
    # Alert about successful auto-start
    try:
        await store.insert_alert(
            "info", "scalper", f"[scalper] Auto-start · {best['symbol']} (score {best['score']:.0f})",
            f"Sesión automática iniciada: {int(auto['duration_min'])} min, ${float(auto['capital_usd'])}, máx {int(auto['max_trades'])} trades",
            {"symbol": best["symbol"], "score": best["score"], "auto": True},
        )
    except Exception:
        pass
    return best["symbol"]
