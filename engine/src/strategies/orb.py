"""
ORB Intraday Strategy.

Adaptación del Opening Range Breakout para cripto 24/7.

Reglas:
1. Define "opening range" como [range_start_utc_hour, +range_duration_hours]
   (default: 12:00-16:00 UTC — ventana de solapamiento EU/US con alto volumen)
2. Range high/low = max/min de las velas en esa ventana
3. Después del range, hasta max_entry_hour_utc, cualquier close que rompe
   range_high dispara BUY:
     entry  = close del candle que rompe
     stop   = range_low - (ATR × stop_buffer_atr)
     target = entry + (range_width × target_multiplier)
4. Solo 1 señal por día por símbolo (cuando se dispara se marca el día).
5. Confidence basado en:
   - Volumen del breakout vs promedio (más volumen = más confidence)
   - Qué tan limpio fue el range (menor volatilidad interna = más confidence)
   - Alineación con tendencia de corto (EMA20)
"""
from datetime import datetime, timezone
import pandas as pd
from src.strategies.base import Strategy, StrategySignal


class ORBIntradayStrategy(Strategy):
    name = "orb_intraday"

    DEFAULTS = {
        "range_start_utc_hour": 12,
        "range_duration_hours": 4,
        "max_entry_hour_utc": 22,
        "target_multiplier": 2.0,
        "stop_buffer_atr": 0.5,
        "min_volume_ratio": 1.2,   # breakout candle volume vs 20-SMA del volumen
    }

    def __init__(self, params: dict | None = None):
        merged = {**self.DEFAULTS, **(params or {})}
        super().__init__(merged)

    def evaluate(self, df: pd.DataFrame, symbol: str) -> StrategySignal:
        if len(df) < 50:
            return self.no_signal(symbol, "insufficient data")

        df = df.sort_values("ts").reset_index(drop=True).copy()
        df["ts"] = pd.to_datetime(df["ts"])

        last = df.iloc[-1]
        now_utc = last["ts"]
        if now_utc.tzinfo is None:
            now_utc = now_utc.tz_localize("UTC")

        # Ventana del range del día actual
        range_start_hour = self.params["range_start_utc_hour"]
        range_duration = self.params["range_duration_hours"]
        max_entry_hour = self.params["max_entry_hour_utc"]

        day_start = now_utc.normalize().replace(tzinfo=now_utc.tzinfo)
        range_start = day_start + pd.Timedelta(hours=range_start_hour)
        range_end = range_start + pd.Timedelta(hours=range_duration)

        # El current candle tiene que estar DESPUÉS del range y antes del max_entry
        if now_utc < range_end:
            return self.no_signal(symbol, "aún dentro de opening range")
        if now_utc.hour >= max_entry_hour:
            return self.no_signal(symbol, "fuera de ventana de entry")

        # Extraer velas del opening range del día de hoy
        df_tz = df.copy()
        if df_tz["ts"].dt.tz is None:
            df_tz["ts"] = df_tz["ts"].dt.tz_localize("UTC")

        range_candles = df_tz[(df_tz["ts"] >= range_start) & (df_tz["ts"] < range_end)]
        if len(range_candles) < 2:
            return self.no_signal(symbol, f"solo {len(range_candles)} velas en opening range")

        range_high = float(range_candles["high"].max())
        range_low = float(range_candles["low"].min())
        range_width = range_high - range_low
        if range_width <= 0:
            return self.no_signal(symbol, "range width = 0")

        current_close = float(last["close"])

        # ¿Breakout de range high? (long only, no short en spot)
        if current_close <= range_high:
            return self.no_signal(
                symbol,
                f"price {current_close:.2f} no rompió range_high {range_high:.2f}"
            )

        # Ya hubo breakout hoy? Chequeo: ninguna vela entre range_end y la actual
        # cerró arriba de range_high (si ya la hubo, no re-entramos).
        post_range = df_tz[(df_tz["ts"] >= range_end) & (df_tz["ts"] < last["ts"])]
        already_broken = (post_range["close"] > range_high).any()
        if already_broken:
            return self.no_signal(symbol, "breakout ya ocurrió antes en el día")

        # Volume filter
        recent_vol = df["volume"].tail(21).iloc[:-1].mean()
        current_vol = float(last["volume"])
        vol_ratio = current_vol / recent_vol if recent_vol > 0 else 1.0
        if vol_ratio < self.params["min_volume_ratio"]:
            return self.no_signal(
                symbol,
                f"volumen breakout {vol_ratio:.2f}x < umbral {self.params['min_volume_ratio']}x"
            )

        # Cálculo de ATR simple (14)
        high = df["high"].tail(15)
        low = df["low"].tail(15)
        close = df["close"].tail(15)
        prev_close = close.shift(1)
        tr = pd.concat([
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ], axis=1).max(axis=1)
        atr = float(tr.tail(14).mean())

        entry = current_close
        stop = range_low - atr * self.params["stop_buffer_atr"]
        target = entry + range_width * self.params["target_multiplier"]

        if stop >= entry:
            return self.no_signal(symbol, "stop inválido")

        rr = (target - entry) / (entry - stop)
        if rr < 1.5:
            return self.no_signal(symbol, f"RR {rr:.2f} < 1.5")

        # Confidence: base 65, bonus por volumen y RR
        confidence = 65.0
        if vol_ratio >= 2.0:
            confidence += 15
        elif vol_ratio >= 1.5:
            confidence += 8
        if rr >= 2.5:
            confidence += 10
        if range_width / entry > 0.005:   # range > 0.5% del precio = decente
            confidence += 5
        confidence = min(95.0, confidence)

        return StrategySignal(
            strategy_name=self.name,
            symbol=symbol,
            ts=now_utc.isoformat(),
            action="BUY",
            confidence=confidence,
            entry_price=entry,
            stop_price=stop,
            target_price=target,
            reasoning=(
                f"ORB BUY: range [{range_low:.2f}, {range_high:.2f}] width {range_width:.2f}, "
                f"breakout @ {entry:.2f} con vol {vol_ratio:.2f}x promedio, RR={rr:.2f}"
            ),
            metadata={
                "range_high": range_high,
                "range_low": range_low,
                "range_width": range_width,
                "atr": atr,
                "vol_ratio": vol_ratio,
                "rr": rr,
                "range_start": range_start.isoformat(),
                "range_end": range_end.isoformat(),
            },
        )
