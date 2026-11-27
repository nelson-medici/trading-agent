"""
Backtest engine simple y determinista.

Toma una estrategia + un DataFrame histórico de OHLCV, simula candle por candle,
y genera métricas (Sharpe, PF, win rate, max DD, etc).

Asume paper broker con fills instantáneos al entry_price y comisiones en %.
"""
from dataclasses import dataclass, field
import math
import pandas as pd
import numpy as np
from src.strategies.base import Strategy, StrategySignal


@dataclass
class BacktestTrade:
    symbol: str
    entry_ts: str
    exit_ts: str
    entry_price: float
    exit_price: float
    size_units: float
    pnl_usd: float
    pnl_pct: float
    exit_reason: str                      # 'stop' | 'target' | 'eod' | 'signal'
    hold_hours: float
    strategy_confidence: float


@dataclass
class BacktestResult:
    strategy_name: str
    symbol: str
    timeframe: str
    start_date: str
    end_date: str
    initial_capital: float
    final_capital: float
    total_return_pct: float
    total_trades: int
    winning_trades: int
    losing_trades: int
    win_rate: float
    profit_factor: float
    sharpe_ratio: float
    max_drawdown_pct: float
    avg_win_usd: float
    avg_loss_usd: float
    avg_hold_hours: float
    trades: list[BacktestTrade] = field(default_factory=list)

    def summary(self) -> dict:
        return {
            "strategy": self.strategy_name,
            "symbol": self.symbol,
            "trades": self.total_trades,
            "win_rate": round(self.win_rate * 100, 1),
            "pf": round(self.profit_factor, 2),
            "sharpe": round(self.sharpe_ratio, 2),
            "max_dd_pct": round(self.max_drawdown_pct * 100, 2),
            "total_return_pct": round(self.total_return_pct * 100, 2),
            "final_capital": round(self.final_capital, 2),
        }


class BacktestEngine:
    def __init__(
        self,
        initial_capital: float = 10_000.0,
        risk_per_trade_pct: float = 0.01,
        commission_pct: float = 0.001,   # 0.1% por lado
        min_warmup_candles: int = 50,
    ):
        self.initial_capital = initial_capital
        self.risk_per_trade_pct = risk_per_trade_pct
        self.commission_pct = commission_pct
        self.min_warmup_candles = min_warmup_candles

    def run(
        self,
        strategy: Strategy,
        df: pd.DataFrame,
        symbol: str,
        timeframe: str = "1h",
    ) -> BacktestResult:
        """
        df: OHLCV histórico ascendente por ts.
        Itera candle por candle, en cada uno:
         - Si hay posición abierta: chequea stop/target/exit
         - Si no hay: pide a la estrategia una señal, si BUY → entra
        """
        df = df.sort_values("ts").reset_index(drop=True).copy()
        for col in ["open", "high", "low", "close", "volume"]:
            df[col] = pd.to_numeric(df[col])
        df["ts"] = pd.to_datetime(df["ts"])

        capital = self.initial_capital
        trades: list[BacktestTrade] = []
        equity_curve = [capital]
        open_trade: dict | None = None

        for i in range(self.min_warmup_candles, len(df)):
            window = df.iloc[: i + 1]
            row = window.iloc[-1]

            # 1. Si tenemos posición abierta: chequear stop/target intra-candle
            if open_trade:
                high = float(row["high"])
                low = float(row["low"])
                exit_reason = None
                exit_price = None

                # Si durante la vela se tocó stop O target, prioridad al stop
                # (conservador, worst case)
                if low <= open_trade["stop"]:
                    exit_reason = "stop"
                    exit_price = open_trade["stop"]
                elif high >= open_trade["target"]:
                    exit_reason = "target"
                    exit_price = open_trade["target"]

                if exit_reason:
                    size = open_trade["size_units"]
                    entry = open_trade["entry_price"]
                    commission = size * exit_price * self.commission_pct
                    pnl = (exit_price - entry) * size - commission
                    pnl_pct = (exit_price - entry) / entry
                    hold_hours = (row["ts"] - open_trade["entry_ts"]).total_seconds() / 3600
                    capital += pnl + (size * entry)   # devuelve el capital invertido + pnl
                    trades.append(BacktestTrade(
                        symbol=symbol,
                        entry_ts=open_trade["entry_ts"].isoformat(),
                        exit_ts=row["ts"].isoformat(),
                        entry_price=entry,
                        exit_price=exit_price,
                        size_units=size,
                        pnl_usd=pnl,
                        pnl_pct=pnl_pct,
                        exit_reason=exit_reason,
                        hold_hours=hold_hours,
                        strategy_confidence=open_trade.get("confidence", 0),
                    ))
                    open_trade = None

            # 2. Si no hay posición abierta, pedir señal
            if not open_trade:
                try:
                    signal = strategy.evaluate(window, symbol)
                except Exception:
                    signal = None

                if signal and signal.action == "BUY":
                    # Sizing: risk_per_trade_pct del capital
                    risk_budget = capital * self.risk_per_trade_pct
                    risk_per_unit = signal.entry_price - signal.stop_price
                    if risk_per_unit <= 0:
                        continue
                    size = risk_budget / risk_per_unit
                    notional = size * signal.entry_price
                    if notional > capital * 0.5:   # cap 50% capital per trade
                        size = (capital * 0.5) / signal.entry_price
                        notional = size * signal.entry_price

                    commission = notional * self.commission_pct
                    capital -= (notional + commission)
                    open_trade = {
                        "entry_ts": row["ts"],
                        "entry_price": signal.entry_price,
                        "stop": signal.stop_price,
                        "target": signal.target_price,
                        "size_units": size,
                        "confidence": signal.confidence,
                    }

            # Equity curve: capital + valor de posición abierta a close actual
            equity = capital
            if open_trade:
                equity += open_trade["size_units"] * float(row["close"])
            equity_curve.append(equity)

        # Cerrar posición al final (EOD)
        if open_trade:
            last = df.iloc[-1]
            exit_price = float(last["close"])
            size = open_trade["size_units"]
            entry = open_trade["entry_price"]
            commission = size * exit_price * self.commission_pct
            pnl = (exit_price - entry) * size - commission
            pnl_pct = (exit_price - entry) / entry
            hold_hours = (last["ts"] - open_trade["entry_ts"]).total_seconds() / 3600
            capital += pnl + (size * entry)
            trades.append(BacktestTrade(
                symbol=symbol,
                entry_ts=open_trade["entry_ts"].isoformat(),
                exit_ts=last["ts"].isoformat(),
                entry_price=entry,
                exit_price=exit_price,
                size_units=size,
                pnl_usd=pnl,
                pnl_pct=pnl_pct,
                exit_reason="eod",
                hold_hours=hold_hours,
                strategy_confidence=open_trade.get("confidence", 0),
            ))

        return self._compute_metrics(
            strategy_name=strategy.name,
            symbol=symbol,
            timeframe=timeframe,
            df=df,
            trades=trades,
            equity_curve=equity_curve,
            final_capital=capital,
        )

    def _compute_metrics(
        self,
        strategy_name: str,
        symbol: str,
        timeframe: str,
        df: pd.DataFrame,
        trades: list[BacktestTrade],
        equity_curve: list[float],
        final_capital: float,
    ) -> BacktestResult:
        start_date = df.iloc[self.min_warmup_candles]["ts"].isoformat() if len(df) > self.min_warmup_candles else df.iloc[0]["ts"].isoformat()
        end_date = df.iloc[-1]["ts"].isoformat()

        total_trades = len(trades)
        wins = [t for t in trades if t.pnl_usd > 0]
        losses = [t for t in trades if t.pnl_usd < 0]
        total_wins_usd = sum(t.pnl_usd for t in wins)
        total_losses_usd = abs(sum(t.pnl_usd for t in losses))
        win_rate = len(wins) / total_trades if total_trades > 0 else 0
        pf = total_wins_usd / total_losses_usd if total_losses_usd > 0 else (float("inf") if total_wins_usd > 0 else 0)

        # Sharpe simple: retornos por trade anualizados
        if total_trades > 1:
            returns = [t.pnl_usd / self.initial_capital for t in trades]
            mean_r = float(np.mean(returns))
            std_r = float(np.std(returns, ddof=1))
            # Approx anualizar asumiendo N trades/año proporcional al tiempo
            try:
                span = (pd.to_datetime(end_date) - pd.to_datetime(start_date)).total_seconds() / (365.25 * 24 * 3600)
                trades_per_year = total_trades / span if span > 0 else 1
                sharpe = (mean_r / std_r) * math.sqrt(trades_per_year) if std_r > 0 else 0
            except Exception:
                sharpe = (mean_r / std_r) if std_r > 0 else 0
        else:
            sharpe = 0

        # Max drawdown
        curve = np.array(equity_curve)
        running_max = np.maximum.accumulate(curve)
        drawdowns = (running_max - curve) / running_max
        max_dd = float(drawdowns.max()) if len(drawdowns) > 0 else 0

        total_return = (final_capital - self.initial_capital) / self.initial_capital

        return BacktestResult(
            strategy_name=strategy_name,
            symbol=symbol,
            timeframe=timeframe,
            start_date=start_date,
            end_date=end_date,
            initial_capital=self.initial_capital,
            final_capital=final_capital,
            total_return_pct=total_return,
            total_trades=total_trades,
            winning_trades=len(wins),
            losing_trades=len(losses),
            win_rate=win_rate,
            profit_factor=pf if not math.isinf(pf) else 999.99,
            sharpe_ratio=sharpe,
            max_drawdown_pct=max_dd,
            avg_win_usd=sum(t.pnl_usd for t in wins) / len(wins) if wins else 0,
            avg_loss_usd=sum(t.pnl_usd for t in losses) / len(losses) if losses else 0,
            avg_hold_hours=sum(t.hold_hours for t in trades) / len(trades) if trades else 0,
            trades=trades,
        )
