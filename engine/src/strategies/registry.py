"""Registro de estrategias disponibles."""
from src.strategies.base import Strategy
from src.strategies.orb import ORBIntradayStrategy


REGISTRY: dict[str, type[Strategy]] = {
    "orb_intraday": ORBIntradayStrategy,
}


def get_strategy(name: str, params: dict | None = None) -> Strategy | None:
    cls = REGISTRY.get(name)
    if cls is None:
        return None
    return cls(params=params)


def all_strategies() -> list[str]:
    return list(REGISTRY.keys())
