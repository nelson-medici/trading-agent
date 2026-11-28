"""
Pattern Backtester — valida detección de patrones contra datos históricos.

Para cada patrón detectado en datos históricos, mide:
  - Win rate: % de veces que el precio alcanzó el target antes que el stop
  - Avg R:R realizado
  - Tiempo promedio hasta resolución
  - Comparación con random entries

Uso:
  python -m src.backtest.pattern_backtest --symbol BTC/USDT --timeframe 1h
"""
import pandas as pd
import numpy as np
from dataclasses import dataclass, field
from typing import Literal
import structlog

from src.patterns.detector import (
    detect_all, detect_head_shoulders, detect_flags, detect_wedges,
    PatternResult, Level, Triangle, DoubleFormation, HeadShoulders, Flag, Wedge,
)

log = structlog.get_logger()


@dataclass
class PatternTradeResult:
    pattern_name: str
    entry_idx: int
    entry_price: float
    stop: float
    target: float
    exit_price: float
    exit_idx: int
    exit_reason: str  # "target", "stop", "timeout"
    pnl_pct: float
    bars_held: int


@dataclass
class PatternBacktestResult:
    pattern_name: str
    total_signals: int
    wins: int
    losses: int
    timeouts: int
    win_rate: float
    avg_pnl_pct: float
    avg_bars_held: float
    profit_factor: float
    trades: list[PatternTradeResult] = field(default_factory=list)


def backtest_patterns(df: pd.DataFrame, max_hold_bars: int = 50,
                      atr_stop_mult: float = 2.0, atr_target_mult: float = 4.0,
                      ) -> list[PatternBacktestResult]:
    """
    Recorre el DataFrame con ventana deslizante, detecta patrones en cada punto,
    y simula el trade forward para medir si el patrón "acertó".
    """
    if len(df) < 60:
        return []

    # Precompute ATR
    pc = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)
    atr_series = tr.ewm(alpha=1/14, adjust=False).mean()

    # Acumular trades por patrón
    trades_by_pattern: dict[str, list[PatternTradeResult]] = {}

    # Ventana deslizante: analizar cada punto del 50-100 al N-max_hold_bars
    step = 5  # analizar cada 5 velas para no tardar horas
    for start_idx in range(50, len(df) - max_hold_bars, step):
        window = df.iloc[:start_idx + 1].copy().reset_index(drop=True)
        atr_val = float(atr_series.iloc[start_idx])
        if atr_val <= 0:
            continue

        entry_price = float(df["close"].iloc[start_idx])
        if entry_price <= 0:
            continue

        # Detect all patterns in the window
        result = detect_all(window, pivot_lookback=3)

        # Also detect advanced patterns
        hs_list = detect_head_shoulders(window)
        flag_list = detect_flags(window)
        wedge_list = detect_wedges(window)

        # Build signals list
        signals: list[tuple[str, str, float, float]] = []  # (name, bias, stop, target)

        # Triangles
        for tri in result.triangles:
            if tri.breakout == "up":
                signals.append(("Triangle Breakout Up", "bullish",
                                entry_price - atr_val * atr_stop_mult,
                                entry_price + atr_val * atr_target_mult))
            elif tri.breakout == "down":
                signals.append(("Triangle Breakout Down", "bearish",
                                entry_price + atr_val * atr_stop_mult,
                                entry_price - atr_val * atr_target_mult))

        # Double formations
        for dbl in result.doubles:
            if dbl.kind == "double_bottom":
                height = dbl.neckline - dbl.level
                signals.append(("Double Bottom", "bullish",
                                dbl.level, dbl.neckline + height))
            elif dbl.kind == "double_top":
                height = dbl.level - dbl.neckline
                signals.append(("Double Top", "bearish",
                                dbl.level, dbl.neckline - height))

        # Head & Shoulders
        for hs in hs_list:
            if hs.confirmed:
                signals.append((
                    "Inverse H&S" if hs.kind == "inverse_head_shoulders" else "H&S",
                    "bullish" if hs.kind == "inverse_head_shoulders" else "bearish",
                    hs.head_price if hs.kind == "head_shoulders" else hs.head_price,
                    hs.target,
                ))

        # Flags
        for fl in flag_list:
            if fl.confirmed:
                signals.append(("Bull Flag" if fl.kind == "bull_flag" else "Bear Flag",
                                "bullish" if fl.kind == "bull_flag" else "bearish",
                                fl.stop, fl.target))

        # Wedges
        for w in wedge_list:
            if w.confirmed:
                signals.append(("Falling Wedge" if w.kind == "falling_wedge" else "Rising Wedge",
                                "bullish" if w.kind == "falling_wedge" else "bearish",
                                w.stop, w.target))

        # Simulate each signal forward
        for sig_name, bias, stop, target in signals:
            trade = _simulate_forward(df, start_idx, entry_price, stop, target,
                                       max_hold_bars, sig_name, bias)
            if trade:
                if sig_name not in trades_by_pattern:
                    trades_by_pattern[sig_name] = []
                trades_by_pattern[sig_name].append(trade)

    # Aggregate results
    results: list[PatternBacktestResult] = []
    for name, trades in trades_by_pattern.items():
        wins = sum(1 for t in trades if t.exit_reason == "target")
        losses = sum(1 for t in trades if t.exit_reason == "stop")
        timeouts = sum(1 for t in trades if t.exit_reason == "timeout")
        total = len(trades)
        avg_pnl = np.mean([t.pnl_pct for t in trades]) if trades else 0
        avg_bars = np.mean([t.bars_held for t in trades]) if trades else 0

        gross_profit = sum(t.pnl_pct for t in trades if t.pnl_pct > 0)
        gross_loss = abs(sum(t.pnl_pct for t in trades if t.pnl_pct < 0))
        pf = gross_profit / gross_loss if gross_loss > 0 else float("inf")

        results.append(PatternBacktestResult(
            pattern_name=name, total_signals=total,
            wins=wins, losses=losses, timeouts=timeouts,
            win_rate=wins / total if total > 0 else 0,
            avg_pnl_pct=float(avg_pnl),
            avg_bars_held=float(avg_bars),
            profit_factor=float(pf),
            trades=trades,
        ))

    results.sort(key=lambda r: r.profit_factor, reverse=True)
    return results


def _simulate_forward(df: pd.DataFrame, entry_idx: int, entry_price: float,
                      stop: float, target: float, max_bars: int,
                      pattern_name: str, bias: str) -> PatternTradeResult | None:
    """Simula un trade forward desde entry_idx."""
    is_long = bias == "bullish"

    for i in range(entry_idx + 1, min(entry_idx + max_bars, len(df))):
        high = float(df["high"].iloc[i])
        low = float(df["low"].iloc[i])
        close = float(df["close"].iloc[i])

        if is_long:
            if low <= stop:
                return PatternTradeResult(
                    pattern_name=pattern_name, entry_idx=entry_idx,
                    entry_price=entry_price, stop=stop, target=target,
                    exit_price=stop, exit_idx=i, exit_reason="stop",
                    pnl_pct=(stop - entry_price) / entry_price,
                    bars_held=i - entry_idx,
                )
            if high >= target:
                return PatternTradeResult(
                    pattern_name=pattern_name, entry_idx=entry_idx,
                    entry_price=entry_price, stop=stop, target=target,
                    exit_price=target, exit_idx=i, exit_reason="target",
                    pnl_pct=(target - entry_price) / entry_price,
                    bars_held=i - entry_idx,
                )
        else:
            if high >= stop:
                return PatternTradeResult(
                    pattern_name=pattern_name, entry_idx=entry_idx,
                    entry_price=entry_price, stop=stop, target=target,
                    exit_price=stop, exit_idx=i, exit_reason="stop",
                    pnl_pct=(entry_price - stop) / entry_price,
                    bars_held=i - entry_idx,
                )
            if low <= target:
                return PatternTradeResult(
                    pattern_name=pattern_name, entry_idx=entry_idx,
                    entry_price=entry_price, stop=stop, target=target,
                    exit_price=target, exit_idx=i, exit_reason="target",
                    pnl_pct=(entry_price - target) / entry_price,
                    bars_held=i - entry_idx,
                )

    # Timeout
    last_close = float(df["close"].iloc[min(entry_idx + max_bars - 1, len(df) - 1)])
    pnl = (last_close - entry_price) / entry_price if is_long else (entry_price - last_close) / entry_price
    return PatternTradeResult(
        pattern_name=pattern_name, entry_idx=entry_idx,
        entry_price=entry_price, stop=stop, target=target,
        exit_price=last_close, exit_idx=min(entry_idx + max_bars, len(df) - 1),
        exit_reason="timeout", pnl_pct=pnl,
        bars_held=min(max_bars, len(df) - entry_idx - 1),
    )
