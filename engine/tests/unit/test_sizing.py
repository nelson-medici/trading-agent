"""Tests de sizing."""
from src.risk.sizing import compute_position_size


def test_normal_sizing_produces_valid_result():
    r = compute_position_size(
        equity_usd=1000,
        entry_price=60000,
        stop_price=57000,
        target_price=66000,
        is_btc_or_eth=True,
        current_position_pct=0.0,
    )
    assert r.is_viable
    assert r.size_units > 0
    assert r.max_loss_usd <= 1000 * 0.01 * 1.001  # margen de floating point


def test_stop_above_entry_fails():
    r = compute_position_size(
        equity_usd=1000,
        entry_price=60000,
        stop_price=61000,
        target_price=66000,
        is_btc_or_eth=True,
        current_position_pct=0.0,
    )
    assert not r.is_viable


def test_too_small_notional_fails():
    r = compute_position_size(
        equity_usd=50,
        entry_price=60000,
        stop_price=57000,
        target_price=66000,
        is_btc_or_eth=True,
        current_position_pct=0.0,
        min_position_size_usd=15,
    )
    assert not r.is_viable
    assert "notional" in r.reason.lower()


def test_position_cap_reached():
    r = compute_position_size(
        equity_usd=1000,
        entry_price=60000,
        stop_price=57000,
        target_price=66000,
        is_btc_or_eth=True,
        current_position_pct=0.30,
    )
    assert not r.is_viable
    assert "cap" in r.reason.lower()
