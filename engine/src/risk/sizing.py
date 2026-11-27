"""
Cálculo de tamaño de posición.
size = risk_pct * equity / (entry - stop)
"""
from dataclasses import dataclass


@dataclass
class SizingResult:
    size_units: float
    notional_usd: float
    max_loss_usd: float
    expected_profit_usd: float
    commission_round_trip_usd: float
    is_viable: bool
    reason: str = ""


def compute_position_size(
    *,
    equity_usd: float,
    entry_price: float,
    stop_price: float,
    target_price: float,
    is_btc_or_eth: bool,
    current_position_pct: float,
    max_risk_per_trade_pct: float = 0.01,
    max_position_pct: float = 0.20,
    max_position_btc_eth_pct: float = 0.30,
    commission_per_side_pct: float = 0.001,
    min_profit_to_commission_ratio: float = 3.0,
    min_position_size_usd: float = 15.0,
) -> SizingResult:
    if entry_price <= 0 or stop_price <= 0:
        return SizingResult(0, 0, 0, 0, 0, False, "invalid prices")

    if entry_price <= stop_price:
        return SizingResult(0, 0, 0, 0, 0, False, "stop must be below entry for long")

    risk_per_unit = entry_price - stop_price
    risk_budget = equity_usd * max_risk_per_trade_pct
    size_by_risk = risk_budget / risk_per_unit

    cap_pct = max_position_btc_eth_pct if is_btc_or_eth else max_position_pct
    available_pct = cap_pct - current_position_pct
    if available_pct <= 0:
        return SizingResult(0, 0, 0, 0, 0, False, "position cap reached")

    max_notional = equity_usd * available_pct
    size_by_cap = max_notional / entry_price

    size_units = min(size_by_risk, size_by_cap)
    notional = size_units * entry_price

    if notional < min_position_size_usd:
        return SizingResult(
            0, 0, 0, 0, 0, False,
            f"notional ${notional:.2f} < ${min_position_size_usd} min"
        )

    commission_rt = notional * commission_per_side_pct * 2
    expected_profit = (target_price - entry_price) * size_units
    max_loss = (entry_price - stop_price) * size_units

    if commission_rt * min_profit_to_commission_ratio > expected_profit:
        return SizingResult(
            0, 0, 0, 0, commission_rt, False,
            f"commission ${commission_rt:.2f} too high vs profit ${expected_profit:.2f}"
        )

    return SizingResult(
        size_units=size_units,
        notional_usd=notional,
        max_loss_usd=max_loss,
        expected_profit_usd=expected_profit,
        commission_round_trip_usd=commission_rt,
        is_viable=True,
    )
