"""
Jobs del scheduler.
Cada job es idempotente y loggea su estado.
"""
import uuid
import structlog
from datetime import datetime, timezone
import pandas as pd

log = structlog.get_logger()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ============================================================
# HEARTBEAT
# ============================================================

async def heartbeat() -> None:
    from src.core.db import get_db
    db = get_db()
    await db.insert("heartbeats", {
        "service": "engine",
        "status": "healthy",
        "metrics": {},
    })


# ============================================================
# INGESTA DE MERCADO
# ============================================================

async def ingest_market_data() -> None:
    from src.data.market_crypto import CryptoMarketData
    from src.core.db import get_db
    db = get_db()
    universe = await db.get_config_value("universe.crypto") or ["BTC/USDT", "ETH/USDT"]
    md = CryptoMarketData()
    try:
        total = await md.ingest_universe(universe, timeframe="1h", limit=500)
        log.info("market_data_ingested", total=total, universe=universe)
    finally:
        await md.close()


async def ingest_news() -> None:
    """
    Placeholder — sin fuente de noticias configurada todavía.
    Cuando agreguemos Alpha Vantage o Finnhub, se completa.
    """
    log.info("ingest_news_skipped", reason="no news source configured")


# ============================================================
# FEATURES + SCORING
# ============================================================

async def compute_features_and_score() -> None:
    """
    Pipeline central:
    1. Lee OHLCV reciente por activo
    2. Calcula features técnicas
    3. Calcula componentes de score
    4. Score total + state machine
    5. Persiste features y scores
    """
    from src.core.db import get_db
    from src.core.config import DBConfig
    from src.features.technical import compute_technical_features
    from src.scoring.components import compute_all_components
    from src.scoring.aggregator import aggregate
    from src.scoring.state_machine import transition
    from src.scoring.confidence import evaluate_high_confidence
    from src.risk.stops import compute_stop_target, compute_rr_ratio
    from src.data.market_crypto import CryptoMarketData

    db = get_db()
    cfg = DBConfig(db)
    await cfg.refresh()

    universe = cfg.universe
    weights = cfg.weights
    thresholds = cfg.thresholds
    confidence_cfg = cfg.confidence
    stops_cfg = cfg.stops

    # Spreads actuales (ticker)
    md = CryptoMarketData()
    spreads: dict[str, float] = {}
    try:
        for sym in universe:
            try:
                spreads[sym] = await md.bid_ask_spread(sym)
            except Exception as e:
                log.warning("spread_fetch_failed", symbol=sym, error=str(e))
                spreads[sym] = 0.001
    finally:
        await md.close()

    # Detectar régimen una sola vez (compartido para todos los activos)
    from src.features.regime import detect_regime
    # Para btc_above_sma50 necesitamos el OHLCV de BTC diario; aprox con 1h
    btc_rows = await db.select(
        "ohlcv",
        filters={"symbol": "BTC/USDT", "timeframe": "1h"},
        order_by="-ts",
        limit=50 * 24,  # 50 días horarios ≈ SMA50 diaria
    )
    btc_above_sma50 = False
    if len(btc_rows) >= 50:
        btc_df = pd.DataFrame(btc_rows)
        btc_df["close"] = pd.to_numeric(btc_df["close"])
        btc_df = btc_df.sort_values("ts")
        # Resamplear a diario (1 vela cada 24 horas)
        btc_daily = btc_df.iloc[::24].reset_index(drop=True)
        if len(btc_daily) >= 50:
            sma50 = btc_daily["close"].tail(50).mean()
            current = btc_daily["close"].iloc[-1]
            btc_above_sma50 = bool(current > sma50)

    regime_data = await detect_regime(btc_above_sma50=btc_above_sma50)

    scored_count = 0

    for symbol in universe:
        try:
            rows = await db.select(
                "ohlcv",
                filters={"symbol": symbol, "timeframe": "1h"},
                order_by="-ts",
                limit=500,
            )
            if len(rows) < 200:
                log.warning("insufficient_ohlcv", symbol=symbol, rows=len(rows))
                continue

            df = pd.DataFrame(rows)
            df["ts"] = pd.to_datetime(df["ts"])
            for col in ["open", "high", "low", "close", "volume"]:
                df[col] = pd.to_numeric(df[col])

            features = compute_technical_features(df)
            if not features:
                continue

            # Régimen real (shared)
            features["regime"] = regime_data["regime"]
            features["btc_dominance"] = regime_data["btc_dominance"]
            features["fear_greed"] = regime_data["fear_greed"]
            # Defaults para componentes que no computamos todavía (sentimiento LLM)
            features["sentiment_score"] = 0.0
            features["news_count_7d"] = 0
            features["bid_ask_spread_pct"] = spreads.get(symbol, 0.001)
            features["volume_24h_usd"] = 500_000_000  # BTC/ETH son muy líquidos
            features["has_event_in_48h"] = False

            # Persistir features
            await db.upsert("features", {
                "symbol": symbol,
                "ts": _utc_now_iso(),
                "rsi": features.get("rsi"),
                "macd": features.get("macd"),
                "macd_signal": features.get("macd_signal"),
                "macd_hist": features.get("macd_hist"),
                "sma_20": features.get("sma_20"),
                "sma_50": features.get("sma_50"),
                "sma_200": features.get("sma_200"),
                "atr": features.get("atr"),
                "adx": features.get("adx"),
                "volume_ratio": features.get("volume_ratio"),
                "price_above_sma200": features.get("price_above_sma200"),
                "regime": features.get("regime"),
                "volatility_regime": features.get("volatility_regime"),
                "btc_dominance": features.get("btc_dominance"),
                "fear_greed": features.get("fear_greed"),
                "sentiment_score": features.get("sentiment_score"),
                "news_count_7d": features.get("news_count_7d"),
                "bid_ask_spread_pct": features.get("bid_ask_spread_pct"),
                "volume_24h_usd": features.get("volume_24h_usd"),
                "has_event_in_48h": features.get("has_event_in_48h"),
            }, on_conflict="symbol,ts")

            # Scoring
            components = compute_all_components(features, is_crypto=True)
            score_total = aggregate(components, weights)

            # Posición abierta?
            pos_rows = await db.select("positions", filters={"symbol": symbol})
            has_position = len(pos_rows) > 0

            # State machine
            state = transition(
                current_state="IGNORE",  # simplificado; podríamos leer último estado
                score=score_total,
                thresholds=thresholds,
                has_open_position=has_position,
            )

            # Confidence check (para alta convicción)
            price = features.get("close", 0)
            atr = features.get("atr", 0)
            if atr > 0 and price > 0:
                stop, target = compute_stop_target(
                    price, atr,
                    stop_multiplier=stops_cfg.get("atr_stop_multiplier", 2.0),
                    target_multiplier=stops_cfg.get("atr_target_multiplier", 4.0),
                )
                rr = compute_rr_ratio(price, stop, target)
            else:
                stop, target, rr = 0, 0, 0

            # Historia de scores recientes (últimos N)
            recent = await db.select(
                "scores",
                ["score_total"],
                filters={"symbol": symbol},
                order_by="-ts",
                limit=3,
            )
            score_history = [r["score_total"] for r in recent]

            confidence_check = evaluate_high_confidence(
                score_total=score_total,
                score_technical=components.technical,
                indicators_aligned=components.indicators_aligned,
                price_above_sma200=features.get("price_above_sma200", False),
                volume_ratio=features.get("volume_ratio", 1),
                market_regime=features.get("regime", "neutral"),
                has_event_in_48h=features.get("has_event_in_48h", False),
                risk_reward_ratio=rr,
                score_history=score_history,
                bid_ask_spread_pct=features.get("bid_ask_spread_pct", 0.001),
                required_signals=confidence_cfg.get("required_signals", 3),
                sustained_periods=confidence_cfg.get("sustained_periods", 2),
            )

            await db.insert("scores", {
                "symbol": symbol,
                "ts": _utc_now_iso(),
                "score_total": score_total,
                "score_technical": components.technical,
                "score_fundamental": components.fundamental,
                "score_sentiment": components.sentiment,
                "score_risk": components.risk,
                "score_timing": components.timing,
                "state": state,
                "passes_high_confidence": confidence_check.passes,
                "confidence_checks": confidence_check.checks,
                "indicators_aligned": components.indicators_aligned,
            })

            scored_count += 1
            log.info(
                "scored",
                symbol=symbol,
                score=score_total,
                state=state,
                technical=components.technical,
                has_position=has_position,
            )

        except Exception as e:
            log.error("scoring_failed", symbol=symbol, error=str(e), exc_info=True)

    log.info("features_and_score_done", scored=scored_count)


# ============================================================
# DECISIONES
# ============================================================

async def evaluate_decisions() -> None:
    """
    Para cada activo con score reciente en estado CANDIDATE o superior,
    evaluar si corresponde generar una decisión BUY.
    """
    from src.core.db import get_db
    from src.core.config import DBConfig
    from src.risk.sizing import compute_position_size
    from src.risk.stops import compute_stop_target
    from src.portfolio.manager import PortfolioManager

    db = get_db()
    cfg = DBConfig(db)
    await cfg.refresh()

    portfolio = PortfolioManager()
    equity = await portfolio.current_equity()
    if equity <= 0:
        log.warning("no_equity", equity=equity)
        return

    universe = cfg.universe
    risk_limits = cfg.risk_limits
    stops_cfg = cfg.stops

    for symbol in universe:
        try:
            # Último score
            scores = await db.select(
                "scores",
                filters={"symbol": symbol},
                order_by="-ts",
                limit=1,
            )
            if not scores:
                continue
            score = scores[0]

            # Solo actuamos si es CANDIDATE (sin posición)
            if score["state"] != "CANDIDATE":
                continue

            # Ya tenemos posición?
            if await portfolio.has_open_position(symbol):
                continue

            # Ya hay decisión pending/executed reciente?
            recent_decisions = await db.select(
                "decisions",
                filters={"symbol": symbol},
                order_by="-created_at",
                limit=1,
            )
            if recent_decisions:
                last = recent_decisions[0]
                last_ts = pd.to_datetime(last["created_at"])
                hours_since = (datetime.now(timezone.utc) - last_ts).total_seconds() / 3600
                if hours_since < 4 and last["status"] in ("pending", "approved", "executed"):
                    continue  # ya tenemos algo reciente

            # Último feature para calcular stop/target
            features = await db.select(
                "features",
                filters={"symbol": symbol},
                order_by="-ts",
                limit=1,
            )
            if not features:
                continue
            feat = features[0]
            price = float(feat["sma_20"] or 0)  # aprox del precio actual
            atr = float(feat["atr"] or 0)
            if price <= 0 or atr <= 0:
                continue

            # Precio actual más fresco (último close del ohlcv)
            last_ohlcv = await db.select(
                "ohlcv",
                ["close"],
                filters={"symbol": symbol, "timeframe": "1h"},
                order_by="-ts",
                limit=1,
            )
            if last_ohlcv:
                price = float(last_ohlcv[0]["close"])

            stop, target = compute_stop_target(
                price, atr,
                stop_multiplier=stops_cfg.get("atr_stop_multiplier", 2.0),
                target_multiplier=stops_cfg.get("atr_target_multiplier", 4.0),
            )

            is_btc_eth = symbol in ("BTC/USDT", "ETH/USDT")
            current_pct = await portfolio.current_position_pct(symbol)

            sizing = compute_position_size(
                equity_usd=equity,
                entry_price=price,
                stop_price=stop,
                target_price=target,
                is_btc_or_eth=is_btc_eth,
                current_position_pct=current_pct,
                max_risk_per_trade_pct=risk_limits.get("max_risk_per_trade_pct", 0.01),
                max_position_pct=risk_limits.get("max_position_pct", 0.20),
                max_position_btc_eth_pct=risk_limits.get("max_position_btc_eth_pct", 0.30),
                min_position_size_usd=risk_limits.get("min_position_size_usd", 15),
                min_profit_to_commission_ratio=stops_cfg.get("min_profit_to_commission_ratio", 3.0),
            )

            if not sizing.is_viable:
                log.info("sizing_not_viable", symbol=symbol, reason=sizing.reason)
                continue

            # Max posiciones simultáneas
            open_count = await portfolio.open_positions_count()
            if open_count >= risk_limits.get("max_open_positions", 2):
                log.info("max_positions_reached", symbol=symbol, open=open_count)
                continue

            # Crear decisión
            decision = {
                "symbol": symbol,
                "action": "BUY",
                "score": score["score_total"],
                "score_id": score["id"],
                "justification": (
                    f"Score {score['score_total']:.1f} | "
                    f"Technical {score['score_technical']:.1f} ({score['indicators_aligned']} aligned) | "
                    f"Risk {score['score_risk']:.1f} | "
                    f"HighConf: {score['passes_high_confidence']}"
                ),
                "risks": [],
                "stop_price": stop,
                "target_price": target,
                "size_units": sizing.size_units,
                "notional_usd": sizing.notional_usd,
                "entry_price": price,
                "status": "pending",
                "requires_confirmation": False,
            }

            inserted = await db.insert("decisions", decision)
            log.info(
                "decision_created",
                symbol=symbol,
                action="BUY",
                score=score["score_total"],
                notional=sizing.notional_usd,
                stop=stop,
                target=target,
            )

            # En paper mode, ejecutamos directo
            await _execute_paper_decision(inserted)

        except Exception as e:
            log.error("decision_eval_failed", symbol=symbol, error=str(e), exc_info=True)


async def _execute_paper_decision(decision: dict) -> None:
    """Ejecuta una decisión BUY en modo paper."""
    from src.core.db import get_db
    db = get_db()

    try:
        # Crear orden
        order_id = str(uuid.uuid4())
        notional = decision["notional_usd"]
        commission = notional * 0.001  # 0.1%

        order = {
            "id": order_id,
            "decision_id": decision["id"],
            "symbol": decision["symbol"],
            "side": "BUY",
            "size_units": decision["size_units"],
            "limit_price": decision["entry_price"],
            "stop_price": decision["stop_price"],
            "target_price": decision["target_price"],
            "state": "FILLED",  # paper fills instantly
            "filled_units": decision["size_units"],
            "avg_fill_price": decision["entry_price"],
            "commission_paid": commission,
            "submitted_at": _utc_now_iso(),
            "filled_at": _utc_now_iso(),
        }
        await db.insert("orders", order)

        # Crear position
        await db.insert("positions", {
            "symbol": decision["symbol"],
            "side": "LONG",
            "size_units": decision["size_units"],
            "entry_price": decision["entry_price"],
            "current_price": decision["entry_price"],
            "stop_price": decision["stop_price"],
            "target_price": decision["target_price"],
            "unrealized_pnl_usd": 0.0,
            "unrealized_pnl_pct": 0.0,
            "score_at_entry": decision["score"],
            "current_score": decision["score"],
        })

        # Marcar decision ejecutada
        await db.update("decisions",
            {"status": "executed", "executed_at": _utc_now_iso()},
            {"id": decision["id"]},
        )

        log.info("paper_executed",
            symbol=decision["symbol"],
            size=decision["size_units"],
            price=decision["entry_price"],
        )
    except Exception as e:
        log.error("paper_execution_failed", decision_id=decision.get("id"), error=str(e), exc_info=True)


# ============================================================
# MONITOREO DE POSICIONES
# ============================================================

async def watch_positions() -> None:
    """
    Para cada posición abierta:
    - Actualizar precio actual + PnL
    - Si stop o target tocado, cerrar
    """
    from src.core.db import get_db
    from src.data.market_crypto import CryptoMarketData

    db = get_db()
    positions = await db.select("positions")
    if not positions:
        return

    md = CryptoMarketData()
    try:
        for pos in positions:
            try:
                ticker = await md.fetch_ticker(pos["symbol"])
                current_price = float(ticker.get("last", 0))
                if current_price <= 0:
                    continue

                entry = float(pos["entry_price"])
                size = float(pos["size_units"])
                stop = float(pos["stop_price"])
                target = float(pos["target_price"])

                pnl_usd = (current_price - entry) * size
                pnl_pct = (current_price - entry) / entry

                await db.update("positions", {
                    "current_price": current_price,
                    "unrealized_pnl_usd": pnl_usd,
                    "unrealized_pnl_pct": pnl_pct,
                }, {"symbol": pos["symbol"]})

                # Stop o target?
                exit_reason = None
                if current_price <= stop:
                    exit_reason = "stop"
                elif current_price >= target:
                    exit_reason = "target"

                if exit_reason:
                    await _close_paper_position(pos, current_price, exit_reason)

            except Exception as e:
                log.error("watch_position_failed", symbol=pos.get("symbol"), error=str(e))
    finally:
        await md.close()


async def _close_paper_position(position: dict, exit_price: float, reason: str) -> None:
    """Cierra una posición en modo paper."""
    from src.core.db import get_db
    db = get_db()

    symbol = position["symbol"]
    entry = float(position["entry_price"])
    size = float(position["size_units"])
    opened_at = position["opened_at"]

    pnl_usd = (exit_price - entry) * size
    pnl_pct = (exit_price - entry) / entry
    commission = size * exit_price * 0.001

    opened_dt = pd.to_datetime(opened_at)
    hold_hours = (datetime.now(timezone.utc) - opened_dt).total_seconds() / 3600

    # Insertar en trades (historial)
    await db.insert("trades", {
        "symbol": symbol,
        "side": "LONG",
        "size_units": size,
        "entry_price": entry,
        "exit_price": exit_price,
        "entry_at": opened_at,
        "exit_at": _utc_now_iso(),
        "pnl_usd": pnl_usd - commission,
        "pnl_pct": pnl_pct,
        "commission_usd": commission,
        "exit_reason": reason,
        "hold_hours": hold_hours,
        "score_at_entry": position.get("score_at_entry"),
        "score_at_exit": position.get("current_score"),
    })

    # Borrar la position
    await db.delete("positions", {"symbol": symbol})

    # Crear alert
    await db.insert("alerts", {
        "level": "info",
        "category": "trade",
        "title": f"{symbol} {reason.upper()}",
        "message": f"PnL: ${pnl_usd:.2f} ({pnl_pct*100:.2f}%) · hold {hold_hours:.1f}h",
        "metadata": {"symbol": symbol, "reason": reason, "pnl_usd": pnl_usd},
    })

    log.info("position_closed",
        symbol=symbol,
        reason=reason,
        pnl_usd=pnl_usd,
        pnl_pct=pnl_pct,
    )


async def watch_candidates() -> None:
    """
    Reevalúa activos en watchlist/candidate más frecuentemente que el ciclo horario.
    Por ahora: solo cuenta y loguea.
    """
    from src.core.db import get_db
    db = get_db()
    scores = await db.select(
        "scores",
        filters={"state": "CANDIDATE"},
        order_by="-ts",
        limit=20,
    )
    # dedupe por symbol (último score por symbol)
    seen = set()
    unique = []
    for s in scores:
        if s["symbol"] not in seen:
            seen.add(s["symbol"])
            unique.append(s)
    log.info("watch_candidates", count=len(unique))


# ============================================================
# ÓRDENES
# ============================================================

async def reconcile_orders() -> None:
    """
    En modo paper las órdenes se fillean al instante, nada que reconciliar.
    Cuando pasemos a testnet/real, acá se chequea estado contra el broker.
    """
    from src.core.db import get_db
    db = get_db()
    pending = await db.select(
        "orders",
        filters={"state": "SUBMITTED"},
    )
    log.info("reconcile_orders", pending=len(pending))


# ============================================================
# EQUITY SNAPSHOTS
# ============================================================

async def snapshot_equity() -> None:
    """
    Snapshot del equity actual: cash inicial + valor de posiciones.
    Corre junto con el ciclo de scoring.
    """
    from src.core.db import get_db
    db = get_db()

    # Último equity
    last = await db.select("equity_snapshots", order_by="-ts", limit=1)
    prev_equity = float(last[0]["total_equity_usd"]) if last else 200.0
    hwm = float(last[0]["high_water_mark"]) if last else 200.0

    # Capital events: depositos - retiros
    cap_events = await db.select("capital_events", ["amount_usd", "event_type"])
    total_deposited = sum(
        float(e["amount_usd"]) * (1 if e["event_type"] == "deposit" else -1)
        for e in cap_events
    )

    # Valor de posiciones actuales
    positions = await db.select("positions")
    positions_value = 0.0
    unrealized = 0.0
    for p in positions:
        current = float(p.get("current_price") or p["entry_price"])
        positions_value += float(p["size_units"]) * current
        unrealized += float(p.get("unrealized_pnl_usd") or 0)

    # Trades cerrados → realized PnL total
    trades = await db.select("trades", ["pnl_usd"])
    realized = sum(float(t["pnl_usd"]) for t in trades)

    # Cash = depositado + realized - value de posiciones abiertas (cost basis)
    cost_basis = sum(
        float(p["size_units"]) * float(p["entry_price"])
        for p in positions
    )
    cash = total_deposited + realized - cost_basis

    total_equity = cash + positions_value
    new_hwm = max(hwm, total_equity)
    dd = (new_hwm - total_equity) / new_hwm if new_hwm > 0 else 0

    await db.insert("equity_snapshots", {
        "ts": _utc_now_iso(),
        "total_equity_usd": total_equity,
        "cash_usd": cash,
        "positions_value_usd": positions_value,
        "unrealized_pnl_usd": unrealized,
        "daily_pnl_usd": total_equity - prev_equity,
        "daily_pnl_pct": (total_equity - prev_equity) / prev_equity if prev_equity > 0 else 0,
        "drawdown_from_hwm_pct": dd,
        "high_water_mark": new_hwm,
    })

    log.info("equity_snapshot",
        total=round(total_equity, 2),
        cash=round(cash, 2),
        positions_value=round(positions_value, 2),
        dd=round(dd * 100, 2),
    )


# ============================================================
# ROLLOVER DD
# ============================================================

async def rollover_daily_dd() -> None:
    log.info("dd_daily_rollover")


async def rollover_weekly_dd() -> None:
    log.info("dd_weekly_rollover")


# ============================================================
# BACKUP / REPORTS
# ============================================================

async def backup_db() -> None:
    log.info("backup_skipped", reason="handled by Supabase automatic backups")


async def daily_report() -> None:
    """Resumen diario — se implementará cuando haya volumen de trades."""
    from src.core.db import get_db
    db = get_db()
    today_trades = await db.select("trades")  # TODO: filter por hoy
    log.info("daily_report", trades_total=len(today_trades))


async def weekly_review() -> None:
    log.info("weekly_review", note="placeholder — add LLM narrative later")
