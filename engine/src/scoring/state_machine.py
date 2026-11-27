"""
State machine por activo:
IGNORE -> WATCHLIST -> CANDIDATE -> ENTERED -> EXIT
"""
from typing import Literal

State = Literal["IGNORE", "WATCHLIST", "CANDIDATE", "ENTERED", "EXIT"]


def transition(
    current_state: State,
    score: float,
    thresholds: dict,
    has_open_position: bool,
) -> State:
    if has_open_position:
        # Si tiene posición, solo puede pasar a EXIT o mantenerse ENTERED
        if score < thresholds.get("ignore_below", 60):
            return "EXIT"
        return "ENTERED"

    # Sin posición, transiciones por score
    if score < thresholds.get("ignore_below", 60):
        return "IGNORE"
    elif score < thresholds.get("candidate", 75):
        return "WATCHLIST"
    else:
        return "CANDIDATE"
