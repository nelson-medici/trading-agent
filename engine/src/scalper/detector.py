"""
Detector de oportunidades de scalping.

Corre cada ~3 min sobre la watchlist: calcula el scalp score de cada símbolo,
actualiza el radar (scalper_scan) y, si supera el umbral, emite UNA alerta
accionable (con cooldown por símbolo y silenciada mientras hay una sesión viva).
"""
from datetime import datetime, timezone
import pandas as pd
import structlog
from src.scalper.indicators import merged_params, scalp_score

log = structlog.get_logger()


async def scan(store, market, now: datetime | None = None) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    raw = await store.config() or {}
    if not raw.get("detector_enabled", True):
        return []
    p = merged_params(raw)
    watchlist = raw.get("watchlist") or ["BTC/USDT", "ETH/USDT"]
    session_live = await store.live_session() is not None
    alerted = []

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
    return alerted
