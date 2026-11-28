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

function detectDoubleTopBottom(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern | null {
  const n = candles.length;
  const price = candles[n - 1].close;

  // Double Top: dos máximos similares con valle entre ellos
  if (pivots.highs.length >= 2) {
    const h = pivots.highs.slice(-4); // últimos 4 pivot highs
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

      return {
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
          // Línea de resistencia (tops)
          { points: [
            { time: top1.time, value: top1.price },
            { time: top2.time, value: top2.price },
          ], color: "#ef4444", lineWidth: 2 },
          // Neckline
          { points: [
            { time: top1.time, value: neckline },
            { time: candles[n - 1].time, value: neckline },
          ], color: "#f59e0b", lineWidth: 1, style: "dashed" },
        ],
        projectionLine: confirmed ? {
          points: [
            { time: candles[n - 1].time, value: neckline },
            { time: candles[n - 1].time, value: target },
          ],
          color: "#ef444480",
          lineWidth: 2,
          style: "dotted",
        } : undefined,
        description: `Techos en ~$${((top1.price + top2.price) / 2).toFixed(2)}. Neckline: $${neckline.toFixed(2)}. Target: $${target.toFixed(2)}`,
      };
    }
  }

  // Double Bottom: dos mínimos similares con pico entre ellos
  if (pivots.lows.length >= 2) {
    const l = pivots.lows.slice(-4);
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

      return {
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
            { time: candles[n - 1].time, value: neckline },
          ], color: "#f59e0b", lineWidth: 1, style: "dashed" },
        ],
        projectionLine: confirmed ? {
          points: [
            { time: candles[n - 1].time, value: neckline },
            { time: candles[n - 1].time, value: target },
          ],
          color: "#10b98180",
          lineWidth: 2,
          style: "dotted",
        } : undefined,
        description: `Pisos en ~$${((bot1.price + bot2.price) / 2).toFixed(2)}. Neckline: $${neckline.toFixed(2)}. Target: $${target.toFixed(2)}`,
      };
    }
  }

  return null;
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

function detectHeadShoulders(candles: Candle[], pivots: { highs: Pivot[]; lows: Pivot[] }): ChartPattern | null {
  const n = candles.length;
  const price = candles[n - 1].close;

  // H&S: tres picos, el del medio más alto
  if (pivots.highs.length >= 3) {
    const h = pivots.highs.slice(-5);
    for (let i = 0; i <= h.length - 3; i++) {
      const ls = h[i];     // left shoulder
      const head = h[i + 1]; // head
      const rs = h[i + 2];   // right shoulder

      // Head must be highest
      if (head.price <= ls.price || head.price <= rs.price) continue;
      // Shoulders should be similar height (< 3%)
      if (pctDiff(ls.price, rs.price) > 3) continue;
      // Minimum spacing
      if (head.idx - ls.idx < 3 || rs.idx - head.idx < 3) continue;

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
      if (height / neckline * 100 < 1.5) continue;

      const confirmed = price < neckline;
      const target = neckline - height;

      return {
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
          // Pattern outline
          { points: [
            { time: ls.time, value: ls.price },
            { time: head.time, value: head.price },
            { time: rs.time, value: rs.price },
          ], color: "#ef4444", lineWidth: 2 },
          // Neckline
          { points: [
            { time: ls.time, value: neckline },
            { time: candles[n - 1].time, value: neckline },
          ], color: "#f59e0b", lineWidth: 1, style: "dashed" },
        ],
        projectionLine: {
          points: [
            { time: candles[n - 1].time, value: neckline },
            { time: candles[n - 1].time, value: target },
          ],
          color: "#ef444480",
          lineWidth: 2,
          style: "dotted",
        },
        description: `Cabeza: $${head.price.toFixed(2)}. Hombros: ~$${((ls.price + rs.price) / 2).toFixed(2)}. Neckline: $${neckline.toFixed(2)}. Target: $${target.toFixed(2)}`,
      };
    }
  }

  // Inverse H&S: tres valles, el del medio más bajo
  if (pivots.lows.length >= 3) {
    const l = pivots.lows.slice(-5);
    for (let i = 0; i <= l.length - 3; i++) {
      const ls = l[i];
      const head = l[i + 1];
      const rs = l[i + 2];

      if (head.price >= ls.price || head.price >= rs.price) continue;
      if (pctDiff(ls.price, rs.price) > 3) continue;
      if (head.idx - ls.idx < 3 || rs.idx - head.idx < 3) continue;

      let neck1 = -Infinity, neck2 = -Infinity;
      for (let j = ls.idx + 1; j < head.idx; j++) {
        if (candles[j].high > neck1) neck1 = candles[j].high;
      }
      for (let j = head.idx + 1; j < rs.idx; j++) {
        if (candles[j].high > neck2) neck2 = candles[j].high;
      }
      const neckline = (neck1 + neck2) / 2;
      const height = neckline - head.price;
      if (height / neckline * 100 < 1.5) continue;

      const confirmed = price > neckline;
      const target = neckline + height;

      return {
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
            { time: candles[n - 1].time, value: neckline },
          ], color: "#f59e0b", lineWidth: 1, style: "dashed" },
        ],
        projectionLine: {
          points: [
            { time: candles[n - 1].time, value: neckline },
            { time: candles[n - 1].time, value: target },
          ],
          color: "#10b98180",
          lineWidth: 2,
          style: "dotted",
        },
        description: `Cabeza: $${head.price.toFixed(2)}. Hombros: ~$${((ls.price + rs.price) / 2).toFixed(2)}. Neckline: $${neckline.toFixed(2)}. Target: $${target.toFixed(2)}`,
      };
    }
  }

  return null;
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
// DETECTOR PRINCIPAL
// ------------------------------------------------------------------

export function detectChartPatterns(candles: Candle[]): ChartPattern[] {
  if (candles.length < 25) return [];

  const pivots = findPivots(candles, 3);
  const patterns: ChartPattern[] = [];

  // Ejecutar cada detector — priorizar por confiabilidad
  const hs = detectHeadShoulders(candles, pivots);
  if (hs) patterns.push(hs);

  const dbl = detectDoubleTopBottom(candles, pivots);
  if (dbl) patterns.push(dbl);

  const flag = detectFlag(candles, pivots);
  if (flag) patterns.push(flag);

  const wedge = detectWedge(candles, pivots);
  if (wedge) patterns.push(wedge);

  const rect = detectRectangle(candles, pivots);
  if (rect && patterns.length === 0) patterns.push(rect); // solo si no hay otro patrón más fuerte

  // Ordenar por confianza
  patterns.sort((a, b) => b.confidence - a.confidence);

  return patterns;
}
