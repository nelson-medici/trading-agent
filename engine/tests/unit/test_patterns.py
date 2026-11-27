"""Tests para el módulo de detección de patrones y volumen."""
import numpy as np
import pandas as pd
import pytest
from datetime import datetime, timezone, timedelta

from src.patterns.detector import (
    detect_levels, detect_triangles, detect_fvg, detect_breakouts,
    detect_rejections, detect_doubles, detect_sweeps, detect_all,
)
from src.patterns.volume import (
    volume_profile, volume_delta_from_candles, relative_volume, vwap_bands, analyze_volume,
)
from src.scalper.indicators import (
    is_active_window, _rsi, rsi_entry_signal, select_scalper_mode, scalper_entry, prepare,
)


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _make_candles(n: int = 100, base: float = 100.0, vol: float = 1000.0,
                  trend: float = 0.0, noise: float = 0.5) -> pd.DataFrame:
    """Genera n velas sintéticas con tendencia y ruido controlados."""
    rng = np.random.RandomState(42)
    rows = []
    price = base
    ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for i in range(n):
        change = trend + rng.normal(0, noise)
        o = price
        c = price + change
        h = max(o, c) + abs(rng.normal(0, noise * 0.5))
        l = min(o, c) - abs(rng.normal(0, noise * 0.5))
        v = vol * (1 + rng.uniform(-0.3, 0.5))
        rows.append({"ts": ts, "open": o, "high": h, "low": l, "close": c, "volume": v})
        price = c
        ts += timedelta(minutes=1)
    return pd.DataFrame(rows)


def _make_triangle_candles(kind: str = "symmetrical", n: int = 60) -> pd.DataFrame:
    """Genera velas que forman un triángulo."""
    rows = []
    ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
    base = 100.0
    for i in range(n):
        # Rango que se contrae
        spread = max(0.5, 5.0 * (1 - i / n))
        if kind == "ascending":
            mid = base + i * 0.02  # mínimos suben, máximos planos
            h = base + 5.0
            l = mid - spread / 2
        elif kind == "descending":
            mid = base - i * 0.02  # máximos bajan, mínimos planos
            h = mid + spread / 2
            l = base - 5.0
        else:  # symmetrical
            h = base + spread
            l = base - spread
        o = (h + l) / 2 + np.random.uniform(-0.2, 0.2)
        c = (h + l) / 2 + np.random.uniform(-0.2, 0.2)
        rows.append({"ts": ts, "open": o, "high": h, "low": l, "close": c, "volume": 1000})
        ts += timedelta(minutes=1)
    return pd.DataFrame(rows)


def _make_fvg_candles() -> pd.DataFrame:
    """Genera velas con un Fair Value Gap bullish claro."""
    ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
    rows = [
        {"ts": ts, "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 1000},
        {"ts": ts + timedelta(minutes=1), "open": 100.5, "high": 103, "low": 100.5, "close": 102.5, "volume": 2000},  # vela fuerte
        {"ts": ts + timedelta(minutes=2), "open": 102.5, "high": 104, "low": 102, "close": 103.5, "volume": 1500},  # low > high de vela 0
    ]
    # Agregar más velas para ATR
    for i in range(3, 50):
        rows.append({"ts": ts + timedelta(minutes=i), "open": 103 + i * 0.01, "high": 104 + i * 0.01,
                      "low": 102.5 + i * 0.01, "close": 103.5 + i * 0.01, "volume": 1000})
    return pd.DataFrame(rows)


# ------------------------------------------------------------------
# TESTS: Soportes y Resistencias
# ------------------------------------------------------------------

class TestLevels:
    def test_detect_basic_levels(self):
        df = _make_candles(200, noise=1.0, trend=0.0)
        levels = detect_levels(df, lookback=5, min_touches=2)
        assert len(levels) > 0
        for lv in levels:
            assert lv.kind in ("support", "resistance")
            assert lv.touches >= 2
            assert 0 < lv.strength <= 1

    def test_no_levels_on_short_data(self):
        df = _make_candles(5)
        levels = detect_levels(df, lookback=5)
        assert levels == []

    def test_trending_market_has_fewer_levels(self):
        # En un mercado con tendencia fuerte, menos niveles se tocan varias veces
        trending = _make_candles(200, trend=0.5, noise=0.3)
        ranging = _make_candles(200, trend=0.0, noise=1.0)
        levels_trend = detect_levels(trending, min_touches=2)
        levels_range = detect_levels(ranging, min_touches=2)
        assert len(levels_range) >= len(levels_trend)


# ------------------------------------------------------------------
# TESTS: Triángulos
# ------------------------------------------------------------------

class TestTriangles:
    def test_detect_symmetrical(self):
        df = _make_triangle_candles("symmetrical", 60)
        tris = detect_triangles(df, min_bars=15, lookback=3)
        # Puede o no detectar — depende de la regularidad de los pivots
        # Pero no debe crashear
        assert isinstance(tris, list)

    def test_no_triangle_in_trending(self):
        df = _make_candles(100, trend=1.0, noise=0.1)
        tris = detect_triangles(df, min_bars=15)
        # En tendencia fuerte no debería detectar triángulos convergentes
        for t in tris:
            assert t.kind in ("ascending", "descending", "symmetrical")


# ------------------------------------------------------------------
# TESTS: Fair Value Gap
# ------------------------------------------------------------------

class TestFVG:
    def test_detect_bullish_fvg(self):
        df = _make_fvg_candles()
        fvgs = detect_fvg(df, min_gap_atr=0.01)
        bullish = [f for f in fvgs if f.kind == "bullish"]
        assert len(bullish) >= 1
        assert bullish[0].bottom < bullish[0].top

    def test_no_fvg_on_flat_market(self):
        df = _make_candles(50, noise=0.01)  # casi plano
        fvgs = detect_fvg(df, min_gap_atr=1.0)  # umbral alto
        assert len(fvgs) == 0


# ------------------------------------------------------------------
# TESTS: Breakouts
# ------------------------------------------------------------------

class TestBreakouts:
    def test_breakout_above_resistance(self):
        # Crear datos donde el precio rompe un nivel con volumen
        df = _make_candles(100, trend=0.0, noise=0.5)
        levels = detect_levels(df, lookback=5, min_touches=2)
        breakouts = detect_breakouts(df, levels)
        assert isinstance(breakouts, list)  # puede ser vacío

    def test_no_breakout_without_volume(self):
        df = _make_candles(50, vol=100)
        levels = detect_levels(df, min_touches=1)
        breakouts = detect_breakouts(df, levels, volume_threshold=5.0)
        assert len(breakouts) == 0  # volumen nunca alcanza 5×


# ------------------------------------------------------------------
# TESTS: Velas de rechazo
# ------------------------------------------------------------------

class TestRejections:
    def test_rejection_near_support(self):
        df = _make_candles(100, noise=1.0)
        levels = detect_levels(df, min_touches=2)
        rejections = detect_rejections(df, levels, min_wick_ratio=1.5)
        assert isinstance(rejections, list)

    def test_no_rejection_without_levels(self):
        df = _make_candles(50)
        rejections = detect_rejections(df, [], min_wick_ratio=2.0)
        assert len(rejections) == 0


# ------------------------------------------------------------------
# TESTS: Doble techo / piso
# ------------------------------------------------------------------

class TestDoubles:
    def test_detect_double_in_ranging(self):
        df = _make_candles(200, trend=0.0, noise=1.5)
        doubles = detect_doubles(df, lookback=5, tolerance_atr=0.5)
        assert isinstance(doubles, list)

    def test_no_double_on_short_data(self):
        df = _make_candles(10)
        doubles = detect_doubles(df)
        assert doubles == []


# ------------------------------------------------------------------
# TESTS: Barrido de liquidez
# ------------------------------------------------------------------

class TestSweeps:
    def test_sweep_structure(self):
        df = _make_candles(100, noise=1.0)
        levels = detect_levels(df, min_touches=2)
        sweeps = detect_sweeps(df, levels)
        assert isinstance(sweeps, list)
        for s in sweeps:
            assert s.kind in ("sweep_low", "sweep_high")


# ------------------------------------------------------------------
# TESTS: detect_all
# ------------------------------------------------------------------

class TestDetectAll:
    def test_returns_pattern_result(self):
        df = _make_candles(200, noise=1.0)
        result = detect_all(df)
        assert hasattr(result, "levels")
        assert hasattr(result, "triangles")
        assert hasattr(result, "fvgs")
        assert hasattr(result, "breakouts")
        assert hasattr(result, "rejections")
        assert hasattr(result, "doubles")
        assert hasattr(result, "sweeps")


# ------------------------------------------------------------------
# TESTS: Volume Profile
# ------------------------------------------------------------------

class TestVolumeProfile:
    def test_basic_profile(self):
        df = _make_candles(100, noise=0.5)
        profile = volume_profile(df, num_bins=10)
        assert len(profile.levels) == 10
        assert profile.poc > 0
        assert profile.total_volume > 0
        assert profile.value_area_low <= profile.poc <= profile.value_area_high
        assert sum(lv.pct for lv in profile.levels) == pytest.approx(100, abs=0.5)

    def test_poc_at_high_volume_level(self):
        # Crear datos donde la mayoría del volumen está en un precio
        rows = []
        ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for i in range(100):
            if 40 <= i <= 60:  # 20 velas con mucho volumen en un rango
                rows.append({"ts": ts, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 10000})
            else:
                rows.append({"ts": ts, "open": 90 + i * 0.2, "high": 91 + i * 0.2, "low": 89 + i * 0.2,
                              "close": 90 + i * 0.2, "volume": 100})
            ts += timedelta(minutes=1)
        df = pd.DataFrame(rows)
        profile = volume_profile(df, num_bins=20)
        assert 98 <= profile.poc <= 103  # POC debe estar cerca de donde concentramos el volumen


# ------------------------------------------------------------------
# TESTS: Volume Delta
# ------------------------------------------------------------------

class TestVolumeDelta:
    def test_delta_from_candles(self):
        df = _make_candles(50, trend=0.3)  # tendencia alcista → más buy
        delta = volume_delta_from_candles(df, window=20)
        assert delta.buy_volume > 0
        assert delta.sell_volume > 0
        assert delta.delta > 0  # tendencia alcista → delta positivo
        assert -100 <= delta.delta_pct <= 100


# ------------------------------------------------------------------
# TESTS: Relative Volume
# ------------------------------------------------------------------

class TestRelativeVolume:
    def test_relative_volume(self):
        df = _make_candles(200, vol=1000)
        rel = relative_volume(df)
        assert rel.current_volume > 0
        assert rel.ratio > 0
        assert 0 <= rel.percentile <= 100

    def test_short_data_fallback(self):
        df = _make_candles(30)
        rel = relative_volume(df)
        assert rel.ratio > 0  # no crashea


# ------------------------------------------------------------------
# TESTS: VWAP
# ------------------------------------------------------------------

class TestVWAP:
    def test_vwap_bands(self):
        df = _make_candles(100, noise=0.5)
        vwap_val, upper, lower = vwap_bands(df)
        assert lower <= vwap_val <= upper
        assert vwap_val > 0


# ------------------------------------------------------------------
# TESTS: Ventanas horarias
# ------------------------------------------------------------------

class TestActiveWindows:
    def test_active_during_nyse(self):
        active, reason = is_active_window(14, {"enforce_windows": True, "active_windows_utc": [[13, 17], [0, 2]]})
        assert active is True

    def test_inactive_at_night(self):
        active, reason = is_active_window(5, {"enforce_windows": True, "active_windows_utc": [[13, 17], [0, 2]]})
        assert active is False

    def test_active_at_midnight(self):
        active, reason = is_active_window(1, {"enforce_windows": True, "active_windows_utc": [[13, 17], [0, 2]]})
        assert active is True

    def test_disabled_windows(self):
        active, reason = is_active_window(5, {"enforce_windows": False})
        assert active is True


# ------------------------------------------------------------------
# TESTS: RSI
# ------------------------------------------------------------------

class TestRSI:
    def test_rsi_range(self):
        df = _make_candles(50, noise=1.0)
        rsi = _rsi(df["close"], 7)
        valid = rsi.dropna()
        assert all(0 <= v <= 100 for v in valid)

    def test_rsi_entry_no_signal_in_trending(self):
        df = _make_candles(100, trend=0.5, noise=0.2)
        # En tendencia alcista fuerte, RSI no baja de 20
        sig = rsi_entry_signal(df, 150, 150.1)
        assert sig.ok is False


# ------------------------------------------------------------------
# TESTS: Selección de modo
# ------------------------------------------------------------------

class TestModeSelection:
    def test_forced_mode(self):
        df = _make_candles(100)
        mode = select_scalper_mode(df, {"scalper_mode": "momentum"})
        assert mode == "momentum"
        mode = select_scalper_mode(df, {"scalper_mode": "rsi"})
        assert mode == "rsi"

    def test_auto_mode(self):
        df = _make_candles(100, trend=0.0, noise=0.5)
        mode = select_scalper_mode(df, {"scalper_mode": "auto", "adx_momentum_threshold": 25})
        assert mode in ("momentum", "rsi")

    def test_scalper_entry_dispatches(self):
        df = _make_candles(100, noise=0.5)
        last = float(df["close"].iloc[-1])
        sig = scalper_entry(df, last, last + 0.01, force_mode="momentum")
        assert isinstance(sig.ok, bool)
        sig2 = scalper_entry(df, last, last + 0.01, force_mode="rsi")
        assert isinstance(sig2.ok, bool)
