"""Combina componentes con pesos configurables."""
from src.scoring.components import ScoreComponents


def aggregate(components: ScoreComponents, weights: dict) -> float:
    total = (
        weights.get("technical", 0.40) * components.technical
        + weights.get("fundamental", 0.20) * components.fundamental
        + weights.get("sentiment", 0.15) * components.sentiment
        + weights.get("risk", 0.15) * components.risk
        + weights.get("timing", 0.10) * components.timing
    )
    return round(total, 2)
