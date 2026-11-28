"""
Jobs del scheduler.
Cada job es idempotente y loggea su estado.
Soporta múltiples pools (core, tactical) con config aislada.
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
    """
    Ingesta OHLCV routeada por asset_class:
    - crypto (default): CCXT/Binance
    - equities: Yahoo Finance
    """
    from src.data.market_crypto import CryptoMarketData
    from src.data.market_equities import EquitiesMarketData
    from src.core.db import get_db
    from src.core.config import DBConfig

    db = get_db()
    cfg = DBConfig(db)
    await cfg.refresh()

    # Agrupar universos por asset_class
    crypto_symbols = set()
    equities_symbols = set()
    timeframes_crypto = set()
    timeframes_equities = set()

    for pool_name in cfg.enabled_pools():
        pool_cfg = cfg.pool(pool_name)
        symbols = pool_cfg.get("universe", [])
        tf = pool_cfg.get("timeframe", "1h")
        additional_tfs = pool_cfg.get("additional_timeframes", [])
        asset_class = pool_cfg.get("asset_class", "crypto")
        all_tfs = {tf, *additional_tfs}
        if asset_class == "equities":
            equities_symbols.update(symbols)
            timeframes_equities.update(all_tfs)
        else:
            crypto_symbols.update(symbols)
            timeframes_crypto.update(all_tfs)

    # Crypto
    if crypto_symbols:
        md = CryptoMarketData()
        try:
            total = 0
            for tf in timeframes_crypto:
                total += await md.ingest_universe(sorted(crypto_symbols), timeframe=tf, limit=500)
            log.info("crypto_ingested", total=total, symbols=len(crypto_symbols), timeframes=list(timeframes_crypto))
        finally:
            await md.close()

    # Equities
    if equities_symbols:
        md = EquitiesMarketData()
        try:
            total = 0
            for tf in timeframes_equities:
                total += await md.ingest_universe(sorted(equities_symbols), timeframe=tf, lookback_days=60)
            log.info("equities_ingested_total", total=total, symbols=len(equities_symbols), timeframes=list(timeframes_equities))
        finally:
            await md.close()


async def ingest_news() -> None:
    log.info("ingest_news_skipped", reason="no news source configured")


# ============================================================
# FEATURES + SCORING
# ============================================================

async def compute_features_and_score() -> None:
    """
    Corre scoring para todos los pools habilitados, cada uno con su universo
    y su config.
    """
    from src.core.db import get_db
    from src.core.config import DBConfig

    db = get_db()
    cfg = DBConfig(db)
    await cfg.refresh()

    for pool_name in cfg.enabled_pools():
        await _score_pool(pool_name, cfg)


async def _score_pool(pool_name: str, cfg) -> None:
    """Scoring para un pool específico."""
    from src.core.db import get_db
    from src.features.technical import compute_technical_features
    from src.features.regime import detect_regime
    from src.scoring.components import compute_all_components
    from src.scoring.aggregator import aggregate
    from src.scoring.state_machine import transition
    from src.scoring.confidence import evaluate_high_confidence
    from src.risk.stops import compute_stop_target, compute_rr_ratio
    from src.data.market_crypto import CryptoMarketData

    db = get_db()
    pool_cfg = cfg.pool(pool_name)
    universe = pool_cfg.get("universe", [])
    weights = pool_cfg.get("weights", {})
    thresholds = pool_cfg.get("thresholds", {})
    stops_cfg = pool_cfg.get("stops", {})
    confidence_cfg = cfg.confidence
    timeframe = pool_cfg.get("timeframe", "1h")

    if not universe:
        log.warning("pool_empty_universe", pool=pool_name)
        return

    # Régimen (compartido, usa BTC daily)
    btc_rows = await db.select(
        "ohlcv",
        filters={"symbol": "BTC/USDT", "timeframe": "1h"},
        order_by="-ts",
        limit=50 * 24,
    )
    btc_above_sma50 = False
    if len(btc_rows) >= 50:
        btc_df = pd.DataFrame(btc_rows)
        btc_df["close"] = pd.to_numeric(btc_df["close"])
        btc_df = btc_df.sort_values("ts")
        btc_daily = btc_df.iloc[::24].reset_index(drop=True)
        if len(btc_daily) >= 50:
            sma50 = btc_daily["close"].tail(50).mean()
            current = btc_daily["close"].iloc[-1]
            btc_above_sma50 = bool(current > sma50)

    regime_data = await detect_regime(btc_above_sma50=btc_above_sma50)

    # Spreads actuales
    md = CryptoMarketData()
    spreads: dict[str, float] = {}
    try:
        for sym in universe:
            try:
                spreads[sym] = await md.bid_ask_spread(sym)
            except Exception:
                spreads[sym] = 0.001
    finally:
        await md.close()

    scored_count = 0

    for symbol in universe:
        try:
            rows = await db.select(
                "ohlcv",
                filters={"symbol": symbol, "timeframe": timeframe},
                order_by="-ts",
                limit=500,
            )
            if len(rows) < 200:
                log.warning("insufficient_ohlcv", symbol=symbol, rows=len(rows), tf=timeframe)
                continue

            df = pd.DataFrame(rows)
            df["ts"] = pd.to_datetime(df["ts"])
            for col in ["open", "high", "low", "close", "volume"]:
                df[col] = pd.to_numeric(df[col])

            features = compute_technical_features(df)
            if not features:
                continue

            features["regime"] = regime_data["regime"]
            features["btc_dominance"] = regime_data["btc_dominance"]
            features["fear_greed"] = regime_data["fear_greed"]
            features["sentiment_score"] = 0.0
            features["news_count_7d"] = 0
            features["bid_ask_spread_pct"] = spreads.get(symbol, 0.001)
            features["volume_24h_usd"] = 500_000_000
            features["has_event_in_48h"] = False

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

            components = compute_all_components(features, is_crypto=True)
            score_total = aggregate(components, weights)

            # Posición abierta en ESTE pool?
            pos_rows = await db.select("positions", filters={"symbol": symbol, "pool": pool_name})
            has_position = len(pos_rows) > 0

            state = transition(
                current_state="IGNORE",
                score=score_total,
                thresholds=thresholds,
                has_open_position=has_position,
            )

            # Stop/target y RR
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

            recent = await db.select(
                "scores",
                ["score_total"],
                filters={"symbol": symbol, "pool": pool_name},
                order_by="-ts",
                limit=3,
            )
            score_history = [r["score_total"] for r in recent]

            # Tactical pool: no requerimos régimen risk_on para confidence
            regime_for_check = features.get("regime", "neutral")
            if not pool_cfg.get("require_risk_on_regime", True):
                regime_for_check = "risk_on"

            confidence_check = evaluate_high_confidence(
                score_total=score_total,
                score_technical=components.technical,
                indicators_aligned=components.indicators_aligned,
                price_above_sma200=features.get("price_above_sma200", False),
                volume_ratio=features.get("volume_ratio", 1),
                market_regime=regime_for_check,
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
                "pool": pool_name,
            })

            scored_count += 1
            log.info("scored", pool=pool_name, symbol=symbol, score=score_total, state=state)

        except Exception as e:
            log.error("scoring_failed", pool=pool_name, symbol=symbol, error=str(e), exc_info=True)

    log.info("pool_scored", pool=pool_name, count=scored_count, regime=regime_data["regime"])


# ============================================================
# DECISIONES
# ============================================================

async def evaluate_decisions() -> None:
    from src.core.db import get_db
    from src.core.config import DBConfig
    db = get_db()
    cfg = DBConfig(db)
    await cfg.refresh()

    for pool_name in cfg.enabled_pools():
        await _evaluate_pool(pool_name, cfg)


async def _evaluate_pool(pool_name: str, cfg) -> None:
    from src.core.db import get_db
    from src.risk.sizing import compute_position_size
    from src.risk.stops import compute_stop_target
    from src.portfolio.manager import PortfolioManager

    db = get_db()
    pool_cfg = cfg.pool(pool_name)
    universe = pool_cfg.get("universe", [])
    risk_limits = pool_cfg.get("risk_limits", {})
    stops_cfg = pool_cfg.get("stops", {})

    portfolio = PortfolioManager()
    equity = await portfolio.current_equity_pool(pool_name)
    if equity <= 0:
        log.warning("no_equity_for_pool", pool=pool_name)
        return

    for symbol in universe:
        try:
            scores = await db.select(
                "scores",
                filters={"symbol": symbol, "pool": pool_name},
                order_by="-ts",
                limit=1,
            )
            if not scores:
                continue
            score = scores[0]

            if score["state"] != "CANDIDATE":
                continue

            # Ya tenemos posición en este pool?
            existing = await db.select("positions", filters={"symbol": symbol, "pool": pool_name})
            if existing:
                continue

            # Decisión reciente?
            recent_decisions = await db.select(
                "decisions",
                filters={"symbol": symbol, "pool": pool_name},
                order_by="-created_at",
                limit=1,
            )
            if recent_decisions:
                last = recent_decisions[0]
                last_ts = pd.to_datetime(last["created_at"])
                hours_since = (datetime.now(timezone.utc) - last_ts).total_seconds() / 3600
                if hours_since < 4 and last["status"] in ("pending", "approved", "executed"):
                    continue

            features = await db.select(
                "features",
                filters={"symbol": symbol},
                order_by="-ts",
                limit=1,
            )
            if not features:
                continue
            feat = features[0]
            atr = float(feat["atr"] or 0)

            tf = pool_cfg.get("timeframe", "1h")
            last_ohlcv = await db.select(
                "ohlcv",
                ["close"],
                filters={"symbol": symbol, "timeframe": tf},
                order_by="-ts",
                limit=1,
            )
            price = float(last_ohlcv[0]["close"]) if last_ohlcv else float(feat["sma_20"] or 0)
            if price <= 0 or atr <= 0:
                continue

            # FVG filter: buscar gaps sin llenar debajo del precio actual
            try:
                from src.patterns.detector import detect_fvg
                candles_for_fvg = await db.select(
                    "ohlcv",
                    filters={"symbol": symbol, "timeframe": tf},
                    order_by="-ts",
                    limit=50,
                )
                if candles_for_fvg and len(candles_for_fvg) >= 5:
                    import pandas as _pd
                    fvg_df = _pd.DataFrame(candles_for_fvg).sort_values("ts").reset_index(drop=True)
                    for c in ("open", "high", "low", "close", "volume"):
                        if c in fvg_df.columns:
                            fvg_df[c] = _pd.to_numeric(fvg_df[c])
                    fvgs = detect_fvg(fvg_df, min_gap_atr=0.3)
                    # Si hay un FVG bullish sin llenar justo debajo del precio (dentro de 1 ATR),
                    # el precio puede retroceder a llenarlo antes de continuar → no entrar
                    unfilled_below = [f for f in fvgs if f.kind == "bullish" and not f.filled
                                      and f.top <= price and (price - f.top) < atr]
                    if unfilled_below:
                        log.info("fvg_filter_skip", pool=pool_name, symbol=symbol,
                                 gap_top=unfilled_below[0].top, gap_bottom=unfilled_below[0].bottom)
                        continue
            except Exception as e:
                log.warning("fvg_filter_error", symbol=symbol, error=str(e))

            stop, target = compute_stop_target(
                price, atr,
                stop_multiplier=stops_cfg.get("atr_stop_multiplier", 2.0),
                target_multiplier=stops_cfg.get("atr_target_multiplier", 4.0),
            )

            is_btc_eth = symbol in ("BTC/USDT", "ETH/USDT")
            # Position % current en este pool
            cur_pos = await portfolio.current_position_pct_pool(symbol, pool_name)

            sizing = compute_position_size(
                equity_usd=equity,
                entry_price=price,
                stop_price=stop,
                target_price=target,
                is_btc_or_eth=is_btc_eth,
                current_position_pct=cur_pos,
                max_risk_per_trade_pct=risk_limits.get("max_risk_per_trade_pct", 0.01),
                max_position_pct=risk_limits.get("max_position_pct", 0.20),
                max_position_btc_eth_pct=risk_limits.get("max_position_btc_eth_pct", 0.30),
                min_position_size_usd=risk_limits.get("min_position_size_usd", 15),
                min_profit_to_commission_ratio=stops_cfg.get("min_profit_to_commission_ratio", 3.0),
            )

            if not sizing.is_viable:
                log.info("sizing_not_viable", pool=pool_name, symbol=symbol, reason=sizing.reason)
                continue

            open_count = len(await db.select("positions", filters={"pool": pool_name}))
            if open_count >= risk_limits.get("max_open_positions", 2):
                continue

            decision = {
                "symbol": symbol,
                "action": "BUY",
                "score": score["score_total"],
                "score_id": score["id"],
                "pool": pool_name,
                "justification": (
                    f"[{pool_name}] Score {score['score_total']:.1f} | "
                    f"Tech {score['score_technical']:.1f} ({score['indicators_aligned']} aligned) | "
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
            log.info("decision_created", pool=pool_name, symbol=symbol, score=score["score_total"], notional=sizing.notional_usd)

            from src.execution.executor import execute_decision
            await execute_decision(inserted, pool_name)

        except Exception as e:
            log.error("decision_eval_failed", pool=pool_name, symbol=symbol, error=str(e), exc_info=True)


# ============================================================
# MONITOREO DE POSICIONES
# ============================================================

async def watch_positions() -> None:
    from src.core.db import get_db
    from src.core.config import DBConfig
    from src.data.market_crypto import CryptoMarketData
    from src.data.market_equities import EquitiesMarketData

    db = get_db()
    cfg = DBConfig(db)
    await cfg.refresh()
    positions = await db.select("positions")
    if not positions:
        return

    # Cache de providers por asset class
    crypto_md = CryptoMarketData()
    equities_md = EquitiesMarketData()

    # Mapeo pool → asset_class
    pool_class: dict[str, str] = {}
    for pname in cfg.enabled_pools():
        pool_class[pname] = cfg.pool(pname).get("asset_class", "crypto")

    try:
        for pos in positions:
            try:
                asset_class = pool_class.get(pos["pool"], "crypto")
                md = equities_md if asset_class == "equities" else crypto_md
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
                }, {"symbol": pos["symbol"], "pool": pos["pool"]})

                # ——————————————————————————————————————
                # TRAILING STOP + PARTIAL TAKE PROFIT
                # ——————————————————————————————————————
                risk = entry - stop  # distancia original de riesgo (1R)
                exit_reason = None

                # 1. Stop loss hit
                if current_price <= stop:
                    exit_reason = "stop"

                # 2. Full target hit
                elif current_price >= target:
                    exit_reason = "target"

                # 3. Partial take profit at +2R (close 50%)
                elif risk > 0 and current_price >= entry + risk * 2:
                    partial_done = pos.get("partial_tp_done", False)
                    if not partial_done:
                        half_size = size * 0.5
                        partial_pnl = (current_price - entry) * half_size
                        commission = half_size * current_price * 0.001
                        # Register partial close as trade
                        await db.insert("trades", {
                            "symbol": pos["symbol"], "side": "LONG",
                            "size_units": half_size,
                            "entry_price": entry, "exit_price": current_price,
                            "entry_at": pos["opened_at"], "exit_at": _utc_now_iso(),
                            "pnl_usd": partial_pnl - commission,
                            "pnl_pct": (current_price - entry) / entry,
                            "commission_usd": commission,
                            "exit_reason": "partial_tp",
                            "pool": pos["pool"], "hold_hours": 0,
                            "strategy_name": "trailing",
                        })
                        # Update position: half size, move stop to breakeven
                        await db.update("positions", {
                            "size_units": size - half_size,
                            "stop_price": entry,  # trailing: stop → breakeven
                            "partial_tp_done": True,
                        }, {"symbol": pos["symbol"], "pool": pos["pool"]})
                        log.info("partial_tp_executed", symbol=pos["symbol"],
                                 pnl=round(partial_pnl, 2), new_stop=entry)
                        await db.insert("alerts", {
                            "level": "info", "category": "position",
                            "title": f"Partial TP {pos['symbol']} +{((current_price-entry)/entry*100):.1f}%",
                            "message": f"Cerró 50% en ${current_price:.2f}. Stop → breakeven ${entry:.2f}",
                            "metadata": {"symbol": pos["symbol"], "pool": pos["pool"]},
                        })

                # 4. Trailing stop: si ya hizo partial, mover stop con el precio
                if not exit_reason and risk > 0 and pos.get("partial_tp_done"):
                    # Trail stop at -1R desde el máximo alcanzado
                    # Usar el current_price como proxy del máximo
                    new_stop = current_price - risk
                    if new_stop > stop:
                        await db.update("positions", {
                            "stop_price": new_stop,
                        }, {"symbol": pos["symbol"], "pool": pos["pool"]})
                        log.debug("trailing_stop_moved", symbol=pos["symbol"],
                                  old_stop=stop, new_stop=new_stop)

                if exit_reason:
                    await _close_paper_position(pos, current_price, exit_reason)

            except Exception as e:
                log.error("watch_position_failed", symbol=pos.get("symbol"), error=str(e))
    finally:
        await crypto_md.close()
        await equities_md.close()


async def _close_paper_position(position: dict, exit_price: float, reason: str) -> None:
    from src.core.db import get_db
    db = get_db()

    symbol = position["symbol"]
    pool_name = position["pool"]
    entry = float(position["entry_price"])
    size = float(position["size_units"])
    opened_at = position["opened_at"]

    pnl_usd = (exit_price - entry) * size
    pnl_pct = (exit_price - entry) / entry
    commission = size * exit_price * 0.001

    opened_dt = pd.to_datetime(opened_at)
    hold_hours = (datetime.now(timezone.utc) - opened_dt).total_seconds() / 3600

    # Qué strategy generó esta posición (via la decision)
    strategy_name = "score_based"
    orders = await db.select("orders", filters={"symbol": symbol, "pool": pool_name}, order_by="-created_at", limit=1)
    if orders and orders[0].get("decision_id"):
        decisions = await db.select("decisions", filters={"id": orders[0]["decision_id"]}, limit=1)
        if decisions:
            just = (decisions[0].get("justification") or "").lower()
            # Extraer strategy name del justification (format: "[strategy_name] ...")
            if just.startswith("["):
                end = just.find("]")
                if end > 1:
                    strategy_name = just[1:end]

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
        "pool": pool_name,
        "strategy_name": strategy_name,
    })

    await db.delete("positions", {"symbol": symbol, "pool": pool_name})

    await db.insert("alerts", {
        "level": "info",
        "category": "trade",
        "title": f"[{pool_name}] {symbol} {reason.upper()}",
        "message": f"PnL: ${pnl_usd:.2f} ({pnl_pct*100:.2f}%) · hold {hold_hours:.1f}h",
        "metadata": {"symbol": symbol, "pool": pool_name, "reason": reason, "pnl_usd": pnl_usd},
    })

    log.info("position_closed", pool=pool_name, symbol=symbol, reason=reason, pnl_usd=pnl_usd)


async def watch_candidates() -> None:
    from src.core.db import get_db
    db = get_db()
    scores = await db.select("scores", filters={"state": "CANDIDATE"}, order_by="-ts", limit=20)
    log.info("watch_candidates", count=len(scores))


# ============================================================
# ÓRDENES
# ============================================================

async def reconcile_orders() -> None:
    from src.core.db import get_db
    db = get_db()
    pending = await db.select("orders", filters={"state": "SUBMITTED"})
    log.info("reconcile_orders", pending=len(pending))


# ============================================================
# EQUITY SNAPSHOTS (por pool)
# ============================================================

async def snapshot_equity() -> None:
    from src.core.db import get_db
    from src.core.config import DBConfig
    db = get_db()
    cfg = DBConfig(db)
    await cfg.refresh()

    for pool_name in cfg.enabled_pools():
        await _snapshot_pool(pool_name)


async def _snapshot_pool(pool_name: str) -> None:
    from src.core.db import get_db
    db = get_db()

    last = await db.select("equity_snapshots", filters={"pool": pool_name}, order_by="-ts", limit=1)
    prev_equity = float(last[0]["total_equity_usd"]) if last else 0.0
    hwm = float(last[0]["high_water_mark"]) if last else 0.0

    cap_events = await db.select("capital_events", ["amount_usd", "event_type"], filters={"pool": pool_name})
    total_deposited = sum(
        float(e["amount_usd"]) * (1 if e["event_type"] == "deposit" else -1)
        for e in cap_events
    )

    positions = await db.select("positions", filters={"pool": pool_name})
    positions_value = 0.0
    unrealized = 0.0
    for p in positions:
        current = float(p.get("current_price") or p["entry_price"])
        positions_value += float(p["size_units"]) * current
        unrealized += float(p.get("unrealized_pnl_usd") or 0)

    trades = await db.select("trades", ["pnl_usd"], filters={"pool": pool_name})
    realized = sum(float(t["pnl_usd"]) for t in trades)

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
        "pool": pool_name,
    })

    log.info("equity_snapshot", pool=pool_name, total=round(total_equity, 2), cash=round(cash, 2), dd=round(dd * 100, 2))


# ============================================================
# SCALPER (sesiones manuales + detector de oportunidades)
# ============================================================

async def run_scalper_tick() -> None:
    """Cada 15 s. No hace nada (1 query) si no hay sesión requested/active."""
    try:
        from src.scalper.runtime import run_tick
        await run_tick()
    except Exception as e:
        log.error("scalper_tick_failed", error=str(e), exc_info=True)


async def detect_scalper_opportunities() -> None:
    """Cada 3 min. Actualiza el radar y alerta si un símbolo está scalpeable."""
    try:
        from src.scalper.runtime import run_scan
        await run_scan()
    except Exception as e:
        log.error("scalper_scan_job_failed", error=str(e), exc_info=True)


async def run_trigger_monitor() -> None:
    """Cada 1 min. Verifica pattern triggers en 'watching' y ejecuta si se confirman."""
    try:
        from src.patterns.trigger_monitor import run_trigger_monitor
        await run_trigger_monitor()
    except Exception as e:
        log.error("trigger_monitor_failed", error=str(e), exc_info=True)


async def run_auto_analyzer() -> None:
    """Cada 15 min. Analiza patrones en todos los símbolos y crea triggers automáticos."""
    try:
        from src.patterns.auto_analyzer import run_auto_analyzer
        await run_auto_analyzer()
    except Exception as e:
        log.error("auto_analyzer_failed", error=str(e), exc_info=True)


# ============================================================
# ROLLOVER / BACKUP / REPORTS
# ============================================================

async def evaluate_strategies() -> None:
    """
    Corre todas las estrategias habilitadas sobre todos los símbolos del universo
    del pool asignado. Guarda señales en strategy_signals. Las señales viables
    se convierten en decisiones de ese pool.
    """
    from src.core.db import get_db
    from src.core.config import DBConfig
    from src.strategies.registry import get_strategy
    from src.risk.sizing import compute_position_size
    from src.portfolio.manager import PortfolioManager

    db = get_db()
    cfg = DBConfig(db)
    await cfg.refresh()

    strategies_config = cfg.get("strategies.enabled", {})
    if not strategies_config:
        log.info("no_strategies_enabled")
        return

    portfolio = PortfolioManager()

    for strat_name, strat_cfg in strategies_config.items():
        if not strat_cfg.get("enabled", False):
            continue

        pools = strat_cfg.get("pools", ["tactical"])
        min_conf = strat_cfg.get("min_confidence", 70)
        params = strat_cfg.get("params", {})

        # Permite alias: la clave en config puede ser un nickname, strategy_class
        # apunta al nombre real registrado
        strategy_class_name = strat_cfg.get("strategy_class", strat_name)
        strategy = get_strategy(strategy_class_name, params)
        if strategy is None:
            log.warning("unknown_strategy", name=strategy_class_name, alias=strat_name)
            continue
        # Override del name para que la señal persista con el alias
        strategy.name = strat_name

        for pool_name in pools:
            pool_cfg = cfg.pool(pool_name)
            universe = pool_cfg.get("universe", [])
            timeframe = pool_cfg.get("timeframe", "1h")
            risk_limits = pool_cfg.get("risk_limits", {})
            stops_cfg = pool_cfg.get("stops", {})

            for symbol in universe:
                try:
                    # Las estrategias con EMA200 necesitan >=210 velas; pedimos 500
                    # para tener margen y matchear el límite de ingestión.
                    rows = await db.select(
                        "ohlcv",
                        filters={"symbol": symbol, "timeframe": timeframe},
                        order_by="-ts",
                        limit=500,
                    )
                    if len(rows) < 50:
                        continue
                    df = pd.DataFrame(rows)
                    df["ts"] = pd.to_datetime(df["ts"])
                    for c in ["open", "high", "low", "close", "volume"]:
                        df[c] = pd.to_numeric(df[c])

                    signal = strategy.evaluate(df, symbol)

                    # Guardar la señal (incluso NONE para debug)
                    await db.insert("strategy_signals", {
                        "strategy_name": signal.strategy_name,
                        "symbol": signal.symbol,
                        "pool": pool_name,
                        "ts": signal.ts or _utc_now_iso(),
                        "action": signal.action,
                        "confidence": signal.confidence,
                        "entry_price": signal.entry_price,
                        "stop_price": signal.stop_price,
                        "target_price": signal.target_price,
                        "reasoning": signal.reasoning,
                        "metadata": signal.metadata,
                    })

                    if signal.action != "BUY":
                        continue
                    if signal.confidence < min_conf:
                        log.info("signal_below_confidence", strategy=strat_name, symbol=symbol, conf=signal.confidence)
                        continue

                    # ¿Ya hay posición?
                    if await portfolio.has_open_position(symbol, pool_name):
                        continue

                    equity = await portfolio.current_equity_pool(pool_name)
                    is_btc_eth = symbol in ("BTC/USDT", "ETH/USDT")
                    cur_pct = await portfolio.current_position_pct_pool(symbol, pool_name)

                    sizing = compute_position_size(
                        equity_usd=equity,
                        entry_price=signal.entry_price,
                        stop_price=signal.stop_price,
                        target_price=signal.target_price,
                        is_btc_or_eth=is_btc_eth,
                        current_position_pct=cur_pct,
                        max_risk_per_trade_pct=risk_limits.get("max_risk_per_trade_pct", 0.01),
                        max_position_pct=risk_limits.get("max_position_pct", 0.20),
                        max_position_btc_eth_pct=risk_limits.get("max_position_btc_eth_pct", 0.30),
                        min_position_size_usd=risk_limits.get("min_position_size_usd", 15),
                        min_profit_to_commission_ratio=stops_cfg.get("min_profit_to_commission_ratio", 3.0),
                    )
                    if not sizing.is_viable:
                        continue

                    open_count = len(await db.select("positions", filters={"pool": pool_name}))
                    if open_count >= risk_limits.get("max_open_positions", 2):
                        continue

                    decision = {
                        "symbol": symbol,
                        "action": "BUY",
                        "score": signal.confidence,
                        "pool": pool_name,
                        "justification": f"[{strat_name}] {signal.reasoning}",
                        "risks": [],
                        "stop_price": signal.stop_price,
                        "target_price": signal.target_price,
                        "size_units": sizing.size_units,
                        "notional_usd": sizing.notional_usd,
                        "entry_price": signal.entry_price,
                        "status": "pending",
                        "requires_confirmation": False,
                    }

                    inserted = await db.insert("decisions", decision)
                    log.info("strategy_decision", strategy=strat_name, pool=pool_name, symbol=symbol, conf=signal.confidence)
                    from src.execution.executor import execute_decision
                    await execute_decision(inserted, pool_name)

                except Exception as e:
                    log.error("strategy_eval_failed", strategy=strat_name, symbol=symbol, error=str(e), exc_info=True)


async def process_backtest_queue() -> None:
    """
    Revisa backtest_jobs en estado pending, los ejecuta, guarda resultado,
    y linkea el result_id al job.
    """
    from src.core.db import get_db
    from src.strategies.registry import get_strategy
    from src.backtest.engine import BacktestEngine

    db = get_db()
    pending = await db.select("backtest_jobs", filters={"status": "pending"}, limit=5)
    if not pending:
        return

    for job in pending:
        try:
            await db.update("backtest_jobs",
                {"status": "running", "started_at": _utc_now_iso()},
                {"id": job["id"]})

            strat_name = job["strategy_name"]
            symbol = job["symbol"]
            timeframe = job["timeframe"]
            capital = float(job["initial_capital"])
            risk_pct = float(job["risk_per_trade_pct"])
            params = job.get("params_override") or {}

            strategy = get_strategy(strat_name, params)
            if strategy is None:
                raise ValueError(f"Strategy {strat_name} not found")

            rows = await db.select(
                "ohlcv",
                filters={"symbol": symbol, "timeframe": timeframe},
                order_by="ts",
                limit=5000,
            )
            if len(rows) < 100:
                raise ValueError(f"Insufficient data: {len(rows)} rows")

            df = pd.DataFrame(rows)
            engine = BacktestEngine(initial_capital=capital, risk_per_trade_pct=risk_pct)
            result = engine.run(strategy, df, symbol, timeframe)

            saved = await db.insert("backtest_results", {
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

            await db.update("backtest_jobs",
                {"status": "done", "completed_at": _utc_now_iso(), "result_id": saved["id"]},
                {"id": job["id"]})

            log.info("backtest_job_done", job_id=job["id"], strategy=strat_name, symbol=symbol, trades=result.total_trades)

        except Exception as e:
            await db.update("backtest_jobs",
                {"status": "failed", "completed_at": _utc_now_iso(), "error_message": str(e)},
                {"id": job["id"]})
            log.error("backtest_job_failed", job_id=job["id"], error=str(e), exc_info=True)


async def rollover_daily_dd() -> None: log.info("dd_daily_rollover")
async def rollover_weekly_dd() -> None: log.info("dd_weekly_rollover")
async def backup_db() -> None: log.info("backup_skipped")

async def daily_report() -> None:
    from src.core.db import get_db
    db = get_db()
    trades = await db.select("trades")
    log.info("daily_report", trades_total=len(trades))

async def weekly_review() -> None:
    log.info("weekly_review")
