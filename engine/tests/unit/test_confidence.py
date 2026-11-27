"""Tests de la regla del 85%."""
import pytest
from src.scoring.confidence import evaluate_high_confidence


def base_inputs(**overrides):
    defaults = dict(
        score_total=88,
        score_technical=82,
        indicators_aligned=4,
        price_above_sma200=True,
        volume_ratio=2.0,
        market_regime="risk_on",
        has_event_in_48h=False,
        risk_reward_ratio=2.5,
        score_history=[78, 80, 82],
        bid_ask_spread_pct=0.0005,
    )
    defaults.update(overrides)
    return defaults


def test_all_conditions_met_passes():
    result = evaluate_high_confidence(**base_inputs())
    assert result.passes is True


def test_score_below_85_fails():
    result = evaluate_high_confidence(**base_inputs(score_total=84.9))
    assert result.passes is False
    assert any("score_total" in r for r in result.failed_reasons)


def test_only_2_indicators_aligned_fails():
    result = evaluate_high_confidence(**base_inputs(indicators_aligned=2))
    assert result.passes is False


def test_price_below_sma200_fails():
    result = evaluate_high_confidence(**base_inputs(price_above_sma200=False))
    assert result.passes is False


def test_low_volume_fails():
    result = evaluate_high_confidence(**base_inputs(volume_ratio=1.2))
    assert result.passes is False


def test_event_in_48h_fails():
    result = evaluate_high_confidence(**base_inputs(has_event_in_48h=True))
    assert result.passes is False


def test_low_rr_fails():
    result = evaluate_high_confidence(**base_inputs(risk_reward_ratio=1.5))
    assert result.passes is False


def test_score_not_sustained_fails():
    result = evaluate_high_confidence(**base_inputs(score_history=[60, 65, 82]))
    assert result.passes is False


def test_high_spread_fails():
    result = evaluate_high_confidence(**base_inputs(bid_ask_spread_pct=0.005))
    assert result.passes is False


def test_risk_off_regime_fails():
    result = evaluate_high_confidence(**base_inputs(market_regime="risk_off"))
    assert result.passes is False
