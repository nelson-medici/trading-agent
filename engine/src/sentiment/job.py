"""
Job de sentimiento: corre el provider configurado y persiste señales.

Corre cada 30 min. Lee noticias/sentimiento según el provider activo
y guarda las señales en la DB para que el scoring contextual las use.
"""
import structlog
from .providers import get_sentiment_provider
from .provider import SentimentSignal

log = structlog.get_logger()


async def run_sentiment_scan() -> None:
    """Job principal: obtener señales del provider y persistir."""
    from src.core.db import get_db
    from src.core.config import DBConfig

    db = get_db()
    cfg = DBConfig(db)
    await cfg.refresh()

    provider = get_sentiment_provider()
    log.info("sentiment_scan_start", provider=provider.name())

    # Collect all symbols from all pools
    all_symbols = set()
    for pool_name in cfg.enabled_pools():
        pool_cfg = cfg.pool(pool_name)
        for sym in pool_cfg.get("universe", []):
            all_symbols.add(sym)

    if not all_symbols:
        return

    try:
        signals = await provider.fetch_signals(list(all_symbols))

        if not signals:
            log.info("sentiment_scan_no_signals", provider=provider.name())
            return

        # Persist signals
        for signal in signals:
            try:
                await db.insert("sentiment_signals", signal.to_db_row())
                log.info("sentiment_signal_saved",
                         symbol=signal.symbol, score=signal.score,
                         impact=signal.impact, event=signal.event[:50])
            except Exception as e:
                log.error("sentiment_save_error", error=str(e))

        # Expire old signals
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        try:
            expired = await db.select("sentiment_signals",
                                      filters={"status": "active"})
            for s in (expired or []):
                if s.get("expires_at", "") < now:
                    await db.update("sentiment_signals",
                                    {"status": "expired"}, {"id": s["id"]})
        except Exception as e:
            log.warning("sentiment_expire_error", error=str(e))

        log.info("sentiment_scan_done", signals=len(signals))

    except Exception as e:
        log.error("sentiment_scan_failed", error=str(e), exc_info=True)
