"""Entry point CLI."""
import asyncio
import click
from src.core.logging_setup import configure_logging
from src.core.config import get_env


@click.group()
def cli():
    pass


@cli.command()
def run():
    """Correr el engine (foreground)."""
    env = get_env()
    configure_logging(env.log_level)
    asyncio.run(_run())


async def _run():
    from src.orchestrator.scheduler import scheduler, setup_jobs, run_startup_jobs
    from src.core.config import DBConfig
    from src.core.db import get_db
    import structlog
    log = structlog.get_logger()

    log.info("engine_starting", env=get_env().env)
    db = get_db()
    cfg = DBConfig(db)
    await cfg.refresh()
    log.info("config_loaded", keys=list(cfg._cache.keys()))

    setup_jobs()
    scheduler.start()
    log.info("scheduler_started")

    # Correr jobs clave una vez al arrancar (para no esperar triggers horarios)
    await run_startup_jobs()

    try:
        while True:
            await asyncio.sleep(3600)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        log.info("engine_stopped")


@cli.command("check-connections")
def check_connections():
    """Verificar conectividad de todas las APIs."""
    configure_logging("INFO")
    asyncio.run(_check_connections())


async def _check_connections():
    import structlog
    log = structlog.get_logger()
    env = get_env()

    # Supabase
    try:
        from src.core.db import get_db
        db = get_db()
        result = await db.select("config", ["key"], limit=1)
        log.info("supabase_ok", rows=len(result))
    except Exception as e:
        log.error("supabase_failed", error=str(e))

    # Binance
    try:
        import ccxt.async_support as ccxt
        exch = ccxt.binance({"enableRateLimit": True})
        ticker = await exch.fetch_ticker("BTC/USDT")
        log.info("binance_ok", btc_price=ticker["last"])
        await exch.close()
    except Exception as e:
        log.error("binance_failed", error=str(e))

    # Anthropic
    if env.anthropic_api_key:
        try:
            from anthropic import AsyncAnthropic
            client = AsyncAnthropic(api_key=env.anthropic_api_key)
            r = await client.messages.create(
                model="claude-haiku-4-5",
                max_tokens=10,
                messages=[{"role": "user", "content": "ping"}],
            )
            log.info("anthropic_ok")
        except Exception as e:
            log.error("anthropic_failed", error=str(e))
    else:
        log.warning("anthropic_no_key")

    # Telegram
    from src.alerts.telegram import send_message
    if await send_message("🔧 Trading agent: check-connections OK"):
        log.info("telegram_ok")
    else:
        log.warning("telegram_failed")


@cli.command("backfill")
@click.option("--days", default=730, help="Días de histórico")
def backfill(days: int):
    """Backfill de OHLCV histórico."""
    configure_logging("INFO")
    asyncio.run(_backfill(days))


async def _backfill(days: int):
    import structlog
    log = structlog.get_logger()
    from src.data.market_crypto import CryptoMarketData
    from src.core.db import get_db

    db = get_db()
    universe = await db.get_config_value("universe.crypto") or ["BTC/USDT", "ETH/USDT"]
    md = CryptoMarketData()
    try:
        # Binance limita a 500-1000 candles por request
        hours = days * 24
        limit = min(1000, hours)
        total = await md.ingest_universe(universe, timeframe="1h", limit=limit)
        log.info("backfill_done", total=total, universe=universe)
    finally:
        await md.close()


@cli.command()
def kill():
    """Activar kill switch."""
    configure_logging("INFO")
    asyncio.run(_kill())


async def _kill():
    from src.core.kill_switch import get_kill_switch
    ks = get_kill_switch()
    await ks.activate("Manual kill from CLI")


@cli.command()
def resume():
    """Desactivar kill switch."""
    configure_logging("INFO")
    asyncio.run(_resume())


async def _resume():
    from src.core.kill_switch import get_kill_switch
    ks = get_kill_switch()
    await ks.deactivate()


@cli.command("telegram-test")
def telegram_test():
    """Enviar mensaje de prueba al bot."""
    configure_logging("INFO")
    asyncio.run(_telegram_test())


async def _telegram_test():
    from src.alerts.telegram import send_message
    ok = await send_message("✅ Trading agent · test message")
    print(f"Telegram: {'OK' if ok else 'FAIL'}")


@cli.command("eval-paper-phase")
def eval_paper_phase():
    """Gate paper → live: evaluar métricas y decidir."""
    configure_logging("INFO")
    print("Paper phase evaluation - to be implemented after data available")


if __name__ == "__main__":
    cli()
