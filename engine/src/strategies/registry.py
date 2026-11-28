"""Registro de estrategias disponibles."""
from src.strategies.base import Strategy
from src.strategies.orb import ORBIntradayStrategy
from src.strategies.ema_golden_pullback import EmaGoldenPullbackStrategy
from src.strategies.donchian_breakout import DonchianBreakoutStrategy
from src.strategies.silver_bullet import SilverBulletStrategy


REGISTRY: dict[str, type[Strategy]] = {
    "orb_intraday": ORBIntradayStrategy,
    "ema_golden_pullback": EmaGoldenPullbackStrategy,
    "donchian_breakout": DonchianBreakoutStrategy,
    "silver_bullet": SilverBulletStrategy,
}


def get_strategy(name: str, params: dict | None = None) -> Strategy | None:
    cls = REGISTRY.get(name)
    if cls is None:
        return None
    return cls(params=params)


def all_strategies() -> list[str]:
    return list(REGISTRY.keys())
