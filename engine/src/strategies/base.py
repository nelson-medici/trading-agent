"""
Interfaz base para estrategias de trading.

Cada estrategia es una clase que recibe un DataFrame de OHLCV y devuelve
una señal estructurada. Determinista, testeable, backtesteable.
"""
from dataclasses import dataclass, field, asdict
from typing import Literal
from abc import ABC, abstractmethod
import pandas as pd


SignalAction = Literal["BUY", "SELL", "NONE"]


@dataclass
class StrategySignal:
    strategy_name: str
    symbol: str
    ts: str                          # ISO timestamp del momento del signal
    action: SignalAction
    confidence: float                # 0-100
    entry_price: float = 0.0
    stop_price: float = 0.0
    target_price: float = 0.0
    reasoning: str = ""
    metadata: dict = field(default_factory=dict)

    @property
    def risk_reward(self) -> float:
        if self.action == "NONE" or self.entry_price <= 0:
            return 0.0
        risk = abs(self.entry_price - self.stop_price)
        reward = abs(self.target_price - self.entry_price)
        return reward / risk if risk > 0 else 0.0

    def to_dict(self) -> dict:
        return asdict(self)


class Strategy(ABC):
    """Base class para todas las estrategias."""

    name: str = "unnamed"

    def __init__(self, params: dict | None = None):
        self.params = params or {}

    @abstractmethod
    def evaluate(self, df: pd.DataFrame, symbol: str) -> StrategySignal:
        """
        df: OHLCV sorteado ascendente por ts, con columnas open/high/low/close/volume/ts.
        El último row representa el momento actual.
        Retorna una señal (action='NONE' si no hay setup).
        """
        ...

    def no_signal(self, symbol: str, reason: str = "") -> StrategySignal:
        return StrategySignal(
            strategy_name=self.name,
            symbol=symbol,
            ts="",
            action="NONE",
            confidence=0.0,
            reasoning=reason,
        )
