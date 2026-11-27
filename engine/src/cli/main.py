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


@cli.command("backtest")
@click.option("--strategy", required=True, help="Nombre de la estrategia (ej: orb_intraday)")
@click.option("--symbol", required=True, help="Símbolo (ej: BTC/USDT)")
@click.option("--timeframe", default="1h", help="Timeframe (1h, 15m, 4h)")
@click.option("--capital", default=10_000.0, type=float, help="Capital inicial")
@click.option("--risk-pct", default=0.01, type=float, help="Risk per trade (0.01 = 1%)")
@click.option("--save", is_flag=True, help="Guardar resultado en Supabase")
def backtest(strategy: str, symbol: str, timeframe: str, capital: float, risk_pct: float, save: bool):
    """Correr backtest de una estrategia sobre histórico."""
    configure_logging("INFO")
    asyncio.run(_backtest(strategy, symbol, timeframe, capital, risk_pct, save))


async def _backtest(strategy_name: str, symbol: str, timeframe: str, capital: float, risk_pct: float, save: bool):
    import structlog
    log = structlog.get_logger()
    import pandas as pd
    from src.core.db import get_db
    from src.strategies.registry import get_strategy, all_strategies
    from src.backtest.engine import BacktestEngine

    strategy = get_strategy(strategy_name)
    if strategy is None:
        print(f"Estrategia desconocida: {strategy_name}")
        print(f"Disponibles: {all_strategies()}")
        return

    db = get_db()
    rows = await db.select(
        "ohlcv",
        filters={"symbol": symbol, "timeframe": timeframe},
        order_by="ts",
        limit=5000,
    )
    if len(rows) < 100:
        print(f"Insuficiente data para {symbol} {timeframe}: {len(rows)} rows. Correr backfill primero.")
        return

    df = pd.DataFrame(rows)
    engine = BacktestEngine(initial_capital=capital, risk_per_trade_pct=risk_pct)

    print(f"\n=== Backtest: {strategy_name} / {symbol} / {timeframe} ===")
    print(f"Capital inicial: ${capital:,.2f} · Risk/trade: {risk_pct*100:.2f}%")
    print(f"Data: {len(rows)} candles desde {rows[0]['ts'][:10]} hasta {rows[-1]['ts'][:10]}\n")

    result = engine.run(strategy, df, symbol, timeframe)

    print(f"Trades:        {result.total_trades}")
    print(f"Win rate:      {result.win_rate*100:.1f}%  ({result.winning_trades}W / {result.losing_trades}L)")
    print(f"Profit factor: {result.profit_factor:.2f}")
    print(f"Sharpe:        {result.sharpe_ratio:.2f}")
    print(f"Max DD:        {result.max_drawdown_pct*100:.2f}%")
    print(f"Avg win:       ${result.avg_win_usd:.2f}")
    print(f"Avg loss:      ${result.avg_loss_usd:.2f}")
    print(f"Avg hold:      {result.avg_hold_hours:.1f}h")
    print(f"Return total:  {result.total_return_pct*100:.2f}%")
    print(f"Capital final: ${result.final_capital:,.2f}")

    if save and result.total_trades > 0:
        await db.insert("backtest_results", {
            "strategy_name": result.strategy_name,
            "symbol": result.symbol,
            "timeframe": result.timeframe,
            "start_date": result.start_date,
            "end_date": result.end_date,
            "initial_capital": result.initial_capital,
            "final_capital": result.final_capital,
            "total_return_pct": result.total_return_pct,
            "total_trades": result.total_trades,
            "winning_trades": result.winning_trades,
            "losing_trades": result.losing_trades,
            "win_rate": result.win_rate,
            "profit_factor": min(result.profit_factor, 999.99),
            "sharpe_ratio": result.sharpe_ratio,
            "max_drawdown_pct": result.max_drawdown_pct,
            "avg_win_usd": result.avg_win_usd,
            "avg_loss_usd": result.avg_loss_usd,
            "avg_hold_hours": result.avg_hold_hours,
            "params": strategy.params,
            "trades_detail": [t.__dict__ for t in result.trades[:100]],
        })
        print(f"\nGuardado en backtest_results.")


if __name__ == "__main__":
    cli()
