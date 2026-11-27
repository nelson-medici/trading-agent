"""Cálculo de stops y targets basados en ATR."""


def compute_stop_target(
    entry_price: float,
    atr: float,
    side: str = "LONG",
    stop_multiplier: float = 2.0,
    target_multiplier: float = 4.0,
) -> tuple[float, float]:
    if side.upper() == "LONG":
        stop = entry_price - stop_multiplier * atr
        target = entry_price + target_multiplier * atr
    else:
        stop = entry_price + stop_multiplier * atr
        target = entry_price - target_multiplier * atr
    return round(stop, 2), round(target, 2)


def compute_rr_ratio(entry: float, stop: float, target: float) -> float:
    risk = abs(entry - stop)
    reward = abs(target - entry)
    return reward / risk if risk > 0 else 0.0
