"""
Auto-analyzer: corre análisis de patrones para cada símbolo del universo
y crea triggers automáticamente cuando detecta condiciones WATCH.

Corre cada 15 min. Para cada símbolo:
1. Obtiene velas recientes
2. Corre detección de patrones (triángulos, FVG, rechazo, RSI, tendencia)
3. Si detecta pattern en formación con trigger claro → inserta en pattern_triggers
4. Evita duplicados (no crea trigger si ya hay uno activo para el mismo patrón/símbolo)
5. El trigger_monitor existente se encarga de verificar y ejecutar

También corre detección de patrones chartistas (double top/bottom, H&S, flag, wedge)
y los persiste como triggers con sus niveles calculados.
"""
import uuid
from datetime import datetime, timezone
import numpy as np
import structlog

log = structlog.get_logger()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    result = [values[0]]
    k = 2 / (period + 1)
    for i in range(1, len(values)):
        result.append(values[i] * k + result[-1] * (1 - k))
    return result


def _atr(candles: list[dict], period: int = 14) -> float:
    if len(candles) < period + 1:
        return 0.0
    trs = []
    for i in range(1, len(candles)):
        h = float(candles[i]["high"])
        l = float(candles[i]["low"])
        pc = float(candles[i - 1]["close"])
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if not trs:
        return 0.0
    return float(np.mean(trs[-period:]))


def _detect_pivots(candles: list[dict], lookback: int = 3):
    """Encuentra pivot highs y lows."""
    highs = []
    lows = []
    for i in range(lookback, len(candles) - lookback):
        is_high = all(float(candles[i]["high"]) >= float(candles[j]["high"])
                      for j in range(i - lookback, i + lookback + 1) if j != i)
        is_low = all(float(candles[i]["low"]) <= float(candles[j]["low"])
                     for j in range(i - lookback, i + lookback + 1) if j != i)
        if is_high:
            highs.append({"idx": i, "price": float(candles[i]["high"]), "ts": candles[i]["ts"]})
        if is_low:
            lows.append({"idx": i, "price": float(candles[i]["low"]), "ts": candles[i]["ts"]})
    return highs, lows


async def run_auto_analyzer() -> None:
    """Job principal: analiza todos los símbolos de todos los pools."""
    from src.core.db import get_db
    from src.core.config import DBConfig

    db = get_db()
    cfg = DBConfig(db)
    await cfg.refresh()

    # Recolectar todos los símbolos únicos
    all_symbols = set()
    symbol_config = {}  # symbol → {pool, timeframe, ...}
    for pool_name in cfg.enabled_pools():
        pool_cfg = cfg.pool(pool_name)
        tf = pool_cfg.get("timeframe", "1h")
        for sym in pool_cfg.get("universe", []):
            if sym not in all_symbols:
                all_symbols.add(sym)
                symbol_config[sym] = {"pool": pool_name, "timeframe": tf}

    if not all_symbols:
        return

    # Triggers activos actuales (para evitar duplicados)
    active_triggers = await db.select("pattern_triggers", filters={"status": "watching"})
    active_set = {(t["symbol"], t["pattern_name"]) for t in (active_triggers or [])}

    created_count = 0
    for symbol in all_symbols:
        try:
            sc = symbol_config[symbol]
            count = await _analyze_symbol(db, symbol, sc["timeframe"], sc["pool"], active_set)
            created_count += count
        except Exception as e:
            log.error("auto_analyzer_symbol_failed", symbol=symbol, error=str(e))

    if created_count > 0:
        log.info("auto_analyzer_done", symbols=len(all_symbols), triggers_created=created_count)


async def _analyze_symbol(db, symbol: str, timeframe: str, pool: str,
                          active_set: set) -> int:
    """Analiza un símbolo y crea triggers si corresponde. Retorna cantidad creada."""

    # Obtener velas
    candles = await db.select(
        "ohlcv",
        filters={"symbol": symbol, "timeframe": timeframe},
        order_by="-ts",
        limit=100,
    )
    if not candles or len(candles) < 30:
        return 0

    candles_asc = sorted(candles, key=lambda c: c["ts"])
    closes = [float(c["close"]) for c in candles_asc]
    price = closes[-1]
    if price <= 0:
        return 0

    # Indicadores
    rsi_val = _rsi(closes, 14)
    atr_val = _atr(candles_asc, 14)
    atr_pct = (atr_val / price) * 100 if price > 0 else 0
    ema9 = _ema(closes, 9)[-1]
    ema21 = _ema(closes, 21)[-1]
    ema50 = _ema(closes, 50)[-1] if len(closes) >= 50 else price

    # Volumen promedio
    volumes = [float(c.get("volume", 0)) for c in candles_asc]
    avg_vol = np.mean(volumes[-21:-1]) if len(volumes) >= 21 else np.mean(volumes)
    vol_ratio = volumes[-1] / avg_vol if avg_vol > 0 else 1.0

    # ——————————————————————————————————————————
    # 0. MULTI-TIMEFRAME CONFIRMATION
    # ——————————————————————————————————————————
    # Determinar tendencia del timeframe superior para filtrar señales
    htf_map = {"1m": "15m", "5m": "1h", "15m": "1h", "1h": "4h", "4h": "1d"}
    htf = htf_map.get(timeframe)
    htf_bias = "neutral"  # "bullish", "bearish", "neutral"

    if htf:
        htf_candles = await db.select(
            "ohlcv",
            filters={"symbol": symbol, "timeframe": htf},
            order_by="-ts",
            limit=60,
        )
        if htf_candles and len(htf_candles) >= 50:
            htf_asc = sorted(htf_candles, key=lambda c: c["ts"])
            htf_closes = [float(c["close"]) for c in htf_asc]
            htf_ema21 = _ema(htf_closes, 21)[-1]
            htf_ema50 = _ema(htf_closes, 50)[-1]
            htf_price = htf_closes[-1]
            if htf_price > htf_ema21 > htf_ema50:
                htf_bias = "bullish"
            elif htf_price < htf_ema21 < htf_ema50:
                htf_bias = "bearish"

    created = 0

    # ——————————————————————————————————————————
    # 1. TRIÁNGULOS
    # ——————————————————————————————————————————
    pivot_highs, pivot_lows = _detect_pivots(candles_asc, 3)
    if len(pivot_highs) >= 2 and len(pivot_lows) >= 2:
        ph = pivot_highs[-3:]
        pl = pivot_lows[-3:]

        if len(ph) >= 2 and len(pl) >= 2:
            highs_desc = ph[-1]["price"] < ph[-2]["price"]
            lows_asc = pl[-1]["price"] > pl[-2]["price"]
            highs_flat = abs(ph[-1]["price"] - ph[-2]["price"]) / ph[-2]["price"] < 0.003
            lows_flat = abs(pl[-1]["price"] - pl[-2]["price"]) / pl[-2]["price"] < 0.003

            pattern_name = None
            bias = "bullish"
            trigger_price = None

            if highs_flat and lows_asc:
                pattern_name = "Triángulo Ascendente"
                trigger_price = ph[-1]["price"]
                bias = "bullish"
            elif highs_desc and lows_flat:
                pattern_name = "Triángulo Descendente"
                trigger_price = pl[-1]["price"]
                bias = "bearish"
            elif highs_desc and lows_asc:
                pattern_name = "Triángulo Simétrico"
                trigger_price = ph[-1]["price"]
                bias = "bullish" if ema9 > ema21 else "bearish"

            if pattern_name and trigger_price and (symbol, pattern_name) not in active_set:
                if not (price > trigger_price if bias == "bullish" else price < trigger_price):
                    # Patrón en formación, no confirmado aún → crear trigger
                    trigger_type = "breakout_above" if bias == "bullish" else "breakout_below"
                    conf_rule = (f"Cierre {'por encima' if bias == 'bullish' else 'por debajo'} "
                                 f"de {trigger_price:.2f} con volumen > promedio")
                    await _create_trigger(db, symbol, timeframe, pattern_name, bias,
                                          conf_rule, trigger_type, trigger_price, None, pool, atr_val,
                                          htf_bias=htf_bias)
                    active_set.add((symbol, pattern_name))
                    created += 1

    # ——————————————————————————————————————————
    # 2. RSI EXTREMOS
    # ——————————————————————————————————————————
    if rsi_val < 25 and (symbol, "RSI Sobreventa") not in active_set:
        await _create_trigger(db, symbol, timeframe, "RSI Sobreventa", "bullish",
                              "RSI cruza arriba de 30 para confirmar reversión",
                              "rsi_cross_above", None, 30, pool, atr_val, htf_bias=htf_bias)
        active_set.add((symbol, "RSI Sobreventa"))
        created += 1

    if rsi_val > 75 and (symbol, "RSI Sobrecompra") not in active_set:
        await _create_trigger(db, symbol, timeframe, "RSI Sobrecompra", "bearish",
                              "RSI cruza abajo de 70 para confirmar corrección",
                              "rsi_cross_below", None, 70, pool, atr_val, htf_bias=htf_bias)
        active_set.add((symbol, "RSI Sobrecompra"))
        created += 1

    # ——————————————————————————————————————————
    # 3. DOBLE TECHO / PISO
    # ——————————————————————————————————————————
    if len(pivot_highs) >= 2:
        for i in range(len(pivot_highs) - 1):
            top1 = pivot_highs[i]
            top2 = pivot_highs[i + 1]
            diff_pct = abs(top1["price"] - top2["price"]) / max(top1["price"], top2["price"]) * 100
            if diff_pct < 1.5 and top2["idx"] - top1["idx"] >= 5:
                # Encontrar neckline
                valley = min(float(candles_asc[j]["low"]) for j in range(top1["idx"] + 1, top2["idx"]))
                if price > valley and (symbol, "Doble Techo") not in active_set:
                    await _create_trigger(db, symbol, timeframe, "Doble Techo", "bearish",
                                          f"Cierre por debajo de neckline {valley:.2f}",
                                          "breakout_below", valley, None, pool, atr_val, htf_bias=htf_bias)
                    active_set.add((symbol, "Doble Techo"))
                    created += 1
                break

    if len(pivot_lows) >= 2:
        for i in range(len(pivot_lows) - 1):
            bot1 = pivot_lows[i]
            bot2 = pivot_lows[i + 1]
            diff_pct = abs(bot1["price"] - bot2["price"]) / max(bot1["price"], bot2["price"]) * 100
            if diff_pct < 1.5 and bot2["idx"] - bot1["idx"] >= 5:
                peak = max(float(candles_asc[j]["high"]) for j in range(bot1["idx"] + 1, bot2["idx"]))
                if price < peak and (symbol, "Doble Piso") not in active_set:
                    await _create_trigger(db, symbol, timeframe, "Doble Piso", "bullish",
                                          f"Cierre por encima de neckline {peak:.2f}",
                                          "breakout_above", peak, None, pool, atr_val, htf_bias=htf_bias)
                    active_set.add((symbol, "Doble Piso"))
                    created += 1
                break

    # ——————————————————————————————————————————
    # 4. BANDERA (impulso fuerte + consolidación)
    # ——————————————————————————————————————————
    n = len(candles_asc)
    for pole_end in range(n - 8, max(n - 20, 10), -1):
        for pole_start in range(pole_end - 5, max(pole_end - 15, 0), -1):
            pole_h = float(candles_asc[pole_end]["high"]) - float(candles_asc[pole_start]["low"])
            pole_pct = pole_h / float(candles_asc[pole_start]["low"]) * 100
            if pole_pct < 2 or pole_end - pole_start < 3:
                continue

            flag_candles = candles_asc[pole_end:]
            if len(flag_candles) < 3:
                continue

            flag_max = max(float(c["high"]) for c in flag_candles)
            flag_min = min(float(c["low"]) for c in flag_candles)
            flag_range_pct = (flag_max - flag_min) / flag_max * 100

            if flag_range_pct > pole_pct * 0.6:
                continue

            retrace = (float(candles_asc[pole_end]["high"]) - flag_min) / pole_h
            if retrace > 0.5:
                continue

            if (symbol, "Bandera Alcista") not in active_set:
                breakout_level = flag_max
                if price < breakout_level:
                    await _create_trigger(db, symbol, timeframe, "Bandera Alcista", "bullish",
                                          f"Cierre por encima de {breakout_level:.2f} (techo del flag)",
                                          "breakout_above", breakout_level, None, pool, atr_val,
                                          target_mult=pole_pct / (atr_val / price * 100) if atr_val > 0 else 4.0,
                                          htf_bias=htf_bias)
                    active_set.add((symbol, "Bandera Alcista"))
                    created += 1
            break
        else:
            continue
        break

    # ——————————————————————————————————————————
    # 5. HEAD & SHOULDERS (via engine detector)
    # ——————————————————————————————————————————
    try:
        import pandas as _pd
        df = _pd.DataFrame(candles_asc)
        for col in ("open", "high", "low", "close", "volume"):
            if col in df.columns:
                df[col] = _pd.to_numeric(df[col])

        from src.patterns.detector import detect_head_shoulders, detect_wedges, detect_flags

        for hs in detect_head_shoulders(df):
            name = "HCH Invertido" if hs.kind == "inverse_head_shoulders" else "Hombro-Cabeza-Hombro"
            bias = "bullish" if hs.kind == "inverse_head_shoulders" else "bearish"
            if (symbol, name) not in active_set and not hs.confirmed:
                ttype = "breakout_above" if bias == "bullish" else "breakout_below"
                await _create_trigger(db, symbol, timeframe, name, bias,
                                      f"Cierre {'por encima' if bias == 'bullish' else 'por debajo'} de neckline {hs.neckline:.2f}",
                                      ttype, hs.neckline, None, pool, atr_val, htf_bias=htf_bias)
                active_set.add((symbol, name))
                created += 1

        # 6. WEDGE
        for w in detect_wedges(df):
            name = "Cuña Ascendente" if w.kind == "rising_wedge" else "Cuña Descendente"
            bias = "bearish" if w.kind == "rising_wedge" else "bullish"
            if (symbol, name) not in active_set and not w.confirmed:
                ttype = "breakout_below" if w.kind == "rising_wedge" else "breakout_above"
                await _create_trigger(db, symbol, timeframe, name, bias,
                                      f"Cierre {'por debajo' if w.kind == 'rising_wedge' else 'por encima'} de {w.breakout_level:.2f}",
                                      ttype, w.breakout_level, None, pool, atr_val, htf_bias=htf_bias)
                active_set.add((symbol, name))
                created += 1

    except Exception as e:
        log.warning("auto_analyzer_advanced_patterns_error", symbol=symbol, error=str(e))

    return created


async def _create_trigger(db, symbol: str, timeframe: str, pattern_name: str,
                          bias: str, conf_rule: str, trigger_type: str,
                          trigger_price: float | None, trigger_rsi: float | None,
                          pool: str, atr_val: float,
                          stop_mult: float = 2.0, target_mult: float = 4.0,
                          htf_bias: str = "neutral") -> None:
    """Inserta un trigger en la DB con expiración de 24h.
    Multi-timeframe filter: no crea trigger si el bias contradice el HTF."""

    # MTA filter: no operar contra la tendencia del timeframe superior
    if htf_bias == "bearish" and bias == "bullish":
        log.info("mta_filter_skip", symbol=symbol, pattern=pattern_name,
                 reason="bullish trigger filtered — HTF bearish")
        return
    if htf_bias == "bullish" and bias == "bearish":
        log.info("mta_filter_skip", symbol=symbol, pattern=pattern_name,
                 reason="bearish trigger filtered — HTF bullish")
        return

    trigger = {
        "symbol": symbol,
        "timeframe": timeframe,
        "pattern_name": pattern_name,
        "bias": bias,
        "confirmation_rule": conf_rule,
        "trigger_type": trigger_type,
        "trigger_price": trigger_price,
        "trigger_rsi": trigger_rsi,
        "require_volume": True,
        "action": "BUY" if bias == "bullish" else "ALERT_ONLY",
        "pool": pool,
        "max_capital_usd": 25,
        "stop_atr_mult": stop_mult,
        "target_atr_mult": target_mult,
        "status": "watching",
        "expires_at": datetime.fromtimestamp(
            datetime.now(timezone.utc).timestamp() + 24 * 3600,
            tz=timezone.utc
        ).isoformat(),
        "created_by": "auto_analyzer",
    }

    await db.insert("pattern_triggers", trigger)
    log.info("auto_trigger_created",
             symbol=symbol, pattern=pattern_name, bias=bias,
             trigger_type=trigger_type,
             trigger_price=trigger_price, trigger_rsi=trigger_rsi)
