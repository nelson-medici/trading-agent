"""
ICT Silver Bullet Strategy.

Precisión sobre frecuencia: opera solo en ventanas de 1 hora donde la
liquidez institucional genera movimientos predecibles.

Reglas (basadas en ICT/Inner Circle Trader):

1. VENTANAS (hora New York):
   - London:  03:00-04:00 NY (08:00-09:00 UTC std / 07:00-08:00 UTC DST)
   - NY AM:   10:00-11:00 NY (15:00-16:00 UTC std / 14:00-15:00 UTC DST) ← principal
   - NY PM:   14:00-15:00 NY (19:00-20:00 UTC std / 18:00-19:00 UTC DST)

2. BIAS (dirección):
   - Determinado por el HTF (4h/1h): precio vs SMA50, estructura HH/HL vs LH/LL
   - Solo operar en la dirección del bias

3. SECUENCIA DE ENTRADA (dentro de la ventana):
   a) Liquidity sweep: precio rompe un swing high/low reciente (trampa)
   b) Displacement: movimiento rápido en la dirección opuesta al sweep
      (velas grandes, cuerpo > 60% del rango, consecutivas en misma dirección)
   c) Fair Value Gap (FVG): imbalance de 3 velas dejado por el displacement
   d) Retrace: precio vuelve al FVG
   e) Entry: limit order en el FVG, en la dirección del bias

4. STOP: debajo del swing del sweep (el mínimo/máximo de la trampa)
5. TARGET: siguiente pool de liquidez (swing high/low previo), mínimo 2R
6. TIMEFRAME: detección en 5m, confirmación en 1m

Aplica a: cripto (BTC, ETH, SOL, etc.) y equities (SPY, QQQ, etc.)
"""
from datetime import datetime, timezone
import numpy as np
import pandas as pd
from src.strategies.base import Strategy, StrategySignal

# Silver Bullet windows in UTC (standard time — Nov-Mar)
# During DST (Mar-Nov), subtract 1 hour
WINDOWS_UTC_STD = [
    {"name": "london", "start": 8, "end": 9},
    {"name": "ny_am", "start": 15, "end": 16},
    {"name": "ny_pm", "start": 19, "end": 20},
]

WINDOWS_UTC_DST = [
    {"name": "london", "start": 7, "end": 8},
    {"name": "ny_am", "start": 14, "end": 15},
    {"name": "ny_pm", "start": 18, "end": 19},
]


def _is_dst() -> bool:
    """Check if US is currently in daylight saving time."""
    now = datetime.now(timezone.utc)
    # DST in US: second Sunday of March to first Sunday of November
    month = now.month
    return 3 < month < 11 or (month == 3 and now.day > 14) or (month == 11 and now.day < 7)


def _get_windows() -> list[dict]:
    return WINDOWS_UTC_DST if _is_dst() else WINDOWS_UTC_STD


def _in_silver_bullet_window(hour: int) -> dict | None:
    """Returns the window dict if hour is in a Silver Bullet window, else None."""
    for w in _get_windows():
        if w["start"] <= hour < w["end"]:
            return w
    return None


def _detect_fvg(df: pd.DataFrame, direction: str = "bullish") -> list[dict]:
    """
    Detect Fair Value Gaps (3-candle imbalances).

    Bullish FVG: candle[i-2].high < candle[i].low (gap up)
    Bearish FVG: candle[i-2].low > candle[i].high (gap down)

    Returns list of FVGs with midpoint (consequent encroachment).
    """
    fvgs = []
    if len(df) < 3:
        return fvgs

    highs = df["high"].values
    lows = df["low"].values
    closes = df["close"].values
    times = df["ts"].values

    for i in range(2, len(df)):
        if direction == "bullish":
            # Gap between candle[i-2] high and candle[i] low
            gap_top = float(lows[i])
            gap_bottom = float(highs[i - 2])
            if gap_top > gap_bottom:
                size = gap_top - gap_bottom
                mid = (gap_top + gap_bottom) / 2
                # Middle candle should be large (displacement)
                mid_body = abs(float(closes[i - 1]) - float(df["open"].iloc[i - 1]))
                mid_range = float(highs[i - 1]) - float(lows[i - 1])
                body_ratio = mid_body / mid_range if mid_range > 0 else 0

                if body_ratio > 0.5:  # displacement candle has large body
                    fvgs.append({
                        "direction": "bullish",
                        "top": gap_top,
                        "bottom": gap_bottom,
                        "midpoint": mid,
                        "size": size,
                        "time": times[i - 1],
                        "index": i - 1,
                        "body_ratio": body_ratio,
                    })

        elif direction == "bearish":
            gap_top = float(lows[i - 2])
            gap_bottom = float(highs[i])
            if gap_top > gap_bottom:
                size = gap_top - gap_bottom
                mid = (gap_top + gap_bottom) / 2
                mid_body = abs(float(closes[i - 1]) - float(df["open"].iloc[i - 1]))
                mid_range = float(highs[i - 1]) - float(lows[i - 1])
                body_ratio = mid_body / mid_range if mid_range > 0 else 0

                if body_ratio > 0.5:
                    fvgs.append({
                        "direction": "bearish",
                        "top": gap_top,
                        "bottom": gap_bottom,
                        "midpoint": mid,
                        "size": size,
                        "time": times[i - 1],
                        "index": i - 1,
                        "body_ratio": body_ratio,
                    })

    return fvgs


def _detect_liquidity_sweep(df: pd.DataFrame, lookback: int = 20) -> dict | None:
    """
    Detect if price swept a recent swing high/low and reversed.
    A sweep = wick beyond the level but close back inside.
    """
    if len(df) < lookback + 3:
        return None

    recent = df.iloc[-lookback:-1]
    last = df.iloc[-1]

    # Check for high sweep (price spiked above recent highs then closed below)
    recent_high = float(recent["high"].max())
    if float(last["high"]) > recent_high and float(last["close"]) < recent_high:
        return {
            "type": "high_sweep",
            "level": recent_high,
            "wick": float(last["high"]),
            "close": float(last["close"]),
            "bias_after": "bearish",  # swept highs → expect down
        }

    # Check for low sweep (price spiked below recent lows then closed above)
    recent_low = float(recent["low"].min())
    if float(last["low"]) < recent_low and float(last["close"]) > recent_low:
        return {
            "type": "low_sweep",
            "level": recent_low,
            "wick": float(last["low"]),
            "close": float(last["close"]),
            "bias_after": "bullish",  # swept lows → expect up
        }

    return None


def _detect_displacement(df: pd.DataFrame, min_candles: int = 2) -> dict | None:
    """
    Detect displacement: consecutive large-body candles in one direction.
    Returns the direction and strength of displacement.
    """
    if len(df) < min_candles + 1:
        return None

    tail = df.iloc[-min_candles - 1:]
    atr = float((tail["high"] - tail["low"]).mean())

    # Check last N candles for consecutive directional move
    bullish_count = 0
    bearish_count = 0
    total_body = 0

    for i in range(-min_candles, 0):
        c = df.iloc[i]
        body = float(c["close"]) - float(c["open"])
        rng = float(c["high"]) - float(c["low"])
        body_ratio = abs(body) / rng if rng > 0 else 0

        if body > 0 and body_ratio > 0.5:
            bullish_count += 1
            total_body += body
        elif body < 0 and body_ratio > 0.5:
            bearish_count += 1
            total_body += body

    if bullish_count >= min_candles:
        return {"direction": "bullish", "strength": abs(total_body) / atr if atr > 0 else 0}
    if bearish_count >= min_candles:
        return {"direction": "bearish", "strength": abs(total_body) / atr if atr > 0 else 0}

    return None


class SilverBulletStrategy(Strategy):
    name = "silver_bullet"

    DEFAULTS = {
        "min_fvg_atr_ratio": 0.3,     # FVG must be at least 30% of ATR
        "max_fvg_atr_ratio": 3.0,     # FVG can't be too wide (exhaustion)
        "sweep_lookback": 20,          # candles to look back for sweep detection
        "displacement_candles": 2,     # minimum consecutive candles for displacement
        "min_rr": 2.0,                 # minimum risk:reward ratio
        "stop_buffer_pct": 0.001,      # buffer beyond sweep wick for stop
        "windows": "all",              # "all", "ny_am", "london", "ny_pm"
        "htf_bias_period": 50,         # SMA period for higher-timeframe bias
    }

    def __init__(self, params: dict | None = None):
        merged = {**self.DEFAULTS, **(params or {})}
        super().__init__(merged)

    def evaluate(self, df: pd.DataFrame, symbol: str) -> StrategySignal:
        """
        Evaluate Silver Bullet setup on 5m candles.
        The last candle must be inside a Silver Bullet window.
        """
        p = self.params
        if len(df) < 100:
            return self.no_signal(symbol, "insufficient data (<100 candles)")

        df = df.sort_values("ts").reset_index(drop=True).copy()
        df["ts"] = pd.to_datetime(df["ts"])

        last = df.iloc[-1]
        now_utc = last["ts"]
        hour = now_utc.hour

        # 1. Check if we're in a Silver Bullet window
        window = _in_silver_bullet_window(hour)
        if window is None:
            return self.no_signal(symbol, f"fuera de ventana Silver Bullet (hora UTC {hour})")

        if p["windows"] != "all" and window["name"] != p["windows"]:
            return self.no_signal(symbol, f"ventana {window['name']} no seleccionada")

        # 2. Determine HTF bias
        closes = df["close"].astype(float)
        sma = closes.rolling(p["htf_bias_period"]).mean()
        price = float(last["close"])
        sma_val = float(sma.iloc[-1]) if not pd.isna(sma.iloc[-1]) else price

        # Structure bias: last 20 candles trend
        recent_20 = df.iloc[-20:]
        higher_highs = sum(1 for i in range(1, len(recent_20))
                          if float(recent_20.iloc[i]["high"]) > float(recent_20.iloc[i-1]["high"]))
        higher_lows = sum(1 for i in range(1, len(recent_20))
                         if float(recent_20.iloc[i]["low"]) > float(recent_20.iloc[i-1]["low"]))

        htf_bias = "bullish" if (price > sma_val and higher_highs > 10) else \
                   "bearish" if (price < sma_val and higher_lows < 8) else "neutral"

        if htf_bias == "neutral":
            return self.no_signal(symbol, "sin bias HTF claro (SMA + estructura)")

        # 3. Get candles within this window (last ~12 candles for 5m in 1h window)
        window_start_hour = window["start"]
        window_candles = df[df["ts"].dt.hour == window_start_hour]
        if len(window_candles) < 3:
            # Also include recent candles from pre-window for context
            window_candles = df.iloc[-15:]

        # 4. Detect liquidity sweep
        sweep = _detect_liquidity_sweep(df, p["sweep_lookback"])

        # 5. Detect displacement
        displacement = _detect_displacement(df, p["displacement_candles"])

        # 6. Detect FVG in the bias direction
        fvg_direction = htf_bias
        fvgs = _detect_fvg(df.iloc[-20:], fvg_direction)

        # ATR for sizing
        atr = float((df["high"].astype(float) - df["low"].astype(float)).iloc[-20:].mean())

        # Filter FVGs by size
        valid_fvgs = [
            f for f in fvgs
            if f["size"] >= p["min_fvg_atr_ratio"] * atr
            and f["size"] <= p["max_fvg_atr_ratio"] * atr
        ]

        if not valid_fvgs:
            return self.no_signal(symbol, f"sin FVG válido en dirección {htf_bias}")

        # 7. Check if price is retracing into FVG (or near it)
        best_fvg = valid_fvgs[-1]  # most recent

        # Price should be near or inside the FVG
        if htf_bias == "bullish":
            # Price should be at or below FVG top (retracing down into the gap)
            if price > best_fvg["top"] * 1.002:  # allow 0.2% tolerance
                return self.no_signal(symbol, "precio por encima del FVG, no hay retrace")

            entry = best_fvg["midpoint"]  # entry at midpoint (consequent encroachment)

            # Stop: below the sweep low or below FVG bottom
            if sweep and sweep["bias_after"] == "bullish":
                stop = float(sweep["wick"]) * (1 - p["stop_buffer_pct"])
            else:
                stop = best_fvg["bottom"] * (1 - p["stop_buffer_pct"])

            # Target: next resistance (recent swing high above)
            remaining = df[df["high"].astype(float) > price].iloc[-30:]
            if len(remaining) > 0:
                target = float(remaining["high"].max())
            else:
                target = entry + (entry - stop) * p["min_rr"]

        else:  # bearish
            if price < best_fvg["bottom"] * 0.998:
                return self.no_signal(symbol, "precio por debajo del FVG, no hay retrace")

            entry = best_fvg["midpoint"]

            if sweep and sweep["bias_after"] == "bearish":
                stop = float(sweep["wick"]) * (1 + p["stop_buffer_pct"])
            else:
                stop = best_fvg["top"] * (1 + p["stop_buffer_pct"])

            remaining = df[df["low"].astype(float) < price].iloc[-30:]
            if len(remaining) > 0:
                target = float(remaining["low"].min())
            else:
                target = entry - (stop - entry) * p["min_rr"]

        # 8. Check R:R
        risk = abs(entry - stop)
        reward = abs(target - entry)
        rr = reward / risk if risk > 0 else 0

        if rr < p["min_rr"]:
            return self.no_signal(symbol, f"R:R {rr:.1f} < {p['min_rr']} mínimo")

        # 9. Confidence scoring
        confidence = 50  # base

        # Sweep detected → +15
        if sweep and sweep["bias_after"] == htf_bias:
            confidence += 15

        # Displacement in bias direction → +15
        if displacement and displacement["direction"] == htf_bias:
            confidence += 10 + min(5, displacement["strength"] * 2)

        # FVG quality → +10
        if best_fvg["body_ratio"] > 0.7:
            confidence += 10

        # HTF alignment strong → +10
        if htf_bias == "bullish" and price > sma_val * 1.005:
            confidence += 10
        elif htf_bias == "bearish" and price < sma_val * 0.995:
            confidence += 10

        # R:R bonus → +5
        if rr >= 3.0:
            confidence += 5

        confidence = min(95, confidence)

        action = "BUY" if htf_bias == "bullish" else "SELL"

        parts = []
        parts.append(f"Silver Bullet {window['name'].upper()}")
        parts.append(f"bias {htf_bias}")
        if sweep:
            parts.append(f"sweep {sweep['type']}")
        if displacement:
            parts.append(f"displacement {displacement['direction']} ({displacement['strength']:.1f}x)")
        parts.append(f"FVG {best_fvg['direction']} @{best_fvg['midpoint']:.6g}")
        parts.append(f"R:R {rr:.1f}:1")

        return StrategySignal(
            strategy_name=self.name,
            symbol=symbol,
            ts=now_utc.isoformat(),
            action=action,
            confidence=confidence,
            entry_price=entry,
            stop_price=stop,
            target_price=target,
            reasoning=" · ".join(parts),
            metadata={
                "window": window["name"],
                "htf_bias": htf_bias,
                "sweep": sweep,
                "displacement": displacement,
                "fvg": {k: v for k, v in best_fvg.items() if k != "time"},
                "rr": rr,
                "atr": atr,
            },
        )
