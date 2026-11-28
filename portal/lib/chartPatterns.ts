/**
 * Detección de patrones chartistas complejos con proyección de precio.
 * Cada patrón incluye: trendlines para dibujar, zona de entrada/stop/target,
 * y línea de proyección.
 */

import type { Candle } from "./patterns";

// ------------------------------------------------------------------
// Tipos
// ------------------------------------------------------------------

export interface PatternLine {
  points: { time: string | number; value: number }[];
  color: string;
  lineWidth?: number;
  style?: "solid" | "dashed" | "dotted";
}

export interface ChartPattern {
  name: string;
  nameEn: string;
  type: "reversal" | "continuation";
  bias: "bullish" | "bearish";
  status: "forming" | "confirmed" | "projected";
  confidence: number; // 0-100

  // Niveles clave
  entry?: number;
  stop?: number;
  target?: number;
  neckline?: number;

  // Para dibujar en el chart
  lines: PatternLine[];         // Trendlines del patrón
  projectionLine?: PatternLine; // Línea de proyección (target)

  description: string;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

interface Pivot {
  idx: number;
  price: number;
  time: string | number;
}

function findPivots(candles: Candle[], lookback = 3): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, price: candles[i].high, time: candles[i].time });
    if (isLow) lows.push({ idx: i, price: candles[i].low, time: candles[i].time });
  }

  return { highs, lows };
}

function pctDiff(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(a, b) * 100;
}

function slope(p1: Pivot, p2: Pivot): number {
  if (p2.idx === p1.idx) return 0;
  return (p2.price - p1.price) / (p2.idx - p1.idx);
}

function extendLine(p1: Pivot, p2: Pivot, toIdx: number, candles: Candle[]): { time: string | number; value: number } {
  const s = slope(p1, p2);
  const val = p2.price + s * (toIdx - p2.idx);
  const time = candles[Math.min(toIdx, candles.length - 1)]?.time ?? p2.time;
  return { time, value: val };
}

// ------------------------------------------------------------------
// 1. BANDERA / FLAG (alcista y bajista)
// ------------------------------------------------------------------
// Flagpole = impulso fuerte → consolidación en canal contrario → breakout

function detectFlag(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern | null {
  if (candles.length < 30) return null;
  const n = candles.length;
  const price = candles[n - 1].close;

  // Buscar impulso fuerte reciente (flagpole): movimiento > 3% en < 10 velas
  for (let poleEnd = n - 8; poleEnd >= n - 20 && poleEnd >= 10; poleEnd--) {
    // Bullish flag: impulso alcista seguido de consolidación bajista
    for (let poleStart = poleEnd - 5; poleStart >= poleEnd - 15 && poleStart >= 0; poleStart--) {
      const poleHeight = candles[poleEnd].high - candles[poleStart].low;
      const polePct = (poleHeight / candles[poleStart].low) * 100;

      if (polePct < 2) continue; // pole muy chico

      // Verificar que el pole fue un impulso rápido (no lateral)
      const poleLen = poleEnd - poleStart;
      if (poleLen < 3 || poleLen > 12) continue;

      // Verificar consolidación post-pole
      const flagCandles = candles.slice(poleEnd, n);
      if (flagCandles.length < 3) continue;

      const flagHighs = flagCandles.map((c) => c.high);
      const flagLows = flagCandles.map((c) => c.low);
      const flagMax = Math.max(...flagHighs);
      const flagMin = Math.min(...flagLows);
      const flagRange = (flagMax - flagMin) / flagMax * 100;

      // Flag debe ser más chica que el pole y retroceder < 50%
      if (flagRange > polePct * 0.6) continue;
      const retrace = (candles[poleEnd].high - flagMin) / poleHeight;
      if (retrace > 0.5) continue;

      // Flag bajista (máximos y mínimos decrecientes en la consolidación)
      const flagMidIdx = Math.floor(flagCandles.length / 2);
      const firstHalf = flagCandles.slice(0, flagMidIdx);
      const secondHalf = flagCandles.slice(flagMidIdx);
      const fhAvg = firstHalf.reduce((s, c) => s + c.close, 0) / firstHalf.length;
      const shAvg = secondHalf.reduce((s, c) => s + c.close, 0) / secondHalf.length;

      if (shAvg < fhAvg) {
        // Bullish flag: pole alcista + consolidación bajista
        const breakoutLevel = flagMax;
        const confirmed = price > breakoutLevel;
        const target = breakoutLevel + poleHeight;
        const stop = flagMin;

        // Líneas del flag
        const poleStartTime = candles[poleStart].time;
        const poleEndTime = candles[poleEnd].time;
        const flagEndTime = candles[n - 1].time;

        return {
          name: "Bandera Alcista",
          nameEn: "Bull Flag",
          type: "continuation",
          bias: "bullish",
          status: confirmed ? "confirmed" : "forming",
          confidence: confirmed ? 75 : 55,
          entry: breakoutLevel,
          stop,
          target,
          lines: [
            // Flagpole
            { points: [
              { time: poleStartTime, value: candles[poleStart].low },
              { time: poleEndTime, value: candles[poleEnd].high },
            ], color: "#10b981", lineWidth: 2 },
            // Flag channel upper
            { points: [
              { time: poleEndTime, value: flagMax },
              { time: flagEndTime, value: flagMax - (flagMax - flagMin) * 0.3 },
            ], color: "#6366f1", lineWidth: 1, style: "dashed" },
            // Flag channel lower
            { points: [
              { time: candles[poleEnd + 1]?.time ?? poleEndTime, value: flagMin + (flagMax - flagMin) * 0.2 },
              { time: flagEndTime, value: flagMin },
            ], color: "#6366f1", lineWidth: 1, style: "dashed" },
          ],
          projectionLine: {
            points: [
              { time: flagEndTime, value: breakoutLevel },
              { time: flagEndTime, value: target },
            ],
            color: "#10b98180",
            lineWidth: 2,
            style: "dotted",
          },
          description: `Asta: ${polePct.toFixed(1)}%. Target: $${target.toFixed(2)} (+${((target - price) / price * 100).toFixed(1)}%)`,
        };
      }

      if (shAvg > fhAvg && candles[poleEnd].low < candles[poleStart].high) {
        // Bearish flag: pole bajista + consolidación alcista
        const poleHeightDown = candles[poleStart].high - candles[poleEnd].low;
        const polePctDown = (poleHeightDown / candles[poleStart].high) * 100;
        if (polePctDown < 2) continue;

        const breakoutLevel = flagMin;
        const confirmed = price < breakoutLevel;
        const target = breakoutLevel - poleHeightDown;
        const stop = flagMax;

        return {
          name: "Bandera Bajista",
          nameEn: "Bear Flag",
          type: "continuation",
          bias: "bearish",
          status: confirmed ? "confirmed" : "forming",
          confidence: confirmed ? 75 : 55,
          entry: breakoutLevel,
          stop,
          target,
          lines: [
            { points: [
              { time: candles[poleStart].time, value: candles[poleStart].high },
              { time: candles[poleEnd].time, value: candles[poleEnd].low },
            ], color: "#ef4444", lineWidth: 2 },
            { points: [
              { time: candles[poleEnd].time, value: flagMin },
              { time: candles[n - 1].time, value: flagMin + (flagMax - flagMin) * 0.3 },
            ], color: "#6366f1", lineWidth: 1, style: "dashed" },
            { points: [
              { time: candles[poleEnd + 1]?.time ?? candles[poleEnd].time, value: flagMax - (flagMax - flagMin) * 0.2 },
              { time: candles[n - 1].time, value: flagMax },
            ], color: "#6366f1", lineWidth: 1, style: "dashed" },
          ],
          projectionLine: {
            points: [
              { time: candles[n - 1].time, value: breakoutLevel },
              { time: candles[n - 1].time, value: target },
            ],
            color: "#ef444480",
            lineWidth: 2,
            style: "dotted",
          },
          description: `Asta bajista: ${polePctDown.toFixed(1)}%. Target: $${target.toFixed(2)} (${((target - price) / price * 100).toFixed(1)}%)`,
        };
      }
    }
  }

  return null;
}

// ------------------------------------------------------------------
// 2. DOBLE TECHO / DOBLE PISO
// ------------------------------------------------------------------

function detectDoubleTopBottom(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern[] {
  const n = candles.length;
  const price = candles[n - 1].close;
  const results: ChartPattern[] = [];

  // Double Top: dos máximos similares con valle entre ellos
  if (pivots.highs.length >= 2) {
    const h = pivots.highs; // scan ALL pivots
    for (let i = 0; i < h.length - 1; i++) {
      const top1 = h[i];
      const top2 = h[i + 1];
      if (pctDiff(top1.price, top2.price) > 1.5) continue; // tops deben ser similares (< 1.5%)
      if (top2.idx - top1.idx < 5) continue; // mínimo 5 velas entre tops

      // Buscar el valle entre los dos tops
      let valleyPrice = Infinity;
      for (let j = top1.idx + 1; j < top2.idx; j++) {
        if (candles[j].low < valleyPrice) valleyPrice = candles[j].low;
      }

      const neckline = valleyPrice;
      const height = Math.max(top1.price, top2.price) - neckline;
      if (height / neckline * 100 < 1) continue; // pattern demasiado chico

      const confirmed = price < neckline;
      const target = neckline - height;

      results.push({
        name: "Doble Techo",
        nameEn: "Double Top",
        type: "reversal",
        bias: "bearish",
        status: confirmed ? "confirmed" : "forming",
        confidence: confirmed ? 80 : 60,
        entry: neckline,
        stop: Math.max(top1.price, top2.price),
        target,
        neckline,
        lines: [
          { points: [
            { time: top1.time, value: top1.price },
            { time: top2.time, value: top2.price },
          ], color: "#ef4444", lineWidth: 2 },
          { points: [
            { time: top1.time, value: neckline },
            { time: top2.time, value: neckline },
          ], color: "#f59e0b", lineWidth: 1, style: "dashed" },
        ],
        projectionLine: confirmed ? {
          points: [
            { time: top2.time, value: neckline },
            { time: candles[Math.min(top2.idx + 20, n - 1)].time, value: target },
          ],
          color: "#ef444480",
          lineWidth: 2,
          style: "dotted",
        } : undefined,
        description: `Techos en ~$${((top1.price + top2.price) / 2).toFixed(2)}. Neckline: $${neckline.toFixed(2)}`,
      });
    }
  }

  // Double Bottom: dos mínimos similares con pico entre ellos
  if (pivots.lows.length >= 2) {
    const l = pivots.lows;
    for (let i = 0; i < l.length - 1; i++) {
      const bot1 = l[i];
      const bot2 = l[i + 1];
      if (pctDiff(bot1.price, bot2.price) > 1.5) continue;
      if (bot2.idx - bot1.idx < 5) continue;

      let peakPrice = -Infinity;
      for (let j = bot1.idx + 1; j < bot2.idx; j++) {
        if (candles[j].high > peakPrice) peakPrice = candles[j].high;
      }

      const neckline = peakPrice;
      const height = neckline - Math.min(bot1.price, bot2.price);
      if (height / neckline * 100 < 1) continue;

      const confirmed = price > neckline;
      const target = neckline + height;

      results.push({
        name: "Doble Piso",
        nameEn: "Double Bottom",
        type: "reversal",
        bias: "bullish",
        status: confirmed ? "confirmed" : "forming",
        confidence: confirmed ? 80 : 60,
        entry: neckline,
        stop: Math.min(bot1.price, bot2.price),
        target,
        neckline,
        lines: [
          { points: [
            { time: bot1.time, value: bot1.price },
            { time: bot2.time, value: bot2.price },
          ], color: "#10b981", lineWidth: 2 },
          { points: [
            { time: bot1.time, value: neckline },
            { time: bot2.time, value: neckline },
          ], color: "#f59e0b", lineWidth: 1, style: "dashed" },
        ],
        projectionLine: confirmed ? {
          points: [
            { time: bot2.time, value: neckline },
            { time: candles[Math.min(bot2.idx + 20, n - 1)].time, value: target },
          ],
          color: "#10b98180",
          lineWidth: 2,
          style: "dotted",
        } : undefined,
        description: `Pisos en ~$${((bot1.price + bot2.price) / 2).toFixed(2)}. Neckline: $${neckline.toFixed(2)}`,
      });
    }
  }

  return results;
}

// ------------------------------------------------------------------
// 3. CUÑA (Wedge) — Rising / Falling
// ------------------------------------------------------------------

function detectWedge(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern | null {
  if (pivots.highs.length < 2 || pivots.lows.length < 2) return null;
  const n = candles.length;
  const price = candles[n - 1].close;

  const ph = pivots.highs.slice(-3);
  const pl = pivots.lows.slice(-3);
  if (ph.length < 2 || pl.length < 2) return null;

  const highSlope = slope(ph[ph.length - 2], ph[ph.length - 1]);
  const lowSlope = slope(pl[pl.length - 2], pl[pl.length - 1]);

  // Rising Wedge: ambas pendientes positivas pero convergen (bearish)
  if (highSlope > 0 && lowSlope > 0 && lowSlope > highSlope * 0.3) {
    // Verificar convergencia
    const highRange = ph[ph.length - 1].price - ph[ph.length - 2].price;
    const lowRange = pl[pl.length - 1].price - pl[pl.length - 2].price;
    if (lowRange > highRange) { // lows subiendo más rápido = convergencia
      const breakoutLevel = pl[pl.length - 1].price;
      const height = ph[ph.length - 1].price - pl[pl.length - 1].price;
      const target = breakoutLevel - height;
      const confirmed = price < breakoutLevel;

      return {
        name: "Cuña Ascendente",
        nameEn: "Rising Wedge",
        type: "reversal",
        bias: "bearish",
        status: confirmed ? "confirmed" : "forming",
        confidence: confirmed ? 70 : 50,
        entry: breakoutLevel,
        stop: ph[ph.length - 1].price,
        target,
        lines: [
          { points: ph.slice(-2).map((p) => ({ time: p.time, value: p.price })), color: "#ef4444", lineWidth: 2 },
          { points: pl.slice(-2).map((p) => ({ time: p.time, value: p.price })), color: "#ef4444", lineWidth: 2 },
        ],
        projectionLine: {
          points: [
            { time: candles[n - 1].time, value: breakoutLevel },
            { time: candles[n - 1].time, value: target },
          ],
          color: "#ef444460",
          lineWidth: 2,
          style: "dotted",
        },
        description: `Máximos y mínimos crecientes convergentes. Breakout bajista esperado por debajo de $${breakoutLevel.toFixed(2)}`,
      };
    }
  }

  // Falling Wedge: ambas pendientes negativas pero convergen (bullish)
  if (highSlope < 0 && lowSlope < 0 && highSlope < lowSlope * 0.3) {
    const highRange = Math.abs(ph[ph.length - 1].price - ph[ph.length - 2].price);
    const lowRange = Math.abs(pl[pl.length - 1].price - pl[pl.length - 2].price);
    if (highRange > lowRange) { // highs bajando más rápido = convergencia
      const breakoutLevel = ph[ph.length - 1].price;
      const height = ph[ph.length - 1].price - pl[pl.length - 1].price;
      const target = breakoutLevel + height;
      const confirmed = price > breakoutLevel;

      return {
        name: "Cuña Descendente",
        nameEn: "Falling Wedge",
        type: "reversal",
        bias: "bullish",
        status: confirmed ? "confirmed" : "forming",
        confidence: confirmed ? 70 : 50,
        entry: breakoutLevel,
        stop: pl[pl.length - 1].price,
        target,
        lines: [
          { points: ph.slice(-2).map((p) => ({ time: p.time, value: p.price })), color: "#10b981", lineWidth: 2 },
          { points: pl.slice(-2).map((p) => ({ time: p.time, value: p.price })), color: "#10b981", lineWidth: 2 },
        ],
        projectionLine: {
          points: [
            { time: candles[n - 1].time, value: breakoutLevel },
            { time: candles[n - 1].time, value: target },
          ],
          color: "#10b98160",
          lineWidth: 2,
          style: "dotted",
        },
        description: `Máximos y mínimos decrecientes convergentes. Breakout alcista esperado por encima de $${breakoutLevel.toFixed(2)}`,
      };
    }
  }

  return null;
}

// ------------------------------------------------------------------
// 4. HEAD & SHOULDERS / INVERSE
// ------------------------------------------------------------------

function detectHeadShoulders(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern[] {
  const n = candles.length;
  const price = candles[n - 1].close;
  const results: ChartPattern[] = [];

  // H&S: tres picos, el del medio más alto — STRICT criteria
  if (pivots.highs.length >= 3) {
    const h = pivots.highs;
    for (let i = 0; i <= h.length - 3; i++) {
      if (results.length >= 2) break; // max 2 H&S
      const ls = h[i];     // left shoulder
      const head = h[i + 1]; // head
      const rs = h[i + 2];   // right shoulder

      // Head must be significantly higher than both shoulders (> 1%)
      if (head.price <= ls.price * 1.01 || head.price <= rs.price * 1.01) continue;
      // Shoulders should be similar height (< 2%)
      if (pctDiff(ls.price, rs.price) > 2) continue;
      // Minimum spacing: at least 5 bars between each pivot
      if (head.idx - ls.idx < 5 || rs.idx - head.idx < 5) continue;
      // Pattern shouldn't span more than 60% of visible chart
      if (rs.idx - ls.idx > candles.length * 0.6) continue;

      // Find neckline (lows between shoulders)
      let neck1 = Infinity, neck2 = Infinity;
      for (let j = ls.idx + 1; j < head.idx; j++) {
        if (candles[j].low < neck1) neck1 = candles[j].low;
      }
      for (let j = head.idx + 1; j < rs.idx; j++) {
        if (candles[j].low < neck2) neck2 = candles[j].low;
      }
      const neckline = (neck1 + neck2) / 2;
      const height = head.price - neckline;
      if (height / neckline * 100 < 3) continue; // need at least 3% pattern height

      const confirmed = price < neckline;
      const target = neckline - height;

      results.push({
        name: "Hombro-Cabeza-Hombro",
        nameEn: "Head & Shoulders",
        type: "reversal",
        bias: "bearish",
        status: confirmed ? "confirmed" : "forming",
        confidence: confirmed ? 85 : 65,
        entry: neckline,
        stop: rs.price,
        target,
        neckline,
        lines: [
          { points: [
            { time: ls.time, value: ls.price },
            { time: head.time, value: head.price },
            { time: rs.time, value: rs.price },
          ], color: "#ef4444", lineWidth: 2 },
          { points: [
            { time: ls.time, value: neckline },
            { time: rs.time, value: neckline },
          ], color: "#f59e0b", lineWidth: 1, style: "dashed" },
        ],
        projectionLine: {
          points: [
            { time: rs.time, value: neckline },
            { time: candles[Math.min(rs.idx + 15, n - 1)].time, value: target },
          ],
          color: "#ef444480",
          lineWidth: 2,
          style: "dotted",
        },
        description: `Cabeza: $${head.price.toFixed(2)}. Hombros: ~$${((ls.price + rs.price) / 2).toFixed(2)}`,
      });
    }
  }

  // Inverse H&S: tres valles, el del medio más bajo — STRICT
  if (pivots.lows.length >= 3) {
    const l = pivots.lows;
    for (let i = 0; i <= l.length - 3; i++) {
      if (results.length >= 2) break; // max 2 total H&S + inv
      const ls = l[i];
      const head = l[i + 1];
      const rs = l[i + 2];

      if (head.price >= ls.price * 0.99 || head.price >= rs.price * 0.99) continue;
      if (pctDiff(ls.price, rs.price) > 2) continue;
      if (head.idx - ls.idx < 5 || rs.idx - head.idx < 5) continue;
      if (rs.idx - ls.idx > candles.length * 0.6) continue;

      let neck1 = -Infinity, neck2 = -Infinity;
      for (let j = ls.idx + 1; j < head.idx; j++) {
        if (candles[j].high > neck1) neck1 = candles[j].high;
      }
      for (let j = head.idx + 1; j < rs.idx; j++) {
        if (candles[j].high > neck2) neck2 = candles[j].high;
      }
      const neckline = (neck1 + neck2) / 2;
      const height = neckline - head.price;
      if (height / neckline * 100 < 3) continue; // need at least 3% pattern height

      const confirmed = price > neckline;
      const target = neckline + height;

      results.push({
        name: "HCH Invertido",
        nameEn: "Inverse Head & Shoulders",
        type: "reversal",
        bias: "bullish",
        status: confirmed ? "confirmed" : "forming",
        confidence: confirmed ? 85 : 65,
        entry: neckline,
        stop: head.price,
        target,
        neckline,
        lines: [
          { points: [
            { time: ls.time, value: ls.price },
            { time: head.time, value: head.price },
            { time: rs.time, value: rs.price },
          ], color: "#10b981", lineWidth: 2 },
          { points: [
            { time: ls.time, value: neckline },
            { time: rs.time, value: neckline },
          ], color: "#f59e0b", lineWidth: 1, style: "dashed" },
        ],
        projectionLine: {
          points: [
            { time: rs.time, value: neckline },
            { time: candles[Math.min(rs.idx + 15, n - 1)].time, value: target },
          ],
          color: "#10b98180",
          lineWidth: 2,
          style: "dotted",
        },
        description: `Cabeza: $${head.price.toFixed(2)}. Hombros: ~$${((ls.price + rs.price) / 2).toFixed(2)}`,
      });
    }
  }

  return results;
}

// ------------------------------------------------------------------
// 5. RECTÁNGULO / RANGO
// ------------------------------------------------------------------

function detectRectangle(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern | null {
  if (pivots.highs.length < 2 || pivots.lows.length < 2) return null;
  const n = candles.length;
  const price = candles[n - 1].close;

  const ph = pivots.highs.slice(-3);
  const pl = pivots.lows.slice(-3);

  // Highs deben ser planos (< 0.5%) y lows también
  const highsFlat = ph.length >= 2 && pctDiff(ph[ph.length - 1].price, ph[ph.length - 2].price) < 0.5;
  const lowsFlat = pl.length >= 2 && pctDiff(pl[pl.length - 1].price, pl[pl.length - 2].price) < 0.5;

  if (!highsFlat || !lowsFlat) return null;

  const resistance = (ph[ph.length - 1].price + ph[ph.length - 2].price) / 2;
  const support = (pl[pl.length - 1].price + pl[pl.length - 2].price) / 2;
  const height = resistance - support;

  if (height / support * 100 < 0.5) return null; // too tight

  const breakUp = price > resistance;
  const breakDown = price < support;

  if (breakUp) {
    return {
      name: "Rectángulo → Ruptura Alcista",
      nameEn: "Rectangle Breakout Up",
      type: "continuation",
      bias: "bullish",
      status: "confirmed",
      confidence: 70,
      entry: resistance,
      stop: support,
      target: resistance + height,
      lines: [
        { points: ph.slice(-2).map((p) => ({ time: p.time, value: resistance })), color: "#f472b6", lineWidth: 1, style: "dashed" },
        { points: pl.slice(-2).map((p) => ({ time: p.time, value: support })), color: "#22d3ee", lineWidth: 1, style: "dashed" },
      ],
      projectionLine: {
        points: [
          { time: candles[n - 1].time, value: resistance },
          { time: candles[n - 1].time, value: resistance + height },
        ],
        color: "#10b98160",
        lineWidth: 2,
        style: "dotted",
      },
      description: `Rango $${support.toFixed(2)}–$${resistance.toFixed(2)} roto al alza. Target: $${(resistance + height).toFixed(2)}`,
    };
  }

  if (breakDown) {
    return {
      name: "Rectángulo → Ruptura Bajista",
      nameEn: "Rectangle Breakout Down",
      type: "continuation",
      bias: "bearish",
      status: "confirmed",
      confidence: 70,
      entry: support,
      stop: resistance,
      target: support - height,
      lines: [
        { points: ph.slice(-2).map((p) => ({ time: p.time, value: resistance })), color: "#f472b6", lineWidth: 1, style: "dashed" },
        { points: pl.slice(-2).map((p) => ({ time: p.time, value: support })), color: "#22d3ee", lineWidth: 1, style: "dashed" },
      ],
      projectionLine: {
        points: [
          { time: candles[n - 1].time, value: support },
          { time: candles[n - 1].time, value: support - height },
        ],
        color: "#ef444460",
        lineWidth: 2,
        style: "dotted",
      },
      description: `Rango $${support.toFixed(2)}–$${resistance.toFixed(2)} roto a la baja. Target: $${(support - height).toFixed(2)}`,
    };
  }

  // Still in range
  return {
    name: "Rango Lateral",
    nameEn: "Rectangle",
    type: "continuation",
    bias: "bullish", // neutral
    status: "forming",
    confidence: 40,
    entry: resistance,
    stop: support,
    target: resistance + height,
    lines: [
      { points: [
        { time: ph[ph.length - 2].time, value: resistance },
        { time: candles[n - 1].time, value: resistance },
      ], color: "#f472b680", lineWidth: 1, style: "dashed" },
      { points: [
        { time: pl[pl.length - 2].time, value: support },
        { time: candles[n - 1].time, value: support },
      ], color: "#22d3ee80", lineWidth: 1, style: "dashed" },
    ],
    description: `Consolidación entre $${support.toFixed(2)} y $${resistance.toFixed(2)}. Esperar ruptura.`,
  };
}

// ------------------------------------------------------------------
// 6. CANAL DESCENDENTE / ASCENDENTE
// ------------------------------------------------------------------

function detectChannel(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern | null {
  if (pivots.highs.length < 3 || pivots.lows.length < 3) return null;
  const n = candles.length;
  const price = candles[n - 1].close;

  const ph = pivots.highs;
  const pl = pivots.lows;

  // Check last 3+ highs for consistent slope
  const recentHighs = ph.slice(-4);
  const recentLows = pl.slice(-4);
  if (recentHighs.length < 3 || recentLows.length < 3) return null;

  // Calculate trend of highs and lows
  const hSlope = (recentHighs[recentHighs.length - 1].price - recentHighs[0].price) /
                 Math.max(1, recentHighs[recentHighs.length - 1].idx - recentHighs[0].idx);
  const lSlope = (recentLows[recentLows.length - 1].price - recentLows[0].price) /
                 Math.max(1, recentLows[recentLows.length - 1].idx - recentLows[0].idx);

  // Both slopes should be in the same direction and roughly parallel
  const slopeDiff = Math.abs(hSlope - lSlope);
  const avgSlope = (Math.abs(hSlope) + Math.abs(lSlope)) / 2;
  if (avgSlope < 0.5) return null; // too flat, not a channel
  if (slopeDiff / avgSlope > 1.5) return null; // not parallel enough

  // Channel width consistency
  const widths = [];
  for (let i = 0; i < Math.min(recentHighs.length, recentLows.length); i++) {
    const h = recentHighs[Math.min(i, recentHighs.length - 1)];
    const l = recentLows[Math.min(i, recentLows.length - 1)];
    widths.push(h.price - l.price);
  }
  const avgWidth = widths.reduce((a, b) => a + b, 0) / widths.length;
  const widthVariance = widths.reduce((a, w) => a + Math.abs(w - avgWidth), 0) / widths.length;
  if (widthVariance / avgWidth > 0.4) return null; // channel width too inconsistent

  if (hSlope < 0 && lSlope < 0) {
    // Descending channel — bullish breakout expected
    const breakoutLevel = recentHighs[recentHighs.length - 1].price;
    const target = breakoutLevel + avgWidth;

    return {
      name: "Canal Descendente",
      nameEn: "Descending Channel",
      type: "reversal",
      bias: "bullish",
      status: price > breakoutLevel ? "confirmed" : "forming",
      confidence: price > breakoutLevel ? 70 : 50,
      entry: breakoutLevel,
      stop: recentLows[recentLows.length - 1].price,
      target,
      lines: [
        // Upper channel line
        { points: recentHighs.map((p) => ({ time: p.time, value: p.price })),
          color: "#f472b6", lineWidth: 2 },
        // Lower channel line
        { points: recentLows.map((p) => ({ time: p.time, value: p.price })),
          color: "#22d3ee", lineWidth: 2 },
      ],
      projectionLine: price > breakoutLevel ? {
        points: [
          { time: candles[recentHighs[recentHighs.length - 1].idx]?.time ?? candles[n - 1].time, value: breakoutLevel },
          { time: candles[n - 1].time, value: target },
        ],
        color: "#10b98160",
        lineWidth: 2,
        style: "dotted",
      } : undefined,
      description: `Canal bajista con ${recentHighs.length} techos descendentes. Ruptura alcista por encima de $${breakoutLevel.toFixed(2)}`,
    };
  }

  if (hSlope > 0 && lSlope > 0) {
    // Ascending channel — bearish breakout warning
    const breakoutLevel = recentLows[recentLows.length - 1].price;
    const target = breakoutLevel - avgWidth;

    return {
      name: "Canal Ascendente",
      nameEn: "Ascending Channel",
      type: "continuation",
      bias: "bearish",
      status: price < breakoutLevel ? "confirmed" : "forming",
      confidence: price < breakoutLevel ? 70 : 45,
      entry: breakoutLevel,
      stop: recentHighs[recentHighs.length - 1].price,
      target,
      lines: [
        { points: recentHighs.map((p) => ({ time: p.time, value: p.price })),
          color: "#f472b6", lineWidth: 2 },
        { points: recentLows.map((p) => ({ time: p.time, value: p.price })),
          color: "#22d3ee", lineWidth: 2 },
      ],
      description: `Canal alcista con ${recentLows.length} pisos ascendentes. Quiebre bajista por debajo de $${breakoutLevel.toFixed(2)}`,
    };
  }

  return null;
}

// ------------------------------------------------------------------
// 7. TRIPLE BOTTOM / TRIPLE TOP
// ------------------------------------------------------------------

function detectTripleBottomTop(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern[] {
  const n = candles.length;
  const price = candles[n - 1].close;
  const results: ChartPattern[] = [];

  // Triple Bottom: 3 mínimos similares
  if (pivots.lows.length >= 3) {
    for (let i = 0; i < pivots.lows.length - 2; i++) {
      const b1 = pivots.lows[i];
      const b2 = pivots.lows[i + 1];
      const b3 = pivots.lows[i + 2];

      const avgPrice = (b1.price + b2.price + b3.price) / 3;
      const maxDiff = Math.max(
        pctDiff(b1.price, avgPrice),
        pctDiff(b2.price, avgPrice),
        pctDiff(b3.price, avgPrice),
      );
      if (maxDiff > 1.5) continue;
      if (b2.idx - b1.idx < 4 || b3.idx - b2.idx < 4) continue;

      // Find neckline (highest peak between bottoms)
      let peak = -Infinity;
      for (let j = b1.idx; j <= b3.idx; j++) {
        if (candles[j].high > peak) peak = candles[j].high;
      }
      const neckline = peak;
      const height = neckline - avgPrice;
      if (height / neckline * 100 < 1) continue;

      const confirmed = price > neckline;

      results.push({
        name: "Triple Piso",
        nameEn: "Triple Bottom",
        type: "reversal",
        bias: "bullish",
        status: confirmed ? "confirmed" : "forming",
        confidence: confirmed ? 85 : 65,
        entry: neckline,
        stop: Math.min(b1.price, b2.price, b3.price),
        target: neckline + height,
        neckline,
        lines: [
          { points: [
            { time: b1.time, value: b1.price },
            { time: b2.time, value: b2.price },
            { time: b3.time, value: b3.price },
          ], color: "#10b981", lineWidth: 2 },
          { points: [
            { time: b1.time, value: neckline },
            { time: b3.time, value: neckline },
          ], color: "#f59e0b", lineWidth: 1, style: "dashed" },
        ],
        projectionLine: confirmed ? {
          points: [
            { time: b3.time, value: neckline },
            { time: candles[Math.min(b3.idx + 20, n - 1)].time, value: neckline + height },
          ],
          color: "#10b98160", lineWidth: 2, style: "dotted",
        } : undefined,
        description: `3 pisos en ~$${avgPrice.toFixed(2)}. Neckline: $${neckline.toFixed(2)}`,
      });
    }
  }

  // Triple Top: 3 máximos similares
  if (pivots.highs.length >= 3) {
    for (let i = 0; i < pivots.highs.length - 2; i++) {
      const t1 = pivots.highs[i];
      const t2 = pivots.highs[i + 1];
      const t3 = pivots.highs[i + 2];

      const avgPrice = (t1.price + t2.price + t3.price) / 3;
      const maxDiff = Math.max(
        pctDiff(t1.price, avgPrice),
        pctDiff(t2.price, avgPrice),
        pctDiff(t3.price, avgPrice),
      );
      if (maxDiff > 1.5) continue;
      if (t2.idx - t1.idx < 4 || t3.idx - t2.idx < 4) continue;

      let valley = Infinity;
      for (let j = t1.idx; j <= t3.idx; j++) {
        if (candles[j].low < valley) valley = candles[j].low;
      }
      const neckline = valley;
      const height = avgPrice - neckline;
      if (height / neckline * 100 < 1) continue;

      const confirmed = price < neckline;

      results.push({
        name: "Triple Techo",
        nameEn: "Triple Top",
        type: "reversal",
        bias: "bearish",
        status: confirmed ? "confirmed" : "forming",
        confidence: confirmed ? 85 : 65,
        entry: neckline,
        stop: Math.max(t1.price, t2.price, t3.price),
        target: neckline - height,
        neckline,
        lines: [
          { points: [
            { time: t1.time, value: t1.price },
            { time: t2.time, value: t2.price },
            { time: t3.time, value: t3.price },
          ], color: "#ef4444", lineWidth: 2 },
          { points: [
            { time: t1.time, value: neckline },
            { time: t3.time, value: neckline },
          ], color: "#f59e0b", lineWidth: 1, style: "dashed" },
        ],
        projectionLine: confirmed ? {
          points: [
            { time: t3.time, value: neckline },
            { time: candles[Math.min(t3.idx + 20, n - 1)].time, value: neckline - height },
          ],
          color: "#ef444460", lineWidth: 2, style: "dotted",
        } : undefined,
        description: `3 techos en ~$${avgPrice.toFixed(2)}. Neckline: $${neckline.toFixed(2)}`,
      });
    }
  }

  return results;
}

// ------------------------------------------------------------------
// 8. PENNANT (banderín triangular)
// ------------------------------------------------------------------

function detectPennant(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern | null {
  if (candles.length < 25) return null;
  const n = candles.length;
  const price = candles[n - 1].close;

  // Similar a flag pero la consolidación converge (triángulo chico)
  for (let poleEnd = n - 6; poleEnd >= n - 20 && poleEnd >= 8; poleEnd--) {
    for (let poleStart = poleEnd - 4; poleStart >= Math.max(0, poleEnd - 12); poleStart--) {
      const poleH = candles[poleEnd].high - candles[poleStart].low;
      const polePct = (poleH / candles[poleStart].low) * 100;
      if (polePct < 2.5 || poleEnd - poleStart < 3) continue;

      const pennantCandles = candles.slice(poleEnd, n);
      if (pennantCandles.length < 4) continue;

      // Pennant: highs decrecientes Y lows crecientes (convergencia)
      const pHighs = pennantCandles.filter((_, i) => i > 0).map((c, i) => ({ idx: i, h: c.high }));
      const pLows = pennantCandles.filter((_, i) => i > 0).map((c, i) => ({ idx: i, l: c.low }));

      const firstH = Math.max(...pennantCandles.slice(0, 2).map((c) => c.high));
      const lastH = Math.max(...pennantCandles.slice(-2).map((c) => c.high));
      const firstL = Math.min(...pennantCandles.slice(0, 2).map((c) => c.low));
      const lastL = Math.min(...pennantCandles.slice(-2).map((c) => c.low));

      const highsConverging = lastH < firstH;
      const lowsConverging = lastL > firstL;
      if (!highsConverging || !lowsConverging) continue;

      const rangeFirst = firstH - firstL;
      const rangeLast = lastH - lastL;
      if (rangeLast > rangeFirst * 0.8) continue; // No está convergiendo suficiente

      const breakoutLevel = lastH;
      const target = breakoutLevel + poleH;

      return {
        name: "Banderín Alcista",
        nameEn: "Pennant",
        type: "continuation",
        bias: "bullish",
        status: price > breakoutLevel ? "confirmed" : "forming",
        confidence: price > breakoutLevel ? 75 : 55,
        entry: breakoutLevel,
        stop: lastL,
        target,
        lines: [
          // Pole
          { points: [
            { time: candles[poleStart].time, value: candles[poleStart].low },
            { time: candles[poleEnd].time, value: candles[poleEnd].high },
          ], color: "#10b981", lineWidth: 2 },
          // Pennant upper
          { points: [
            { time: pennantCandles[0].time, value: firstH },
            { time: pennantCandles[pennantCandles.length - 1].time, value: lastH },
          ], color: "#a78bfa", lineWidth: 1 },
          // Pennant lower
          { points: [
            { time: pennantCandles[0].time, value: firstL },
            { time: pennantCandles[pennantCandles.length - 1].time, value: lastL },
          ], color: "#a78bfa", lineWidth: 1 },
        ],
        projectionLine: {
          points: [
            { time: pennantCandles[pennantCandles.length - 1].time, value: breakoutLevel },
            { time: pennantCandles[pennantCandles.length - 1].time, value: target },
          ],
          color: "#10b98160", lineWidth: 2, style: "dotted",
        },
        description: `Asta: ${polePct.toFixed(1)}%. Consolidación triangular. Target: $${target.toFixed(2)}`,
      };
    }
  }
  return null;
}

// ------------------------------------------------------------------
// 9. ROUNDING BOTTOM
// ------------------------------------------------------------------

function detectRoundingBottom(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern | null {
  if (candles.length < 30) return null;
  const n = candles.length;
  const price = candles[n - 1].close;

  // Buscar una "U": precio baja gradualmente, hace piso, y sube gradualmente
  // Dividir en tercios: primer tercio baja, segundo plano, tercero sube
  const third = Math.floor(n / 3);
  if (third < 8) return null;

  const seg1 = candles.slice(0, third);
  const seg2 = candles.slice(third, third * 2);
  const seg3 = candles.slice(third * 2);

  const avg1 = seg1.reduce((s, c) => s + c.close, 0) / seg1.length;
  const avg2 = seg2.reduce((s, c) => s + c.close, 0) / seg2.length;
  const avg3 = seg3.reduce((s, c) => s + c.close, 0) / seg3.length;

  // Seg1 > Seg2 (bajó) Y Seg3 > Seg2 (subió) Y ambos extremos similares
  if (avg1 <= avg2 || avg3 <= avg2) return null;
  if (avg2 >= avg1 * 0.97) return null; // La caída debe ser significativa

  const resistance = Math.max(candles[0].high, candles[n - 1].high);
  const bottom = Math.min(...seg2.map((c) => c.low));
  const height = resistance - bottom;

  if (height / resistance * 100 < 2) return null;

  const confirmed = price > resistance;

  // Curva suave: 5 puntos equidistantes
  const curvePoints = [0, third / 2, third, third * 1.5, third * 2, n - 1].map((idx) => {
    const i = Math.min(Math.floor(idx), n - 1);
    return { time: candles[i].time, value: candles[i].close };
  });

  return {
    name: "Piso Redondeado",
    nameEn: "Rounding Bottom",
    type: "reversal",
    bias: "bullish",
    status: confirmed ? "confirmed" : "forming",
    confidence: confirmed ? 75 : 50,
    entry: resistance,
    stop: bottom,
    target: resistance + height,
    lines: [
      { points: curvePoints, color: "#10b981", lineWidth: 2 },
      // Resistance line
      { points: [
        { time: candles[0].time, value: resistance },
        { time: candles[n - 1].time, value: resistance },
      ], color: "#f472b6", lineWidth: 1, style: "dashed" },
    ],
    projectionLine: confirmed ? {
      points: [
        { time: candles[n - 1].time, value: resistance },
        { time: candles[n - 1].time, value: resistance + height },
      ],
      color: "#10b98160", lineWidth: 2, style: "dotted",
    } : undefined,
    description: `Piso en $${bottom.toFixed(2)}, resistencia en $${resistance.toFixed(2)}`,
  };
}

// ------------------------------------------------------------------
// 10. DIAMOND
// ------------------------------------------------------------------

function detectDiamond(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern | null {
  if (pivots.highs.length < 4 || pivots.lows.length < 4) return null;
  const n = candles.length;
  const price = candles[n - 1].close;

  // Diamond: primera mitad se expande (broadening), segunda mitad converge (triangle)
  const mid = Math.floor(pivots.highs.length / 2);
  const firstHalf = pivots.highs.slice(0, mid);
  const secondHalf = pivots.highs.slice(mid);

  if (firstHalf.length < 2 || secondHalf.length < 2) return null;

  // First half: highs expanding
  const fhExpanding = firstHalf[firstHalf.length - 1].price > firstHalf[0].price;
  // Second half: highs contracting
  const shContracting = secondHalf[secondHalf.length - 1].price < secondHalf[0].price;

  if (!fhExpanding || !shContracting) return null;

  // Same check for lows
  const midL = Math.floor(pivots.lows.length / 2);
  const firstLows = pivots.lows.slice(0, midL);
  const secondLows = pivots.lows.slice(midL);
  if (firstLows.length < 2 || secondLows.length < 2) return null;

  const flExpanding = firstLows[firstLows.length - 1].price < firstLows[0].price;
  const slContracting = secondLows[secondLows.length - 1].price > secondLows[0].price;

  if (!flExpanding || !slContracting) return null;

  const allPrices = [...pivots.highs, ...pivots.lows].map((p) => p.price);
  const highest = Math.max(...allPrices);
  const lowest = Math.min(...allPrices);
  const height = highest - lowest;
  if (height / lowest * 100 < 2) return null;

  const breakoutDown = price < secondLows[secondLows.length - 1].price;
  const target = breakoutDown ? lowest - height : highest + height;

  return {
    name: "Diamante",
    nameEn: "Diamond",
    type: "reversal",
    bias: "bearish",
    status: breakoutDown ? "confirmed" : "forming",
    confidence: breakoutDown ? 70 : 45,
    entry: secondLows[secondLows.length - 1].price,
    stop: highest,
    target,
    lines: [
      // Upper diamond outline
      { points: [
        { time: firstHalf[0].time, value: firstHalf[0].price },
        { time: firstHalf[firstHalf.length - 1].time, value: firstHalf[firstHalf.length - 1].price },
        { time: secondHalf[secondHalf.length - 1].time, value: secondHalf[secondHalf.length - 1].price },
      ], color: "#f472b6", lineWidth: 2 },
      // Lower diamond outline
      { points: [
        { time: firstLows[0].time, value: firstLows[0].price },
        { time: firstLows[firstLows.length - 1].time, value: firstLows[firstLows.length - 1].price },
        { time: secondLows[secondLows.length - 1].time, value: secondLows[secondLows.length - 1].price },
      ], color: "#22d3ee", lineWidth: 2 },
    ],
    description: `Expansión → contracción. Alto $${highest.toFixed(2)}, bajo $${lowest.toFixed(2)}`,
  };
}

// ------------------------------------------------------------------
// 11. ARMÓNICOS: ABCD, BUTTERFLY, GARTLEY (Fibonacci)
// ------------------------------------------------------------------

const FIB = {
  "0.382": 0.382, "0.5": 0.5, "0.618": 0.618,
  "0.786": 0.786, "1.0": 1.0, "1.272": 1.272, "1.618": 1.618,
};

function fibRatio(move: number, reference: number): number {
  return reference !== 0 ? Math.abs(move / reference) : 0;
}

function nearFib(ratio: number, target: number, tolerance = 0.05): boolean {
  return Math.abs(ratio - target) <= tolerance;
}

function detectHarmonics(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern[] {
  const results: ChartPattern[] = [];
  const n = candles.length;
  const price = candles[n - 1].close;

  // Merge and sort all pivots by index
  const allPivots: (Pivot & { type: "H" | "L" })[] = [
    ...pivots.highs.map((p) => ({ ...p, type: "H" as const })),
    ...pivots.lows.map((p) => ({ ...p, type: "L" as const })),
  ].sort((a, b) => a.idx - b.idx);

  // Need at least 4 alternating pivots for ABCD, 5 for Butterfly/Gartley
  if (allPivots.length < 4) return results;

  // Find XABCD patterns in the last pivots
  const recent = allPivots.slice(-8);

  // Try all 4-point combinations for ABCD
  for (let i = 0; i <= recent.length - 4; i++) {
    const A = recent[i];
    const B = recent[i + 1];
    const C = recent[i + 2];
    const D = recent[i + 3];

    // Must alternate H/L
    if (A.type === B.type || B.type === C.type || C.type === D.type) continue;

    const AB = B.price - A.price;
    const BC = C.price - B.price;
    const CD = D.price - C.price;

    // AB and CD should be in the same direction, BC opposite
    if (Math.sign(AB) === Math.sign(BC)) continue;
    if (Math.sign(AB) !== Math.sign(CD)) continue;

    const bcRatio = fibRatio(BC, AB);
    const cdRatio = fibRatio(CD, BC);

    // ABCD: BC = 0.618 of AB, CD = 1.272 of BC
    if (nearFib(bcRatio, 0.618, 0.08) && nearFib(cdRatio, 1.272, 0.1)) {
      const isBullish = D.type === "L"; // D is a low = bullish entry
      results.push({
        name: "ABCD",
        nameEn: "ABCD",
        type: "reversal",
        bias: isBullish ? "bullish" : "bearish",
        status: "confirmed",
        confidence: 70,
        entry: D.price,
        stop: isBullish ? D.price - Math.abs(CD) * 0.3 : D.price + Math.abs(CD) * 0.3,
        target: isBullish ? D.price + Math.abs(AB) * 0.618 : D.price - Math.abs(AB) * 0.618,
        lines: [
          { points: [
            { time: A.time, value: A.price },
            { time: B.time, value: B.price },
            { time: C.time, value: C.price },
            { time: D.time, value: D.price },
          ], color: isBullish ? "#10b981" : "#ef4444", lineWidth: 2 },
          // AB line dashed for reference
          { points: [
            { time: A.time, value: A.price },
            { time: C.time, value: C.price },
          ], color: "#a78bfa40", lineWidth: 1, style: "dashed" },
        ],
        description: `BC=${(bcRatio * 100).toFixed(0)}% de AB, CD=${(cdRatio * 100).toFixed(0)}% de BC`,
      });
    }
  }

  // Try 5-point combinations for Butterfly/Gartley (XABCD)
  for (let i = 0; i <= recent.length - 5; i++) {
    const X = recent[i];
    const A = recent[i + 1];
    const B = recent[i + 2];
    const C = recent[i + 3];
    const D = recent[i + 4];

    if (X.type === A.type || A.type === B.type || B.type === C.type || C.type === D.type) continue;

    const XA = A.price - X.price;
    const AB = B.price - A.price;
    const BC = C.price - B.price;
    const CD = D.price - C.price;

    if (Math.sign(XA) === Math.sign(AB)) continue;

    const abRatio = fibRatio(AB, XA);
    const bcRatio = fibRatio(BC, AB);
    const xdRatio = fibRatio(D.price - X.price, XA);

    // Gartley: AB = 0.618 XA, D = 0.786 XA
    if (nearFib(abRatio, 0.618, 0.08) && nearFib(xdRatio, 0.786, 0.08)) {
      const isBullish = D.type === "L";
      results.push({
        name: "Gartley",
        nameEn: "Gartley",
        type: "reversal",
        bias: isBullish ? "bullish" : "bearish",
        status: "confirmed",
        confidence: 75,
        entry: D.price,
        stop: X.price,
        target: isBullish ? D.price + Math.abs(XA) * 0.618 : D.price - Math.abs(XA) * 0.618,
        lines: [
          { points: [
            { time: X.time, value: X.price },
            { time: A.time, value: A.price },
            { time: B.time, value: B.price },
            { time: C.time, value: C.price },
            { time: D.time, value: D.price },
          ], color: isBullish ? "#00e5ff" : "#ff6e40", lineWidth: 2 },
          // XA reference
          { points: [
            { time: X.time, value: X.price },
            { time: D.time, value: D.price },
          ], color: "#a78bfa40", lineWidth: 1, style: "dashed" },
        ],
        description: `AB=${(abRatio * 100).toFixed(0)}% XA. D en ${(xdRatio * 100).toFixed(0)}% de XA (ideal: 78.6%)`,
      });
      continue;
    }

    // Butterfly: AB = 0.786 XA, D = 1.272 XA
    if (nearFib(abRatio, 0.786, 0.08) && (nearFib(xdRatio, 1.272, 0.1) || nearFib(xdRatio, 1.618, 0.1))) {
      const isBullish = D.type === "L";
      results.push({
        name: "Butterfly",
        nameEn: "Butterfly",
        type: "reversal",
        bias: isBullish ? "bullish" : "bearish",
        status: "confirmed",
        confidence: 70,
        entry: D.price,
        stop: isBullish ? D.price - Math.abs(XA) * 0.2 : D.price + Math.abs(XA) * 0.2,
        target: isBullish ? D.price + Math.abs(XA) * 0.618 : D.price - Math.abs(XA) * 0.618,
        lines: [
          { points: [
            { time: X.time, value: X.price },
            { time: A.time, value: A.price },
            { time: B.time, value: B.price },
            { time: C.time, value: C.price },
            { time: D.time, value: D.price },
          ], color: isBullish ? "#76ff03" : "#f50057", lineWidth: 2 },
          { points: [
            { time: X.time, value: X.price },
            { time: D.time, value: D.price },
          ], color: "#a78bfa40", lineWidth: 1, style: "dashed" },
        ],
        description: `AB=${(abRatio * 100).toFixed(0)}% XA. D en ${(xdRatio * 100).toFixed(0)}% de XA (ideal: 127-162%)`,
      });
    }
  }

  return results;
}

// ------------------------------------------------------------------
// DETECTOR PRINCIPAL
// ------------------------------------------------------------------

export function detectChartPatterns(candles: Candle[]): ChartPattern[] {
  if (candles.length < 25) return [];

  const pivots = findPivots(candles, 3);
  const patterns: ChartPattern[] = [];

  // Scan ALL pivots for patterns across the whole chart
  patterns.push(...detectHeadShoulders(candles, pivots));
  patterns.push(...detectDoubleTopBottom(candles, pivots));
  patterns.push(...detectTripleBottomTop(candles, pivots));

  const channel = detectChannel(candles, pivots);
  if (channel) patterns.push(channel);

  const flag = detectFlag(candles, pivots);
  if (flag) patterns.push(flag);

  const pennant = detectPennant(candles, pivots);
  if (pennant) patterns.push(pennant);

  const wedge = detectWedge(candles, pivots);
  if (wedge) patterns.push(wedge);

  const rounding = detectRoundingBottom(candles, pivots);
  if (rounding) patterns.push(rounding);

  const diamond = detectDiamond(candles, pivots);
  if (diamond) patterns.push(diamond);

  // Harmonic patterns (ABCD, Gartley, Butterfly)
  patterns.push(...detectHarmonics(candles, pivots));

  const rect = detectRectangle(candles, pivots);
  if (rect && patterns.length < 3) patterns.push(rect);

  // Dedup: si hay patrones en la misma zona de precio, quedarse con el de mayor confianza
  patterns.sort((a, b) => b.confidence - a.confidence);

  // Limitar a 6 patrones max para no saturar
  return patterns.slice(0, 6);
}
