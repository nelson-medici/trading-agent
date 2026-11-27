/**
 * Detección determinística de patrones de precio (client-side).
 * Opera sobre arrays de velas Candle del chart.
 * Versión TypeScript liviana del módulo Python patterns/detector.py.
 */

export interface Candle {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// ------------------------------------------------------------------
// Soportes y Resistencias
// ------------------------------------------------------------------

export interface PriceLevel {
  price: number;
  kind: "support" | "resistance";
  touches: number;
  strength: number; // 0-1
}

export function detectLevels(
  candles: Candle[],
  lookback = 5,
  tolerancePct = 0.005,
  minTouches = 2,
  maxLevels = 8,
): PriceLevel[] {
  const n = candles.length;
  if (n < lookback * 2 + 1) return [];

  const pivots: { price: number; kind: "support" | "resistance"; idx: number }[] = [];

  for (let i = lookback; i < n - lookback; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    let isHigh = true;
    let isLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= h) isHigh = false;
      if (candles[j].low <= l) isLow = false;
    }

    if (isHigh) pivots.push({ price: h, kind: "resistance", idx: i });
    if (isLow) pivots.push({ price: l, kind: "support", idx: i });
  }

  if (!pivots.length) return [];

  // Agrupar pivots cercanos
  pivots.sort((a, b) => a.price - b.price);
  const lastPrice = candles[n - 1].close;
  const tol = lastPrice * tolerancePct;

  const groups: typeof pivots[] = [];
  let current = [pivots[0]];

  for (let i = 1; i < pivots.length; i++) {
    if (Math.abs(pivots[i].price - current[current.length - 1].price) <= tol) {
      current.push(pivots[i]);
    } else {
      groups.push(current);
      current = [pivots[i]];
    }
  }
  groups.push(current);

  const levels: PriceLevel[] = [];
  for (const group of groups) {
    if (group.length < minTouches) continue;
    const avg = group.reduce((s, p) => s + p.price, 0) / group.length;
    const supportCount = group.filter((p) => p.kind === "support").length;
    const kind = supportCount >= group.length / 2 ? "support" : "resistance";
    const recency = Math.max(...group.map((p) => p.idx)) / n;
    const strength = Math.min(1, (group.length / 5) * 0.6 + recency * 0.4);
    levels.push({ price: avg, kind, touches: group.length, strength });
  }

  levels.sort((a, b) => b.strength - a.strength);
  return levels.slice(0, maxLevels);
}

// ------------------------------------------------------------------
// Fair Value Gap
// ------------------------------------------------------------------

export interface FVGZone {
  kind: "bullish" | "bearish";
  top: number;
  bottom: number;
  startTime: number | string;
  endTime: number | string;
  filled: boolean;
}

export function detectFVG(candles: Candle[], minGapPct = 0.002): FVGZone[] {
  if (candles.length < 5) return [];

  const fvgs: FVGZone[] = [];
  const lastClose = candles[candles.length - 1].close;

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Bullish FVG: low de vela 3 > high de vela 1
    if (next.low > prev.high && (next.low - prev.high) / prev.high >= minGapPct) {
      fvgs.push({
        kind: "bullish",
        top: next.low,
        bottom: prev.high,
        startTime: prev.time,
        endTime: next.time,
        filled: lastClose < next.low,
      });
    }

    // Bearish FVG: high de vela 3 < low de vela 1
    if (next.high < prev.low && (prev.low - next.high) / prev.low >= minGapPct) {
      fvgs.push({
        kind: "bearish",
        top: prev.low,
        bottom: next.high,
        startTime: prev.time,
        endTime: next.time,
        filled: lastClose > next.high,
      });
    }
  }

  // Solo los últimos 10, priorizando sin llenar
  const unfilled = fvgs.filter((f) => !f.filled);
  return unfilled.slice(-10);
}

// ------------------------------------------------------------------
// Velas de rechazo
// ------------------------------------------------------------------

export interface Rejection {
  idx: number;
  time: number | string;
  kind: "bullish" | "bearish";
  price: number;
  wickRatio: number;
  nearLevel: number;
}

export function detectRejections(
  candles: Candle[],
  levels: PriceLevel[],
  minWickRatio = 2.0,
  proximityPct = 0.005,
): Rejection[] {
  if (candles.length < 3 || !levels.length) return [];

  const rejections: Rejection[] = [];
  const start = Math.max(1, candles.length - 20);

  for (let i = start; i < candles.length; i++) {
    const { open: o, high: h, low: l, close: c, time } = candles[i];
    const body = Math.abs(c - o) || l * 0.0001;
    const upperWick = h - Math.max(o, c);
    const lowerWick = Math.min(o, c) - l;

    for (const level of levels) {
      const proximity = level.price * proximityPct;

      if (level.kind === "support" && Math.abs(l - level.price) <= proximity && lowerWick / body >= minWickRatio) {
        rejections.push({ idx: i, time, kind: "bullish", price: c, wickRatio: lowerWick / body, nearLevel: level.price });
        break;
      }

      if (level.kind === "resistance" && Math.abs(h - level.price) <= proximity && upperWick / body >= minWickRatio) {
        rejections.push({ idx: i, time, kind: "bearish", price: c, wickRatio: upperWick / body, nearLevel: level.price });
        break;
      }
    }
  }

  return rejections;
}

// ------------------------------------------------------------------
// Volume Profile (simplificado para chart)
// ------------------------------------------------------------------

export interface VolumeProfileBar {
  priceLevel: number;
  volume: number;
  pct: number;
  isPOC: boolean;
}

export function computeVolumeProfile(candles: Candle[], numBins = 24): VolumeProfileBar[] {
  if (candles.length < 5) return [];

  const priceLow = Math.min(...candles.map((c) => c.low));
  const priceHigh = Math.max(...candles.map((c) => c.high));
  if (priceHigh <= priceLow) return [];

  const binSize = (priceHigh - priceLow) / numBins;
  const bins = new Array(numBins).fill(0);

  for (const c of candles) {
    const lo = Math.max(0, Math.floor((c.low - priceLow) / binSize));
    const hi = Math.min(numBins - 1, Math.floor((c.high - priceLow) / binSize));
    const nBins = hi - lo + 1;
    if (nBins > 0) {
      const perBin = (c.volume ?? 0) / nBins;
      for (let b = lo; b <= hi; b++) bins[b] += perBin;
    }
  }

  const total = bins.reduce((s, v) => s + v, 0);
  if (total <= 0) return [];

  const pocIdx = bins.indexOf(Math.max(...bins));

  return bins.map((vol, i) => ({
    priceLevel: priceLow + (i + 0.5) * binSize,
    volume: vol,
    pct: (vol / total) * 100,
    isPOC: i === pocIdx,
  }));
}
