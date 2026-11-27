"""
EMA Golden Cross + Pullback Strategy.

Replica el patrón que suele dispararse tras una reversión alcista:
1. EMA20 > EMA50 > EMA200 (alineación bullish — 'golden stack')
2. Precio > EMA200 (tendencia mayor alcista confirmada)
3. Precio hace pullback hasta cerca de la EMA20 sin romperla significativamente
4. Vela de confirmación cierra arriba de la EMA20 después del pullback

Entry:    close de la vela de confirmación
Stop:     mínimo del pullback - 0.3×ATR  (buffer para evitar stops por noise)
Target:   entry + (entry - stop) × target_rr   (default RR=2.5)

Confidence depende de:
- Cuán fresco es el cruce EMA20/EMA50
- Cuán limpio fue el pullback (profundidad vs la EMA20)
- Pendiente positiva de la EMA50 (acelerando)
- Volumen de la vela de confirmación
"""
import pandas as pd
import numpy as np
from src.strategies.base import Strategy, StrategySignal


class EmaGoldenPullbackStrategy(Strategy):
    name = "ema_golden_pullback"

    DEFAULTS = {
        "ema_fast": 20,
        "ema_mid": 50,
        "ema_slow": 200,
        "pullback_tolerance_atr": 1.0,       # cuánto puede alejarse del EMA20 y aún considerarse pullback
        "target_rr": 2.5,
        "stop_buffer_atr": 0.3,
        "min_golden_age_bars": 3,            # cruce al menos N velas atrás
        "max_golden_age_bars": 50,           # pero no más de M (sino ya está viejo)
        "min_volume_ratio": 1.1,
    }

    def __init__(self, params: dict | None = None):
        super().__init__({**self.DEFAULTS, **(params or {})})

    def evaluate(self, df: pd.DataFrame, symbol: str) -> StrategySignal:
        if len(df) < max(self.params["ema_slow"], 50) + 10:
            return self.no_signal(symbol, "insufficient data")

        df = df.sort_values("ts").reset_index(drop=True).copy()
        df["ts"] = pd.to_datetime(df["ts"])
        for c in ["open", "high", "low", "close", "volume"]:
            df[c] = pd.to_numeric(df[c])

        p = self.params
        close = df["close"]

        ema_fast = close.ewm(span=p["ema_fast"], adjust=False).mean()
        ema_mid = close.ewm(span=p["ema_mid"], adjust=False).mean()
        ema_slow = close.ewm(span=p["ema_slow"], adjust=False).mean()

        # ATR(14)
        high = df["high"]; low = df["low"]; prev_close = close.shift(1)
        tr = pd.concat([
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ], axis=1).max(axis=1)
        atr = tr.ewm(span=14, adjust=False).mean()

        last_i = len(df) - 1
        last_close = float(close.iloc[last_i])
        last_open = float(df["open"].iloc[last_i])
        last_low = float(df["low"].iloc[last_i])
        last_vol = float(df["volume"].iloc[last_i])
        last_ema_fast = float(ema_fast.iloc[last_i])
        last_ema_mid = float(ema_mid.iloc[last_i])
        last_ema_slow = float(ema_slow.iloc[last_i])
        last_atr = float(atr.iloc[last_i])

        # 1) Alineación bullish de EMAs
        if not (last_ema_fast > last_ema_mid > last_ema_slow):
            return self.no_signal(symbol, "EMAs no alineadas bullish")

        # 2) Precio arriba de EMA200
        if last_close < last_ema_slow:
            return self.no_signal(symbol, "precio bajo EMA200")

        # 3) Golden cross fresco (hace min-max bars): buscamos última vela donde ema_fast <= ema_mid
        cross_age = None
        for i in range(last_i, max(0, last_i - 200), -1):
            if ema_fast.iloc[i] <= ema_mid.iloc[i]:
                cross_age = last_i - i
                break
        if cross_age is None:
            cross_age = 999
        if cross_age < p["min_golden_age_bars"]:
            return self.no_signal(symbol, f"cross demasiado fresco ({cross_age} bars)")
        if cross_age > p["max_golden_age_bars"]:
            return self.no_signal(symbol, f"cross demasiado viejo ({cross_age} bars)")

        # 4) Buscamos pullback reciente: alguna vela de las últimas 15 tocó la EMA20
        pullback_low = None
        pullback_i = None
        for i in range(last_i, max(0, last_i - 15), -1):
            # La vela tocó o cruzó la EMA20 por debajo (pullback)
            if df["low"].iloc[i] <= ema_fast.iloc[i] * (1 + 0.002):   # tolerancia 0.2%
                pullback_low = float(df["low"].iloc[i])
                pullback_i = i
                break
        if pullback_low is None:
            return self.no_signal(symbol, "sin pullback a EMA20 reciente")

        # El pullback no debe haber roto la EMA50 significativamente
        if pullback_low < last_ema_mid * 0.995:
            return self.no_signal(symbol, "pullback rompió EMA50 (reversión posible)")

        # 5) Vela actual: confirmación. Debe ser una vela alcista cerrando arriba de la EMA20
        if last_close <= last_ema_fast:
            return self.no_signal(symbol, "vela actual no cerró arriba de EMA20")
        if last_close <= last_open:
            return self.no_signal(symbol, "vela actual no es alcista")

        # Volumen filter
        vol_sma20 = df["volume"].tail(21).iloc[:-1].mean()
        vol_ratio = last_vol / vol_sma20 if vol_sma20 > 0 else 1.0
        if vol_ratio < p["min_volume_ratio"]:
            return self.no_signal(symbol, f"volumen {vol_ratio:.2f}x < {p['min_volume_ratio']}x")

        # Stop & target
        entry = last_close
        stop = pullback_low - p["stop_buffer_atr"] * last_atr
        risk = entry - stop
        if risk <= 0:
            return self.no_signal(symbol, "stop inválido")
        target = entry + risk * p["target_rr"]

        # Pendiente EMA50 (si es positiva, bonus)
        ema_mid_slope = (last_ema_mid - float(ema_mid.iloc[max(0, last_i - 10)])) / float(ema_mid.iloc[max(0, last_i - 10)])

        # Confidence
        confidence = 60.0
        if 5 <= cross_age <= 20:
            confidence += 10   # cruce ni muy fresco ni muy viejo
        if vol_ratio >= 1.5:
            confidence += 8
        if ema_mid_slope > 0.01:
            confidence += 8
        if last_close > last_ema_mid * 1.02:   # precio bien arriba de EMA50
            confidence += 5
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
                f"GoldenPullback BUY: EMA aligned ({last_ema_fast:.2f}>{last_ema_mid:.2f}>{last_ema_slow:.2f}), "
                f"cross age {cross_age} bars, pullback @ {pullback_low:.2f}, "
                f"confirmation close @ {entry:.2f} vol {vol_ratio:.2f}x, RR={p['target_rr']}"
            ),
            metadata={
                "ema_fast": last_ema_fast,
                "ema_mid": last_ema_mid,
                "ema_slow": last_ema_slow,
                "atr": last_atr,
                "cross_age_bars": cross_age,
                "pullback_low": pullback_low,
                "vol_ratio": vol_ratio,
                "ema_mid_slope": ema_mid_slope,
            },
        )
