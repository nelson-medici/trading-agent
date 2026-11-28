/**
 * Detección de patrones de velas japonesas y estructura de mercado.
 * Cada patrón genera un marcador visual para el gráfico.
 */

import type { Candle } from "./patterns";

// ------------------------------------------------------------------
// Tipos
// ------------------------------------------------------------------

export interface CandlePattern {
  idx: number;
  time: number | string;
  name: string;
  nameEn: string;
  bias: "bullish" | "bearish";
  description: string;
  strength: number; // 1-3 (1=débil, 3=fuerte)
}

export interface StructurePoint {
  idx: number;
  time: number | string;
  price: number;
  label: "HH" | "HL" | "LH" | "LL"; // Higher High, Higher Low, Lower High, Lower Low
}

export interface MarketStructure {
  points: StructurePoint[];
  trend: "uptrend" | "downtrend" | "ranging";
  description: string;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function body(c: Candle): number { return Math.abs(c.close - c.open); }
function upperWick(c: Candle): number { return c.high - Math.max(c.open, c.close); }
function lowerWick(c: Candle): number { return Math.min(c.open, c.close) - c.low; }
function range(c: Candle): number { return c.high - c.low; }
function isBullish(c: Candle): boolean { return c.close > c.open; }
function isBearish(c: Candle): boolean { return c.close < c.open; }
function midpoint(c: Candle): number { return (c.open + c.close) / 2; }

// ------------------------------------------------------------------
// 1. PATRONES DE UNA VELA
// ------------------------------------------------------------------

function detectMarubozu(c: Candle, avgBody: number): CandlePattern | null {
  const b = body(c);
  const uw = upperWick(c);
  const lw = lowerWick(c);
  const r = range(c);
  if (r < 1e-12) return null;

  // Cuerpo > 90% del rango y > 1.5× cuerpo promedio
  if (b / r >= 0.90 && b > avgBody * 1.5) {
    return {
      idx: 0, time: c.time,
      name: isBullish(c) ? "Marubozu Alcista" : "Marubozu Bajista",
      nameEn: "Marubozu",
      bias: isBullish(c) ? "bullish" : "bearish",
      description: `Vela fuerte sin mechas: impulso ${isBullish(c) ? "comprador" : "vendedor"} decisivo`,
      strength: 3,
    };
  }
  return null;
}

function detectHammer(c: Candle, avgBody: number): CandlePattern | null {
  const b = body(c);
  const lw = lowerWick(c);
  const uw = upperWick(c);
  if (b < 1e-12) return null;

  // Mecha inferior > 2× cuerpo, mecha superior < 30% del cuerpo
  if (lw >= b * 2 && uw <= b * 0.3) {
    return {
      idx: 0, time: c.time,
      name: "Martillo",
      nameEn: "Hammer",
      bias: "bullish",
      description: "Mecha inferior larga: los vendedores empujaron pero los compradores recuperaron",
      strength: 2,
    };
  }
  return null;
}

function detectShootingStar(c: Candle, avgBody: number): CandlePattern | null {
  const b = body(c);
  const uw = upperWick(c);
  const lw = lowerWick(c);
  if (b < 1e-12) return null;

  // Mecha superior > 2× cuerpo, mecha inferior < 30% del cuerpo
  if (uw >= b * 2 && lw <= b * 0.3) {
    return {
      idx: 0, time: c.time,
      name: "Estrella Fugaz",
      nameEn: "Shooting Star",
      bias: "bearish",
      description: "Mecha superior larga: los compradores empujaron pero los vendedores rechazaron",
      strength: 2,
    };
  }
  return null;
}

function detectDoji(c: Candle, avgBody: number): CandlePattern | null {
  const b = body(c);
  const r = range(c);
  if (r < 1e-12) return null;

  // Cuerpo < 10% del rango
  if (b / r <= 0.10 && r > avgBody * 0.5) {
    return {
      idx: 0, time: c.time,
      name: "Doji",
      nameEn: "Doji",
      bias: "bullish", // neutral realmente, pero depende del contexto
      description: "Indecisión: apertura ≈ cierre. Posible cambio de tendencia",
      strength: 1,
    };
  }
  return null;
}

// ------------------------------------------------------------------
// 2. PATRONES DE DOS VELAS
// ------------------------------------------------------------------

function detectEngulfing(prev: Candle, curr: Candle): CandlePattern | null {
  const prevBody = body(prev);
  const currBody = body(curr);
  if (prevBody < 1e-12) return null;

  // Bullish Engulfing: vela bajista seguida de vela alcista que envuelve
  if (isBearish(prev) && isBullish(curr) && curr.open <= prev.close && curr.close >= prev.open && currBody > prevBody) {
    return {
      idx: 0, time: curr.time,
      name: "Envolvente Alcista",
      nameEn: "Bullish Engulfing",
      bias: "bullish",
      description: "La vela verde envuelve completamente a la roja anterior: reversión alcista",
      strength: 3,
    };
  }

  // Bearish Engulfing
  if (isBullish(prev) && isBearish(curr) && curr.open >= prev.close && curr.close <= prev.open && currBody > prevBody) {
    return {
      idx: 0, time: curr.time,
      name: "Envolvente Bajista",
      nameEn: "Bearish Engulfing",
      bias: "bearish",
      description: "La vela roja envuelve completamente a la verde anterior: reversión bajista",
      strength: 3,
    };
  }

  return null;
}

function detectDarkCloud(prev: Candle, curr: Candle): CandlePattern | null {
  if (!isBullish(prev) || !isBearish(curr)) return null;
  // La vela bajista abre por encima del cierre anterior y cierra por debajo del midpoint
  if (curr.open > prev.close && curr.close < midpoint(prev) && curr.close > prev.open) {
    return {
      idx: 0, time: curr.time,
      name: "Nube Oscura",
      nameEn: "Dark Cloud Cover",
      bias: "bearish",
      description: "Abre por encima del cierre anterior y penetra el 50% del cuerpo: presión vendedora",
      strength: 2,
    };
  }
  return null;
}

function detectHarami(prev: Candle, curr: Candle): CandlePattern | null {
  const prevBody = body(prev);
  const currBody = body(curr);
  if (prevBody < 1e-12 || currBody >= prevBody) return null;

  const prevHigh = Math.max(prev.open, prev.close);
  const prevLow = Math.min(prev.open, prev.close);
  const currHigh = Math.max(curr.open, curr.close);
  const currLow = Math.min(curr.open, curr.close);

  // El cuerpo de la segunda vela está contenido dentro del cuerpo de la primera
  if (currHigh <= prevHigh && currLow >= prevLow && currBody < prevBody * 0.5) {
    const bias = isBearish(prev) ? "bullish" : "bearish";
    return {
      idx: 0, time: curr.time,
      name: `Harami ${bias === "bullish" ? "Alcista" : "Bajista"}`,
      nameEn: "Harami",
      bias,
      description: `Vela pequeña contenida en la anterior: pérdida de momentum ${isBearish(prev) ? "vendedor" : "comprador"}`,
      strength: 2,
    };
  }
  return null;
}

// ------------------------------------------------------------------
// DETECTOR PRINCIPAL DE VELAS
// ------------------------------------------------------------------

export function detectCandlePatterns(candles: Candle[], lookback = 30): CandlePattern[] {
  if (candles.length < 10) return [];

  // Cuerpo promedio para relativizar
  const bodies = candles.slice(-50).map((c) => body(c));
  const avgBody = bodies.reduce((s, b) => s + b, 0) / bodies.length;

  const patterns: CandlePattern[] = [];
  const start = Math.max(1, candles.length - lookback);

  for (let i = start; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    // Una vela
    for (const detect of [detectMarubozu, detectHammer, detectShootingStar, detectDoji]) {
      const p = detect(curr, avgBody);
      if (p) { p.idx = i; patterns.push(p); break; } // solo 1 patrón por vela
    }

    // Dos velas
    for (const detect of [detectEngulfing, detectDarkCloud, detectHarami]) {
      const p = detect(prev, curr);
      if (p) { p.idx = i; patterns.push(p); break; }
    }
  }

  return patterns;
}

// ------------------------------------------------------------------
// 3. ESTRUCTURA DE MERCADO (HH/HL/LH/LL)
// ------------------------------------------------------------------

export function detectMarketStructure(candles: Candle[], pivotLookback = 5): MarketStructure {
  const points: StructurePoint[] = [];
  if (candles.length < pivotLookback * 2 + 5) {
    return { points, trend: "ranging", description: "Datos insuficientes" };
  }

  // Encontrar pivots
  const pivotHighs: { idx: number; price: number }[] = [];
  const pivotLows: { idx: number; price: number }[] = [];

  for (let i = pivotLookback; i < candles.length - pivotLookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - pivotLookback; j <= i + pivotLookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) pivotHighs.push({ idx: i, price: candles[i].high });
    if (isLow) pivotLows.push({ idx: i, price: candles[i].low });
  }

  // Clasificar cada pivot como HH/LH o HL/LL
  for (let i = 1; i < pivotHighs.length; i++) {
    const label = pivotHighs[i].price > pivotHighs[i - 1].price ? "HH" : "LH";
    points.push({
      idx: pivotHighs[i].idx,
      time: candles[pivotHighs[i].idx].time,
      price: pivotHighs[i].price,
      label,
    });
  }

  for (let i = 1; i < pivotLows.length; i++) {
    const label = pivotLows[i].price > pivotLows[i - 1].price ? "HL" : "LL";
    points.push({
      idx: pivotLows[i].idx,
      time: candles[pivotLows[i].idx].time,
      price: pivotLows[i].price,
      label,
    });
  }

  // Ordenar por índice
  points.sort((a, b) => a.idx - b.idx);

  // Determinar tendencia de los últimos 6 puntos
  const recent = points.slice(-6);
  const hhCount = recent.filter((p) => p.label === "HH").length;
  const hlCount = recent.filter((p) => p.label === "HL").length;
  const lhCount = recent.filter((p) => p.label === "LH").length;
  const llCount = recent.filter((p) => p.label === "LL").length;

  let trend: "uptrend" | "downtrend" | "ranging" = "ranging";
  let description = "Rango lateral: sin dirección clara";

  if (hhCount >= 2 && hlCount >= 1) {
    trend = "uptrend";
    description = `Tendencia alcista: ${hhCount} HH + ${hlCount} HL — máximos y mínimos crecientes`;
  } else if (llCount >= 2 && lhCount >= 1) {
    trend = "downtrend";
    description = `Tendencia bajista: ${llCount} LL + ${lhCount} LH — máximos y mínimos decrecientes`;
  }

  return { points, trend, description };
}
