"""
Donchian Channel Breakout (Turtle Trader simplificado).

Regla clásica de Richard Dennis (Turtles, 1983). Funciona bien en cripto
por la volatilidad intrínseca.

1. Calcular Donchian Channel N períodos (default: 20):
   - upper = max(high) últimos N bars (sin incluir el actual)
   - lower = min(low) últimos N bars
2. BUY cuando close del actual > upper (break de máximo)
3. Stop: 2×ATR debajo del entry
4. Target: ancho del canal × target_multiplier (default 2x)

Filtros:
- ATR debe estar expandiendo (volatilidad creciente) para evitar breakouts falsos en rangos
- Volumen mayor al promedio
- Precio > SMA50 (filtro de tendencia mayor)
"""
import pandas as pd
import numpy as np
from src.strategies.base import Strategy, StrategySignal


class DonchianBreakoutStrategy(Strategy):
    name = "donchian_breakout"

    DEFAULTS = {
        "channel_period": 20,
        "atr_period": 14,
        "stop_atr_multiplier": 2.0,
        "target_multiplier": 2.0,
        "min_atr_expansion": 1.1,       # ATR actual vs ATR promedio últimos 50
        "min_volume_ratio": 1.2,
        "require_trend_filter": True,   # precio arriba de SMA50
    }

    def __init__(self, params: dict | None = None):
        super().__init__({**self.DEFAULTS, **(params or {})})

    def evaluate(self, df: pd.DataFrame, symbol: str) -> StrategySignal:
        p = self.params
        if len(df) < max(p["channel_period"], 50) + 5:
            return self.no_signal(symbol, "insufficient data")

        df = df.sort_values("ts").reset_index(drop=True).copy()
        df["ts"] = pd.to_datetime(df["ts"])
        for c in ["open", "high", "low", "close", "volume"]:
            df[c] = pd.to_numeric(df[c])

        # Donchian excluyendo el bar actual
        last_i = len(df) - 1
        window = df.iloc[last_i - p["channel_period"]: last_i]
        upper = float(window["high"].max())
        lower = float(window["low"].min())
        channel_width = upper - lower
        if channel_width <= 0:
            return self.no_signal(symbol, "channel sin ancho")

        last_close = float(df["close"].iloc[last_i])
        last_open = float(df["open"].iloc[last_i])
        last_vol = float(df["volume"].iloc[last_i])

        # 1) Breakout confirmado
        if last_close <= upper:
            return self.no_signal(
                symbol,
                f"close {last_close:.2f} no rompió donchian_upper {upper:.2f}"
            )

        # Vela debe ser alcista
        if last_close <= last_open:
            return self.no_signal(symbol, "vela no es alcista")

        # 2) ATR + expansión
        high = df["high"]; low = df["low"]; prev_close = df["close"].shift(1)
        tr = pd.concat([
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ], axis=1).max(axis=1)
        atr = tr.ewm(span=p["atr_period"], adjust=False).mean()
        last_atr = float(atr.iloc[last_i])
        atr_mean_50 = float(atr.tail(50).mean())
        atr_expansion = last_atr / atr_mean_50 if atr_mean_50 > 0 else 1.0
        if atr_expansion < p["min_atr_expansion"]:
            return self.no_signal(symbol, f"ATR no expande ({atr_expansion:.2f}x < {p['min_atr_expansion']}x)")

        # 3) Volumen
        vol_sma20 = df["volume"].tail(21).iloc[:-1].mean()
        vol_ratio = last_vol / vol_sma20 if vol_sma20 > 0 else 1.0
        if vol_ratio < p["min_volume_ratio"]:
            return self.no_signal(symbol, f"volumen {vol_ratio:.2f}x < {p['min_volume_ratio']}x")

        # 4) Trend filter: precio arriba de SMA50
        if p["require_trend_filter"]:
            sma50 = df["close"].rolling(50).mean().iloc[last_i]
            if last_close < float(sma50):
                return self.no_signal(symbol, "precio bajo SMA50 (trend bajista)")

        # Stop & target
        entry = last_close
        stop = entry - p["stop_atr_multiplier"] * last_atr
        if stop >= entry:
            return self.no_signal(symbol, "stop inválido")
        target = entry + channel_width * p["target_multiplier"]

        risk = entry - stop
        reward = target - entry
        rr = reward / risk if risk > 0 else 0
        if rr < 1.5:
            return self.no_signal(symbol, f"RR {rr:.2f} < 1.5")

        # Confidence
        confidence = 60.0
        if atr_expansion >= 1.3:
            confidence += 10
        if vol_ratio >= 1.5:
            confidence += 8
        if rr >= 2.5:
            confidence += 8
        if (last_close - upper) / channel_width > 0.1:
            confidence += 5   # breakout contundente
        confidence = min(95.0, confidence)

        return StrategySignal(
            strategy_name=self.name,
            symbol=symbol,
            ts=df["ts"].iloc[last_i].isoformat() if hasattr(df["ts"].iloc[last_i], "isoformat") else str(df["ts"].iloc[last_i]),
            action="BUY",
            confidence=confidence,
            entry_price=entry,
            stop_price=stop,
            target_price=target,
            reasoning=(
                f"Donchian BUY: break donchian_upper[{p['channel_period']}]={upper:.2f} "
                f"@ {entry:.2f}, width={channel_width:.2f}, ATR exp {atr_expansion:.2f}x, "
                f"vol {vol_ratio:.2f}x, RR={rr:.2f}"
            ),
            metadata={
                "donchian_upper": upper,
                "donchian_lower": lower,
                "channel_width": channel_width,
                "atr": last_atr,
                "atr_expansion": atr_expansion,
                "vol_ratio": vol_ratio,
                "rr": rr,
            },
        )
