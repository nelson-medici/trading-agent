"""
Jobs de scheduler.
Cada job es idempotente y loggea su estado.
"""
import structlog
from datetime import datetime

log = structlog.get_logger()


async def heartbeat() -> None:
    from src.core.db import get_db
    db = get_db()
    await db.insert("heartbeats", {
        "service": "engine",
        "status": "healthy",
        "metrics": {},
    })


async def ingest_market_data() -> None:
    from src.data.market_crypto import CryptoMarketData
    from src.core.db import get_db
    db = get_db()
    universe = await db.get_config_value("universe.crypto") or ["BTC/USDT", "ETH/USDT"]
    md = CryptoMarketData()
    try:
        total = await md.ingest_universe(universe, timeframe="1h", limit=500)
        log.info("market_data_ingested", total=total)
    finally:
        await md.close()


async def compute_features_and_score() -> None:
    """
    Corre features + scoring para todo el universo.
    Placeholder - se completa con lógica real (pipeline de features → score → estado).
    """
    log.info("features_and_score_placeholder")


async def evaluate_decisions() -> None:
    log.info("evaluate_decisions_placeholder")


async def watch_positions() -> None:
    log.info("watch_positions_placeholder")


async def watch_candidates() -> None:
    log.info("watch_candidates_placeholder")


async def reconcile_orders() -> None:
    log.info("reconcile_placeholder")


async def rollover_daily_dd() -> None:
    log.info("dd_daily_rollover")


async def rollover_weekly_dd() -> None:
    log.info("dd_weekly_rollover")


async def backup_db() -> None:
    log.info("backup_placeholder")


async def daily_report() -> None:
    log.info("daily_report_placeholder")


async def weekly_review() -> None:
    log.info("weekly_review_placeholder")


async def ingest_news() -> None:
    log.info("ingest_news_placeholder")
