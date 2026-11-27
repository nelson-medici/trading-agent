"""
Indicadores y reglas puras del scalper (sin I/O, testeables).

Todo opera sobre un DataFrame de velas de 1 minuto con columnas
ts/open/high/low/close/volume, ordenado ascendente. La ÚLTIMA fila se asume
en formación (vela abierta) y se descarta para las señales.
"""
from dataclasses import dataclass, field
import numpy as np
import pandas as pd


DEFAULTS = {
    # Entrada
    "breakout_lookback": 15,
    "volume_mult": 1.5,
    "max_spread_pct": 0.0005,
    "max_chase_pct": 0.0015,        # no perseguir si el ask ya se alejó del cierre de ruptura
    "max_extension_atr": 3.0,       # cierre no más de N×ATR por encima de la EMA9
    "max_body_atr": 4.0,            # vela de ruptura no "exhausta"
    # Riesgo por trade
    "risk_atr_mult": 1.5,
    "min_risk_pct": 0.003,
    "max_risk_pct": 0.006,
    "min_atr_pct": 0.0006,          # por debajo de esto el target no es alcanzable neto de comisión
    "target_rr": 2.0,
    "commission_per_side_pct": 0.001,
    # Gestión
    "breakeven_at_r": 1.0,
    "trail_at_r": 1.5,
    "time_stop_min": 10,
    "time_stop_min_r": 0.25,
    "cooldown_after_loss_min": 3,
    "no_entry_last_min": 3,
    # Cortes de sesión
    "max_consecutive_losses": 2,
    "max_session_loss_pct": 0.02,
    "profit_lock_trigger_pct": 0.015,
    "profit_lock_giveback": 0.5,
    "min_regime_score": 40,
    "regime_streak_to_stop": 3,
    "flash_crash_pct": 0.015,
    # Detector
    "alert_threshold": 75,
    "alert_cooldown_min": 60,
}


def merged_params(cfg: dict | None) -> dict:
    out = dict(DEFAULTS)
    for k, v in (cfg or {}).items():
        if v is not None:
            out[k] = v
    return out


def prepare(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    for c in ("open", "high", "low", "close", "volume"):
        df[c] = pd.to_numeric(df[c])
    return df.sort_values("ts").drop_duplicates("ts").reset_index(drop=True)


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    pc = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def adx(df: pd.DataFrame, n: int = 14) -> tuple[float, float, float]:
    """Devuelve (adx, +DI, -DI) del último valor."""
    if len(df) < n * 2:
        return 0.0, 0.0, 0.0
    up = df["high"].diff()
    dn = -df["low"].diff()
    plus_dm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=df.index)
    pc = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)
    atr_ = tr.ewm(alpha=1 / n, adjust=False).mean().replace(0, np.nan)
    pdi = 100 * plus_dm.ewm(alpha=1 / n, adjust=False).mean() / atr_
    mdi = 100 * minus_dm.ewm(alpha=1 / n, adjust=False).mean() / atr_
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    adx_ = dx.ewm(alpha=1 / n, adjust=False).mean()
    f = lambda x: float(x) if pd.notna(x) else 0.0
    return f(adx_.iloc[-1]), f(pdi.iloc[-1]), f(mdi.iloc[-1])


def resample_5m(df: pd.DataFrame) -> pd.DataFrame:
    g = df.set_index("ts").resample("5min")
    out = pd.DataFrame({
        "open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
        "close": g["close"].last(), "volume": g["volume"].sum(),
    }).dropna().reset_index()
    return out


def _clip01(x: float) -> float:
    return float(max(0.0, min(1.0, x)))


# ------------------------------------------------------------------
# SCALP SCORE: ¿este mercado está "scalpeable" ahora?
# ------------------------------------------------------------------

def scalp_score(df: pd.DataFrame, params: dict | None = None) -> tuple[float, dict, str]:
    """
    Score 0-100 de aptitud para scalping long en 1m.
    Componentes: volatilidad (25) · volumen relativo (25) · rango (20) ·
    tendencia alcista (20) · ausencia de flash crash (10).
    """
    p = merged_params(params)
    d = prepare(df).iloc[:-1]  # solo velas cerradas
    if len(d) < 90:
        return 0.0, {}, "datos insuficientes"

    close = d["close"]
    last = float(close.iloc[-1])
    atr_pct = (atr(d) / close).iloc[-360:]
    atr_last = float(atr_pct.iloc[-1])
    vol_rank = float((atr_pct <= atr_last).mean())  # percentil del ATR actual

    v = d["volume"]
    recent = float(v.iloc[-60:].sum())
    prior = v.iloc[:-60]
    prior_per_hour = float(prior.sum()) / (len(prior) / 60) if len(prior) >= 30 else 0.0
    vol_ratio = recent / prior_per_hour if prior_per_hour > 0 else 1.0

    rng5 = float((d["high"].iloc[-5:].max() - d["low"].iloc[-5:].min()) / last)

    adx_v, pdi, mdi = adx(resample_5m(d))
    up_bias = pdi > mdi and last > float(ema(close, 50).iloc[-1])

    ret15 = float(last / close.iloc[-16] - 1) if len(close) > 16 else 0.0
    crashed = ret15 <= -2 * p["flash_crash_pct"]

    comp = {
        "volatility": round(vol_rank * 100, 1),
        "volume": round(_clip01((vol_ratio - 0.8) / 1.2) * 100, 1),
        "range": round(_clip01(rng5 / 0.006) * 100, 1),
        "trend": round(_clip01((adx_v - 15) / 20) * 100 * (1.0 if up_bias else 0.3), 1),
        "no_crash": 0.0 if crashed else 100.0,
        "atr_pct": round(atr_last * 100, 4),
        "vol_ratio": round(vol_ratio, 2),
        "range5_pct": round(rng5 * 100, 3),
        "adx": round(adx_v, 1),
        "up_bias": bool(up_bias),
        "ret15_pct": round(ret15 * 100, 2),
    }
    score = (0.25 * comp["volatility"] + 0.25 * comp["volume"] + 0.20 * comp["range"]
             + 0.20 * comp["trend"] + 0.10 * comp["no_crash"])

    note = ""
    if crashed:
        score = min(score, 25.0)
        note = f"caída de {ret15 * 100:.1f}% en 15 min"
    elif atr_last < p["min_atr_pct"]:
        score = min(score, 30.0)
        note = "volatilidad insuficiente para cubrir comisiones"
    elif not up_bias:
        score = min(score, 65.0)
        note = "sin sesgo alcista (el scalper es solo long)"
    return round(float(score), 1), comp, note


def flash_crash(df: pd.DataFrame, pct: float, minutes: int = 5) -> float | None:
    """Retorno de los últimos `minutes` si es peor que -pct; si no, None."""
    d = prepare(df)
    if len(d) <= minutes:
        return None
    ret = float(d["close"].iloc[-1] / d["close"].iloc[-1 - minutes] - 1)
    return ret if ret <= -pct else None


# ------------------------------------------------------------------
# SEÑAL DE ENTRADA: ruptura con volumen + filtros
# ------------------------------------------------------------------

@dataclass
class EntrySignal:
    ok: bool
    reason: str
    candle_ts: str = ""
    entry: float = 0.0
    stop: float = 0.0
    target: float = 0.0
    risk_pct: float = 0.0
    detail: dict = field(default_factory=dict)


def entry_signal(df: pd.DataFrame, bid: float, ask: float, params: dict | None = None) -> EntrySignal:
    p = merged_params(params)
    d = prepare(df).iloc[:-1]  # la última vela está en formación
    n = int(p["breakout_lookback"])
    if len(d) < max(n + 2, 60):
        return EntrySignal(False, "datos insuficientes")
    if bid <= 0 or ask <= 0:
        return EntrySignal(False, "sin cotización")

    sig = d.iloc[-1]
    prev = d.iloc[-1 - n:-1]
    close = float(sig["close"])
    ts = sig["ts"].isoformat()

    a = float(atr(d).iloc[-1])
    atr_pct = a / close if close > 0 else 0.0
    if atr_pct < p["min_atr_pct"]:
        return EntrySignal(False, f"ATR {atr_pct * 100:.3f}% muy bajo: el target no cubre comisiones", ts)

    level = float(prev["high"].max())
    if close <= level:
        return EntrySignal(False, f"sin ruptura: cierre {close:.6g} ≤ máx {n} velas {level:.6g}", ts)

    avg_vol = float(d["volume"].iloc[-21:-1].mean())
    vol = float(sig["volume"])
    if avg_vol <= 0 or vol < p["volume_mult"] * avg_vol:
        ratio = vol / avg_vol if avg_vol > 0 else 0
        return EntrySignal(False, f"ruptura sin volumen ({ratio:.1f}× < {p['volume_mult']}×)", ts)

    e9 = float(ema(d["close"], 9).iloc[-1])
    e21 = float(ema(d["close"], 21).iloc[-1])
    if not (e9 > e21):
        return EntrySignal(False, "EMA9 ≤ EMA21: micro-tendencia no acompaña", ts)

    w = d.iloc[-120:]
    tp = (w["high"] + w["low"] + w["close"]) / 3
    vwap = float((tp * w["volume"]).sum() / w["volume"].sum()) if float(w["volume"].sum()) > 0 else close
    if close < vwap:
        return EntrySignal(False, "precio por debajo del VWAP de 2h", ts)

    if close - e9 > p["max_extension_atr"] * a:
        return EntrySignal(False, "sobre-extendido respecto de EMA9 (riesgo de reversión)", ts)
    if abs(close - float(sig["open"])) > p["max_body_atr"] * a:
        return EntrySignal(False, f"vela de ruptura exhausta (cuerpo > {p['max_body_atr']}×ATR)", ts)

    mid = (bid + ask) / 2
    spread = (ask - bid) / mid
    if spread > p["max_spread_pct"]:
        return EntrySignal(False, f"spread {spread * 100:.3f}% demasiado alto", ts)
    if ask > close * (1 + p["max_chase_pct"]):
        return EntrySignal(False, "el precio ya se escapó de la ruptura (no perseguir)", ts)
    if ask < level:
        return EntrySignal(False, "ruptura fallida: precio volvió debajo del nivel", ts)

    risk_pct = float(min(max(p["risk_atr_mult"] * atr_pct, p["min_risk_pct"]), p["max_risk_pct"]))
    entry = ask
    stop = entry * (1 - risk_pct)
    target = entry * (1 + risk_pct * p["target_rr"])
    return EntrySignal(True, f"ruptura de {n} velas con volumen {vol / avg_vol:.1f}×", ts, entry, stop, target, risk_pct, {
        "level": level, "atr_pct": atr_pct, "vol_ratio": vol / avg_vol, "vwap": vwap, "spread": spread,
    })
