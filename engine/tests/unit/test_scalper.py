"""Tests del scalper con store y mercado falsos (sin red ni DB)."""
import asyncio
from datetime import datetime, timedelta, timezone
import numpy as np
import pandas as pd
import pytest

from src.scalper.indicators import scalp_score, entry_signal, merged_params
from src.scalper.session import tick
from src.scalper.detector import scan

T0 = datetime(2026, 11, 27, 15, 0, tzinfo=timezone.utc)


def candles(n=200, start=100.0, drift=0.0, noise=0.0005, vol=100.0, seed=1, end=T0):
    rng = np.random.default_rng(seed)
    rets = drift + rng.normal(0, noise, n)
    close = start * np.cumprod(1 + rets)
    open_ = np.concatenate([[start], close[:-1]])
    high = np.maximum(open_, close) * (1 + abs(rng.normal(0, noise / 2, n)))
    low = np.minimum(open_, close) * (1 - abs(rng.normal(0, noise / 2, n)))
    ts = [end - timedelta(minutes=n - 1 - i) for i in range(n)]
    return pd.DataFrame({"ts": ts, "open": open_, "high": high, "low": low, "close": close,
                         "volume": vol * (1 + rng.random(n) * 0.2)})


def with_breakout(df, pct=0.0012, vol_mult=4.0):
    """La anteúltima vela (última cerrada) rompe el máximo con volumen; la última queda en formación."""
    df = df.copy()
    i = len(df) - 2
    level = df["high"].iloc[i - 20:i].max()
    c = level * (1 + pct)
    df.loc[i, ["open", "high", "low", "close"]] = [df["close"].iloc[i - 1], c * 1.0002, df["close"].iloc[i - 1] * 0.9998, c]
    df.loc[i, "volume"] = df["volume"].iloc[i - 20:i].mean() * vol_mult
    df.loc[i + 1, ["open", "high", "low", "close"]] = [c, c * 1.0001, c * 0.9999, c]
    return df


class FakeMarket:
    def __init__(self, df, bid, ask):
        self.df, self.bid, self.ask = df, bid, ask

    async def fetch_candles(self, symbol, limit=360):
        return self.df

    async def fetch_quote(self, symbol):
        return self.bid, self.ask


class FakeStore:
    def __init__(self, session=None, cfg=None, cash=68.0):
        self.session, self.cfg, self.cash = session, cfg or {}, cash
        self.trades, self.ledger, self.alerts, self.scan_rows, self.opps = [], [], [], {}, []
        self.kill = False

    async def live_session(self):
        s = self.session
        return s if s and s["status"] in ("requested", "active") else None

    async def update_session(self, sid, data): self.session.update(data)
    async def open_trade(self, sid): return next((t for t in self.trades if t["status"] == "open"), None)

    async def insert_trade(self, data):
        row = {"id": f"t{len(self.trades)}", "breakeven_moved": False, **data}
        self.trades.append(row)
        return row

    async def update_trade(self, tid, data): next(t for t in self.trades if t["id"] == tid).update(data)
    async def insert_ledger_trade(self, data): self.ledger.append(data)
    async def insert_alert(self, level, category, title, message, metadata): self.alerts.append((level, category, title, message))
    async def kill_active(self): return self.kill
    async def pool_cash(self, pool): return self.cash
    async def config(self): return self.cfg
    async def upsert_scan(self, row): self.scan_rows[row["symbol"]] = row
    async def last_opportunity_at(self, symbol):
        xs = [o["at"] for o in self.opps if o["symbol"] == symbol]
        return max(xs) if xs else None
    async def insert_opportunity(self, row): self.opps.append({**row, "at": self._now})


def new_session(**kw):
    base = {"id": "s1", "symbol": "SOL/USDT", "strategy": "scalper_momentum_1m", "duration_min": 30,
            "max_capital_usd": 25, "max_trades": 5, "status": "requested", "stop_requested": False,
            "requested_at": T0.isoformat(), "trades_count": 0, "wins": 0, "losses": 0, "consecutive_losses": 0,
            "realized_pnl_usd": 0, "peak_pnl_usd": 0, "low_score_streak": 0, "last_score": None,
            "last_note": None, "cooldown_until": None, "params": {}}
    base.update(kw)
    return base


def run(coro):
    return asyncio.run(coro)


# Mercado "vivo": tendencia + ruido suficiente para pasar el piso de ATR
LIVE = dict(n=300, drift=0.00015, noise=0.0012, seed=3)


def test_score_dead_market_is_low_and_vetoed():
    score, comp, note = scalp_score(candles(n=300, noise=0.00005))
    assert score <= 30
    assert "comisiones" in note


def test_score_crash_is_capped():
    df = candles(**LIVE)
    df.loc[len(df) - 10:, ["open", "high", "low", "close"]] *= 0.95
    score, _, note = scalp_score(df)
    assert score <= 25 and "caída" in note


def test_entry_requires_volume():
    df = with_breakout(candles(**LIVE), vol_mult=1.0)
    px = float(df["close"].iloc[-1])
    sig = entry_signal(df, px * 0.9999, px * 1.0001)
    assert not sig.ok and "volumen" in sig.reason


def test_entry_ok_and_levels():
    df = with_breakout(candles(**LIVE))
    px = float(df["close"].iloc[-1])
    sig = entry_signal(df, px * 0.9999, px * 1.0001)
    assert sig.ok, sig.reason
    p = merged_params(None)
    assert p["min_risk_pct"] <= sig.risk_pct <= p["max_risk_pct"]
    assert sig.stop < sig.entry < sig.target
    assert abs((sig.target - sig.entry) / (sig.entry - sig.stop) - p["target_rr"]) < 1e-6


def test_entry_rejects_wide_spread_and_chase():
    df = with_breakout(candles(**LIVE))
    px = float(df["close"].iloc[-1])
    assert "spread" in entry_signal(df, px * 0.998, px * 1.0001).reason
    assert "escapó" in entry_signal(df, px * 1.0029, px * 1.003).reason


def _open_position(store, df):
    px = float(df["close"].iloc[-1])
    mkt = FakeMarket(df, px * 0.9999, px * 1.0001)
    run(tick(store, mkt, T0 + timedelta(seconds=15)))
    assert store.session["status"] == "active"
    assert store.session["capital_usd"] == 25
    assert len(store.trades) == 1, store.session["last_note"]
    return mkt, store.trades[0]


def test_stale_request_is_rejected():
    store = FakeStore(new_session())
    run(tick(store, FakeMarket(candles(), 100, 100.01), T0 + timedelta(minutes=9)))
    assert store.session["status"] == "rejected" and store.session["stop_reason"] == "engine_offline"


def test_insufficient_cash_rejected():
    store = FakeStore(new_session(), cash=4.0)
    run(tick(store, FakeMarket(candles(), 100, 100.01), T0 + timedelta(seconds=5)))
    assert store.session["stop_reason"] == "insufficient_cash"


def test_target_hit_books_net_profit():
    store = FakeStore(new_session())
    mkt, tr = _open_position(store, with_breakout(candles(**LIVE)))
    mkt.bid = tr["target_price"] * 1.0005
    mkt.ask = mkt.bid * 1.0002
    run(tick(store, mkt, T0 + timedelta(seconds=45)))
    assert tr["status"] == "closed" and tr["exit_reason"] == "target"
    assert tr["exit_price"] == tr["target_price"]
    gross = (tr["exit_price"] - tr["entry_price"]) * tr["size_units"]
    assert 0 < tr["pnl_usd"] < gross  # comisión de ambos lados descontada
    assert store.ledger[0]["pool"] == "tactical" and store.ledger[0]["strategy_name"] == "scalper_momentum_1m"
    assert store.session["wins"] == 1 and store.session["status"] == "active"


def test_breakeven_then_stop_never_loses():
    store = FakeStore(new_session())
    mkt, tr = _open_position(store, with_breakout(candles(**LIVE)))
    r = tr["entry_price"] - tr["initial_stop"]
    mkt.bid = tr["entry_price"] + 1.1 * r
    run(tick(store, mkt, T0 + timedelta(seconds=30)))
    assert tr["breakeven_moved"] and tr["stop_price"] > tr["entry_price"]
    mkt.bid = tr["stop_price"] * 0.99995
    run(tick(store, mkt, T0 + timedelta(seconds=45)))
    assert tr["exit_reason"] == "breakeven_stop"
    assert tr["pnl_usd"] > -0.01  # ~0 neto


def test_two_losses_stop_the_session():
    store = FakeStore(new_session(consecutive_losses=1, losses=1, trades_count=1, realized_pnl_usd=-0.15))
    mkt, tr = _open_position(store, with_breakout(candles(**LIVE)))
    mkt.bid = tr["stop_price"] * 0.9999
    run(tick(store, mkt, T0 + timedelta(seconds=30)))
    assert tr["exit_reason"] == "stop" and tr["pnl_usd"] < 0
    assert store.session["status"] == "stopped" and store.session["stop_reason"] == "consecutive_losses"
    assert store.alerts[-1][0] == "warn"


def test_time_stop_on_stalled_trade():
    store = FakeStore(new_session())
    mkt, tr = _open_position(store, with_breakout(candles(**LIVE)))
    run(tick(store, mkt, T0 + timedelta(minutes=11)))
    assert tr["exit_reason"] == "time_stop"


def test_expiry_flattens_and_completes():
    store = FakeStore(new_session(duration_min=15))
    mkt, tr = _open_position(store, with_breakout(candles(**LIVE)))
    mkt.bid = tr["entry_price"] * 1.002
    run(tick(store, mkt, T0 + timedelta(minutes=16)))
    assert tr["exit_reason"] in ("session_end", "time_stop")
    assert store.session["status"] == "completed" and store.session["stop_reason"] == "time_expired"
    assert not [t for t in store.trades if t["status"] == "open"]


def test_manual_stop_and_kill_switch():
    store = FakeStore(new_session())
    mkt, tr = _open_position(store, with_breakout(candles(**LIVE)))
    store.session["stop_requested"] = True
    run(tick(store, mkt, T0 + timedelta(seconds=30)))
    assert store.session["stop_reason"] == "manual" and tr["status"] == "closed"

    store = FakeStore(new_session())
    mkt, tr = _open_position(store, with_breakout(candles(**LIVE)))
    store.kill = True
    run(tick(store, mkt, T0 + timedelta(seconds=30)))
    assert store.session["stop_reason"] == "kill_switch" and tr["status"] == "closed"


def test_loss_limit_counts_unrealized():
    store = FakeStore(new_session(realized_pnl_usd=-0.45, losses=1, trades_count=1), cfg={"max_consecutive_losses": 9})
    mkt, tr = _open_position(store, with_breakout(candles(**LIVE)))
    mkt.bid = tr["entry_price"] * (1 - 0.0025)  # arriba del stop, pero -0.45 + latente supera el 2% de $25
    run(tick(store, mkt, T0 + timedelta(seconds=30)))
    assert store.session["stop_reason"] == "loss_limit" and tr["exit_reason"] == "session_end"


def test_regime_deterioration_stops_flat_session():
    dead = candles(n=300, noise=0.00005)
    store = FakeStore(new_session(status="active", started_at=T0.isoformat(),
                                  ends_at=(T0 + timedelta(minutes=30)).isoformat(), capital_usd=25, params={}))
    for i in range(1, 4):
        df = dead.copy()
        df["ts"] = df["ts"] + timedelta(minutes=i)
        run(tick(store, FakeMarket(df, 100, 100.01), T0 + timedelta(minutes=i)))
    assert store.session["stop_reason"] == "regime_deteriorated"
    assert store.trades == []


def test_no_entry_in_last_minutes_and_one_entry_per_candle():
    store = FakeStore(new_session(status="active", started_at=T0.isoformat(),
                                  ends_at=(T0 + timedelta(minutes=2)).isoformat(), capital_usd=25, params={}))
    df = with_breakout(candles(**LIVE))
    px = float(df["close"].iloc[-1])
    run(tick(store, FakeMarket(df, px * 0.9999, px * 1.0001), T0 + timedelta(seconds=15)))
    assert store.trades == [] and "últimos" in store.session["last_note"]


def test_detector_alerts_once_with_cooldown_and_mutes_during_session():
    df = with_breakout(candles(n=400, drift=0.0004, noise=0.0015, seed=5))
    df.loc[len(df) - 62:, "volume"] *= 3
    score, comp, _ = scalp_score(df)
    store = FakeStore(cfg={"watchlist": ["SOL/USDT"], "alert_threshold": min(75, score - 1)})
    store._now = T0
    assert run(scan(store, FakeMarket(df, 1, 1), T0)) == [{"symbol": "SOL/USDT", "score": score}]
    assert store.scan_rows["SOL/USDT"]["score"] == score
    assert store.alerts[0][1] == "scalper_opportunity"
    assert run(scan(store, FakeMarket(df, 1, 1), T0 + timedelta(minutes=10))) == []   # cooldown
    store.opps.clear()
    store.session = new_session(status="active")
    assert run(scan(store, FakeMarket(df, 1, 1), T0 + timedelta(minutes=20))) == []   # sesión viva
