"""
Indicadores avanzados de volumen (sin I/O, testeables).

Opera sobre DataFrames de velas OHLCV. Para delta de volumen se necesita
un DataFrame de trades con columnas ts/price/qty/is_buyer_maker.

Indicadores:
  - Volume Profile (histograma por nivel de precio + POC)
  - Delta de volumen (buy vs sell pressure)
  - Volumen relativo por ventana horaria
  - Volume Weighted Average Price (VWAP) extendido
"""
from dataclasses import dataclass, field
import numpy as np
import pandas as pd


# ------------------------------------------------------------------
# Tipos
# ------------------------------------------------------------------

@dataclass
class VolumeProfileLevel:
    """Un nivel del histograma de volumen."""
    price_low: float
    price_high: float
    price_mid: float
    volume: float
    pct: float  # porcentaje del volumen total


@dataclass
class VolumeProfile:
    """Volume Profile completo."""
    levels: list[VolumeProfileLevel]
    poc: float  # Point of Control — nivel con más volumen
    poc_volume: float
    value_area_high: float  # 70% del volumen
    value_area_low: float
    total_volume: float


@dataclass
class VolumeDelta:
    """Delta de volumen para un período."""
    buy_volume: float
    sell_volume: float
    delta: float  # buy - sell
    delta_pct: float  # delta / total
    cumulative_delta: float  # delta acumulado


@dataclass
class RelativeVolume:
    """Volumen relativo vs el promedio para la ventana horaria actual."""
    current_volume: float
    expected_volume: float  # promedio para esta hora del día
    ratio: float  # current / expected
    percentile: float  # 0-100, percentil entre los últimos N períodos
    is_active: bool  # ratio > 1 → más activo de lo normal


@dataclass
class VolumeAnalysis:
    """Resultado completo del análisis de volumen."""
    profile: VolumeProfile | None = None
    delta: VolumeDelta | None = None
    relative: RelativeVolume | None = None
    vwap: float | None = None
    vwap_upper: float | None = None  # VWAP + 1 std
    vwap_lower: float | None = None  # VWAP - 1 std


# ------------------------------------------------------------------
# 1. VOLUME PROFILE
# ------------------------------------------------------------------

def volume_profile(df: pd.DataFrame, num_bins: int = 24, value_area_pct: float = 0.70) -> VolumeProfile:
    """
    Calcula el Volume Profile: histograma de volumen por nivel de precio.
    POC = nivel con más volumen acumulado.
    Value Area = rango que contiene value_area_pct del volumen total.
    """
    if len(df) < 5:
        return VolumeProfile(levels=[], poc=0, poc_volume=0,
                             value_area_high=0, value_area_low=0, total_volume=0)

    price_low = float(df["low"].min())
    price_high = float(df["high"].max())
    if price_high <= price_low:
        return VolumeProfile(levels=[], poc=float(df["close"].iloc[-1]), poc_volume=0,
                             value_area_high=price_high, value_area_low=price_low,
                             total_volume=float(df["volume"].sum()))

    bin_size = (price_high - price_low) / num_bins
    bins = np.zeros(num_bins)

    for _, row in df.iterrows():
        # Distribuir volumen de cada vela proporcionalmente entre los bins que cubre
        candle_low = float(row["low"])
        candle_high = float(row["high"])
        candle_vol = float(row["volume"])

        low_bin = max(0, int((candle_low - price_low) / bin_size))
        high_bin = min(num_bins - 1, int((candle_high - price_low) / bin_size))

        n_bins = high_bin - low_bin + 1
        if n_bins > 0:
            vol_per_bin = candle_vol / n_bins
            for b in range(low_bin, high_bin + 1):
                bins[b] += vol_per_bin

    total = float(bins.sum())
    if total <= 0:
        return VolumeProfile(levels=[], poc=float(df["close"].iloc[-1]), poc_volume=0,
                             value_area_high=price_high, value_area_low=price_low, total_volume=0)

    poc_bin = int(np.argmax(bins))
    poc_price = price_low + (poc_bin + 0.5) * bin_size

    # Value Area: expandir desde POC hasta cubrir value_area_pct
    va_volume = float(bins[poc_bin])
    target_volume = total * value_area_pct
    lo, hi = poc_bin, poc_bin

    while va_volume < target_volume:
        expand_lo = lo > 0
        expand_hi = hi < num_bins - 1
        if not expand_lo and not expand_hi:
            break

        lo_vol = float(bins[lo - 1]) if expand_lo else 0
        hi_vol = float(bins[hi + 1]) if expand_hi else 0

        if lo_vol >= hi_vol and expand_lo:
            lo -= 1
            va_volume += lo_vol
        elif expand_hi:
            hi += 1
            va_volume += hi_vol
        elif expand_lo:
            lo -= 1
            va_volume += lo_vol

    levels = []
    for b in range(num_bins):
        bl = price_low + b * bin_size
        bh = bl + bin_size
        levels.append(VolumeProfileLevel(
            price_low=round(bl, 8),
            price_high=round(bh, 8),
            price_mid=round(bl + bin_size / 2, 8),
            volume=round(float(bins[b]), 4),
            pct=round(float(bins[b]) / total * 100, 2),
        ))

    return VolumeProfile(
        levels=levels,
        poc=round(poc_price, 8),
        poc_volume=round(float(bins[poc_bin]), 4),
        value_area_high=round(price_low + (hi + 1) * bin_size, 8),
        value_area_low=round(price_low + lo * bin_size, 8),
        total_volume=round(total, 4),
    )


# ------------------------------------------------------------------
# 2. DELTA DE VOLUMEN
# ------------------------------------------------------------------

def volume_delta(trades_df: pd.DataFrame, window_minutes: int = 60) -> VolumeDelta:
    """
    Calcula delta de volumen (buy - sell) a partir de trades individuales.
    trades_df debe tener columnas: ts, price, qty, is_buyer_maker.
    is_buyer_maker=True → venta agresiva (taker sell), False → compra agresiva.
    """
    if trades_df is None or len(trades_df) < 1:
        return VolumeDelta(buy_volume=0, sell_volume=0, delta=0, delta_pct=0, cumulative_delta=0)

    df = trades_df.copy()
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    cutoff = df["ts"].max() - pd.Timedelta(minutes=window_minutes)
    recent = df[df["ts"] >= cutoff]

    if len(recent) == 0:
        return VolumeDelta(buy_volume=0, sell_volume=0, delta=0, delta_pct=0, cumulative_delta=0)

    qty = recent["qty"].astype(float)
    is_sell = recent["is_buyer_maker"].astype(bool)

    sell_vol = float(qty[is_sell].sum())
    buy_vol = float(qty[~is_sell].sum())
    total = buy_vol + sell_vol
    delta = buy_vol - sell_vol

    # Delta acumulado sobre todo el df
    all_qty = df["qty"].astype(float)
    all_sell = df["is_buyer_maker"].astype(bool)
    cum_delta = float(all_qty[~all_sell].sum() - all_qty[all_sell].sum())

    return VolumeDelta(
        buy_volume=round(buy_vol, 4),
        sell_volume=round(sell_vol, 4),
        delta=round(delta, 4),
        delta_pct=round(delta / total * 100, 2) if total > 0 else 0,
        cumulative_delta=round(cum_delta, 4),
    )


def volume_delta_from_candles(df: pd.DataFrame, window: int = 20) -> VolumeDelta:
    """
    Aproximación del delta de volumen usando velas OHLCV (sin trades individuales).
    Heurística: si close > open → volumen es "buy", si close < open → "sell".
    Ponderado por la posición del cierre dentro del rango.
    """
    if len(df) < window:
        return VolumeDelta(buy_volume=0, sell_volume=0, delta=0, delta_pct=0, cumulative_delta=0)

    recent = df.iloc[-window:]
    buy_vol = 0.0
    sell_vol = 0.0

    for _, row in recent.iterrows():
        o, h, l, c, v = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"]), float(row["volume"])
        rng = h - l
        if rng < 1e-12:
            buy_vol += v / 2
            sell_vol += v / 2
            continue
        # Posición del cierre en el rango: 1 = arriba, 0 = abajo
        buy_pct = (c - l) / rng
        buy_vol += v * buy_pct
        sell_vol += v * (1 - buy_pct)

    total = buy_vol + sell_vol
    delta = buy_vol - sell_vol

    # Acumulado sobre todo el df
    cum_buy, cum_sell = 0.0, 0.0
    for _, row in df.iterrows():
        o, h, l, c, v = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"]), float(row["volume"])
        rng = h - l
        if rng < 1e-12:
            cum_buy += v / 2
            cum_sell += v / 2
            continue
        bp = (c - l) / rng
        cum_buy += v * bp
        cum_sell += v * (1 - bp)

    return VolumeDelta(
        buy_volume=round(buy_vol, 4),
        sell_volume=round(sell_vol, 4),
        delta=round(delta, 4),
        delta_pct=round(delta / total * 100, 2) if total > 0 else 0,
        cumulative_delta=round(cum_buy - cum_sell, 4),
    )


# ------------------------------------------------------------------
# 3. VOLUMEN RELATIVO POR VENTANA HORARIA
# ------------------------------------------------------------------

def relative_volume(df: pd.DataFrame, current_hour_utc: int | None = None) -> RelativeVolume:
    """
    Compara el volumen de la última hora con el promedio histórico para esa
    misma hora del día. Requiere al menos 3 días de datos para ser útil.
    """
    if len(df) < 60:
        return RelativeVolume(current_volume=0, expected_volume=0, ratio=1.0, percentile=50, is_active=True)

    df = df.copy()
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    df["hour"] = df["ts"].dt.hour

    if current_hour_utc is None:
        current_hour_utc = int(df["ts"].iloc[-1].hour)

    # Volumen de la última hora (últimas ~60 velas de 1 min)
    current_vol = float(df["volume"].iloc[-60:].sum()) if len(df) >= 60 else float(df["volume"].sum())

    # Volumen promedio para esta hora del día (excluyendo la última hora)
    historical = df.iloc[:-60] if len(df) > 60 else df.iloc[:0]
    same_hour = historical[historical["hour"] == current_hour_utc]

    if len(same_hour) < 30:  # menos de 30 velas históricas → datos insuficientes
        # Fallback: comparar con promedio general
        avg_vol = float(df["volume"].iloc[:-60].mean()) * 60 if len(df) > 60 else current_vol
        expected = max(avg_vol, 1e-12)
    else:
        # Agrupar por día y sumar
        same_hour = same_hour.copy()
        same_hour["date"] = same_hour["ts"].dt.date
        daily_vols = same_hour.groupby("date")["volume"].sum()
        expected = float(daily_vols.mean()) if len(daily_vols) > 0 else current_vol

    ratio = current_vol / expected if expected > 0 else 1.0

    # Percentil: comparar volumen actual con todas las ventanas de 60 velas
    all_vols = []
    for start in range(0, len(df) - 60, 60):
        all_vols.append(float(df["volume"].iloc[start:start + 60].sum()))
    if all_vols:
        percentile = float(np.searchsorted(sorted(all_vols), current_vol) / len(all_vols) * 100)
    else:
        percentile = 50.0

    return RelativeVolume(
        current_volume=round(current_vol, 4),
        expected_volume=round(expected, 4),
        ratio=round(ratio, 3),
        percentile=round(percentile, 1),
        is_active=ratio >= 1.0,
    )


# ------------------------------------------------------------------
# 4. VWAP EXTENDIDO (con bandas)
# ------------------------------------------------------------------

def vwap_bands(df: pd.DataFrame, session_bars: int | None = None) -> tuple[float, float, float]:
    """
    VWAP con bandas de ±1 desviación estándar.
    session_bars: si se da, calcula sobre las últimas N velas (ej: 390 para un día NYSE).
    Retorna (vwap, upper_band, lower_band).
    """
    if len(df) < 5:
        p = float(df["close"].iloc[-1]) if len(df) > 0 else 0
        return p, p, p

    d = df.iloc[-session_bars:] if session_bars and len(df) >= session_bars else df

    tp = (d["high"].astype(float) + d["low"].astype(float) + d["close"].astype(float)) / 3
    vol = d["volume"].astype(float)
    cum_tp_vol = (tp * vol).cumsum()
    cum_vol = vol.cumsum()

    vwap_series = cum_tp_vol / cum_vol.replace(0, np.nan)
    vwap_val = float(vwap_series.iloc[-1]) if pd.notna(vwap_series.iloc[-1]) else float(d["close"].iloc[-1])

    # Desviación estándar ponderada por volumen
    sq_diff = ((tp - vwap_series) ** 2 * vol).cumsum()
    std_series = np.sqrt(sq_diff / cum_vol.replace(0, np.nan))
    std_val = float(std_series.iloc[-1]) if pd.notna(std_series.iloc[-1]) else 0

    return round(vwap_val, 8), round(vwap_val + std_val, 8), round(vwap_val - std_val, 8)


# ------------------------------------------------------------------
# ANÁLISIS COMPLETO
# ------------------------------------------------------------------

def analyze_volume(df: pd.DataFrame, trades_df: pd.DataFrame | None = None,
                   current_hour_utc: int | None = None) -> VolumeAnalysis:
    """Ejecuta todos los análisis de volumen y devuelve un VolumeAnalysis."""
    if len(df) < 10:
        return VolumeAnalysis()

    profile = volume_profile(df)

    if trades_df is not None and len(trades_df) > 0:
        delta = volume_delta(trades_df)
    else:
        delta = volume_delta_from_candles(df)

    rel = relative_volume(df, current_hour_utc)
    vwap_val, vwap_up, vwap_lo = vwap_bands(df)

    return VolumeAnalysis(
        profile=profile,
        delta=delta,
        relative=rel,
        vwap=vwap_val,
        vwap_upper=vwap_up,
        vwap_lower=vwap_lo,
    )
