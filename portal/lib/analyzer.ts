/**
 * Analizador de mercado — genera lectura narrativa y decisión
 * a partir de patrones detectados, indicadores y volumen.
 * 100% determinístico, sin IA.
 */
import {
  detectLevels, detectFVG, detectRejections, computeVolumeProfile,
  type Candle, type PriceLevel, type FVGZone, type Rejection, type VolumeProfileBar,
} from "./patterns";
import { computeEMA } from "./utils";

// ------------------------------------------------------------------
// Tipos
// ------------------------------------------------------------------

export type MarketBias = "bullish" | "bearish" | "neutral";
export type ActionType = "BUY" | "SELL" | "WAIT" | "WATCH";

export interface DetectedPattern {
  name: string;
  description: string;
  bias: MarketBias;
  confirmationRule: string;  // qué debe pasar para confirmar
  confirmed: boolean;
  strength: number;  // 0-100
}

export interface AnalysisResult {
  timestamp: string;
  symbol: string;
  timeframe: string;
  price: number;

  // Patrones
  patterns: DetectedPattern[];
  levels: PriceLevel[];
  fvgs: FVGZone[];
  rejections: Rejection[];
  volumeProfile: VolumeProfileBar[];

  // Indicadores
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  rsi: number;
  atr: number;
  atrPct: number;
  volumeRatio: number;  // volumen actual vs promedio

  // Lectura
  bias: MarketBias;
  biasStrength: number;  // 0-100
  action: ActionType;
  reading: string;  // narrativa corta
  forecast: string;  // pronóstico accionable: qué hacer y cuándo
  details: string[];  // bullets de detalle
  triggerCondition: string | null;  // si hay un trigger, qué esperar

  // Fase del mercado (Wyckoff)
  marketPhase: "accumulation" | "advance" | "distribution" | "decline";
  marketPhaseLabel: string;

  // Contextual Score (6 dimensiones)
  contextScore: {
    total: number;
    pattern: number;
    phase: number;
    mtf: number;
    volume: number;
    structure: number;
    momentum: number;
    label: string;    // "Alta certeza", "Entrada fuerte", etc.
    reasons: string[];
  };

  // Pivots para dibujar triángulos y canales
  pivotHighs: { idx: number; price: number; time: string | number }[];
  pivotLows: { idx: number; price: number; time: string | number }[];
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  let atrVal = 0;
  const alpha = 1 / period;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    atrVal = i <= period ? atrVal + tr / period : atrVal * (1 - alpha) + tr * alpha;
  }
  return atrVal;
}

interface TriangleResult {
  pattern: DetectedPattern | null;
  pivotHighs: { idx: number; price: number; time: string | number }[];
  pivotLows: { idx: number; price: number; time: string | number }[];
}

function detectTriangleSimple(candles: Candle[], lookback = 3): TriangleResult {
  const empty: TriangleResult = { pattern: null, pivotHighs: [], pivotLows: [] };
  if (candles.length < 30) return empty;

  const offset = Math.max(0, candles.length - 40);
  const recent = candles.slice(-40);
  const pivotHighs: { idx: number; price: number }[] = [];
  const pivotLows: { idx: number; price: number }[] = [];

  for (let i = lookback; i < recent.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (recent[j].high >= recent[i].high) isHigh = false;
      if (recent[j].low <= recent[i].low) isLow = false;
    }
    if (isHigh) pivotHighs.push({ idx: i, price: recent[i].high });
    if (isLow) pivotLows.push({ idx: i, price: recent[i].low });
  }

  // Map pivots to include candle time for drawing
  const pivotsH = pivotHighs.map((p) => ({ ...p, idx: p.idx + offset, time: candles[p.idx + offset]?.time ?? 0 }));
  const pivotsL = pivotLows.map((p) => ({ ...p, idx: p.idx + offset, time: candles[p.idx + offset]?.time ?? 0 }));

  if (pivotHighs.length < 2 || pivotLows.length < 2) return { pattern: null, pivotHighs: pivotsH, pivotLows: pivotsL };

  const ph = pivotHighs.slice(-3);
  const pl = pivotLows.slice(-3);

  const highsDescending = ph.length >= 2 && ph[ph.length - 1].price < ph[ph.length - 2].price;
  const lowsAscending = pl.length >= 2 && pl[pl.length - 1].price > pl[pl.length - 2].price;
  const highsFlat = ph.length >= 2 && Math.abs(ph[ph.length - 1].price - ph[ph.length - 2].price) / ph[ph.length - 2].price < 0.003;
  const lowsFlat = pl.length >= 2 && Math.abs(pl[pl.length - 1].price - pl[pl.length - 2].price) / pl[pl.length - 2].price < 0.003;

  const lastClose = candles[candles.length - 1].close;
  const lastHigh = ph[ph.length - 1].price;
  const lastLow = pl[pl.length - 1].price;

  if (highsDescending && lowsAscending) {
    const breakoutUp = lastClose > lastHigh;
    return {
      pattern: {
        name: "Triángulo Simétrico",
        description: `Máximos decrecientes + mínimos crecientes. Rango comprimido ${((lastHigh - lastLow) / lastLow * 100).toFixed(1)}%.`,
        bias: breakoutUp ? "bullish" : "neutral",
        confirmationRule: `Cierre por encima de ${lastHigh.toFixed(2)} con volumen para confirmar ruptura alcista`,
        confirmed: breakoutUp,
        strength: breakoutUp ? 75 : 50,
      },
      pivotHighs: pivotsH, pivotLows: pivotsL,
    };
  }

  if (highsFlat && lowsAscending) {
    const breakoutUp = lastClose > lastHigh;
    return {
      pattern: {
        name: "Triángulo Ascendente",
        description: `Resistencia plana en ${lastHigh.toFixed(2)} con mínimos crecientes. Sesgo alcista.`,
        bias: "bullish",
        confirmationRule: `Cierre por encima de ${lastHigh.toFixed(2)} con volumen > promedio`,
        confirmed: breakoutUp,
        strength: breakoutUp ? 80 : 60,
      },
      pivotHighs: pivotsH, pivotLows: pivotsL,
    };
  }

  if (highsDescending && lowsFlat) {
    const breakoutDown = lastClose < lastLow;
    return {
      pattern: {
        name: "Triángulo Descendente",
        description: `Soporte plano en ${lastLow.toFixed(2)} con máximos decrecientes. Sesgo bajista.`,
        bias: "bearish",
        confirmationRule: `Cierre por debajo de ${lastLow.toFixed(2)} con volumen para confirmar quiebre`,
        confirmed: breakoutDown,
        strength: breakoutDown ? 80 : 60,
      },
      pivotHighs: pivotsH, pivotLows: pivotsL,
    };
  }

  return { pattern: null, pivotHighs: pivotsH, pivotLows: pivotsL };
}

// ------------------------------------------------------------------
// ANÁLISIS PRINCIPAL
// ------------------------------------------------------------------

export function analyzeMarket(candles: Candle[], symbol: string, timeframe: string): AnalysisResult {
  const n = candles.length;
  const price = n > 0 ? candles[n - 1].close : 0;
  const closes = candles.map((c) => c.close);

  // Indicadores
  const ema9arr = computeEMA(closes, 9);
  const ema21arr = computeEMA(closes, 21);
  const ema50arr = computeEMA(closes, 50);
  const ema200arr = computeEMA(closes, 200);
  const ema9 = ema9arr[n - 1] ?? price;
  const ema21 = ema21arr[n - 1] ?? price;
  const ema50 = ema50arr[n - 1] ?? price;
  const ema200 = ema200arr[n - 1] ?? price;
  const rsiVal = rsi(closes, 14);
  const atrVal = atr(candles, 14);
  const atrPct = price > 0 ? (atrVal / price) * 100 : 0;

  // Volumen relativo
  const recentVol = n >= 20 ? candles.slice(-1)[0].volume ?? 0 : 0;
  const avgVol = n >= 20 ? candles.slice(-21, -1).reduce((s, c) => s + (c.volume ?? 0), 0) / 20 : recentVol || 1;
  const volumeRatio = avgVol > 0 ? recentVol / avgVol : 1;

  // Patrones
  const levels = detectLevels(candles, 5, 0.005, 2, 8);
  const fvgs = detectFVG(candles, 0.002);
  const rejections = detectRejections(candles, levels, 2.0, 0.005);
  const volumeProfile = computeVolumeProfile(candles, 24);
  const poc = volumeProfile.find((b) => b.isPOC);

  const patterns: DetectedPattern[] = [];
  const details: string[] = [];

  // 1. Tendencia por EMAs
  const emaBullish = ema9 > ema21 && ema21 > ema50;
  const emaBearish = ema9 < ema21 && ema21 < ema50;
  const aboveEma200 = price > ema200;

  if (emaBullish && aboveEma200) {
    patterns.push({
      name: "Tendencia alcista",
      description: "EMAs alineadas (9 > 21 > 50) y precio arriba de EMA200",
      bias: "bullish", confirmationRule: "Se mantiene mientras EMA9 > EMA21",
      confirmed: true, strength: 70,
    });
    details.push(`Tendencia alcista: EMAs alineadas, precio ${((price / ema200 - 1) * 100).toFixed(1)}% arriba de EMA200`);
  } else if (emaBearish) {
    patterns.push({
      name: "Tendencia bajista",
      description: "EMAs alineadas a la baja (9 < 21 < 50)",
      bias: "bearish", confirmationRule: "Se mantiene mientras EMA9 < EMA21",
      confirmed: true, strength: 70,
    });
    details.push("Tendencia bajista: EMAs alineadas a la baja");
  } else {
    details.push("Sin tendencia clara: EMAs cruzadas, mercado en rango");
  }

  // 2. RSI
  if (rsiVal < 30) {
    patterns.push({
      name: "RSI Sobreventa",
      description: `RSI(14) = ${rsiVal.toFixed(0)} — zona de sobreventa`,
      bias: "bullish", confirmationRule: "RSI cruza arriba de 30 para confirmar reversión",
      confirmed: rsiVal > 25, strength: 65,
    });
    details.push(`RSI en sobreventa (${rsiVal.toFixed(0)}): posible rebote`);
  } else if (rsiVal > 70) {
    patterns.push({
      name: "RSI Sobrecompra",
      description: `RSI(14) = ${rsiVal.toFixed(0)} — zona de sobrecompra`,
      bias: "bearish", confirmationRule: "RSI cruza abajo de 70 para confirmar corrección",
      confirmed: rsiVal < 75, strength: 65,
    });
    details.push(`RSI en sobrecompra (${rsiVal.toFixed(0)}): posible corrección`);
  } else {
    details.push(`RSI neutral (${rsiVal.toFixed(0)})`);
  }

  // 3. Triángulos
  const triangleResult = detectTriangleSimple(candles);
  if (triangleResult.pattern) {
    patterns.push(triangleResult.pattern);
    details.push(`${triangleResult.pattern.name}: ${triangleResult.pattern.description}`);
  }

  // 4. FVG sin llenar
  const unfilledFVG = fvgs.filter((f) => !f.filled);
  if (unfilledFVG.length > 0) {
    const nearest = unfilledFVG[unfilledFVG.length - 1];
    const dist = nearest.kind === "bullish"
      ? ((price - nearest.top) / price * 100).toFixed(2)
      : ((nearest.bottom - price) / price * 100).toFixed(2);
    patterns.push({
      name: `FVG ${nearest.kind === "bullish" ? "Alcista" : "Bajista"}`,
      description: `Gap sin llenar entre ${nearest.bottom.toFixed(2)} y ${nearest.top.toFixed(2)} (${dist}% de distancia)`,
      bias: nearest.kind === "bullish" ? "bullish" : "bearish",
      confirmationRule: nearest.kind === "bullish"
        ? `Precio retrocede a ${nearest.top.toFixed(2)} y rebota para confirmar soporte`
        : `Precio sube a ${nearest.bottom.toFixed(2)} y rechaza para confirmar resistencia`,
      confirmed: false, strength: 45,
    });
    details.push(`FVG ${nearest.kind} sin llenar: ${nearest.bottom.toFixed(2)}–${nearest.top.toFixed(2)}`);
  }

  // 5. Rechazo reciente
  if (rejections.length > 0) {
    const last = rejections[rejections.length - 1];
    patterns.push({
      name: `Rechazo ${last.kind === "bullish" ? "Alcista" : "Bajista"}`,
      description: `Vela de rechazo con mecha ${last.wickRatio.toFixed(1)}× el cuerpo cerca de ${last.kind === "bullish" ? "soporte" : "resistencia"} ${last.nearLevel.toFixed(2)}`,
      bias: last.kind === "bullish" ? "bullish" : "bearish",
      confirmationRule: last.kind === "bullish"
        ? "Próxima vela cierra por encima del máximo de la vela de rechazo"
        : "Próxima vela cierra por debajo del mínimo de la vela de rechazo",
      confirmed: false, strength: 55,
    });
    details.push(`Rechazo ${last.kind} en nivel ${last.nearLevel.toFixed(2)}`);
  }

  // 6. Soportes/Resistencias cercanos
  const nearSupports = levels.filter((l) => l.kind === "support" && l.price < price && (price - l.price) / price < 0.02);
  const nearResistances = levels.filter((l) => l.kind === "resistance" && l.price > price && (l.price - price) / price < 0.02);
  if (nearSupports.length > 0) {
    details.push(`Soporte cercano: ${nearSupports[0].price.toFixed(2)} (${nearSupports[0].touches} toques)`);
  }
  if (nearResistances.length > 0) {
    details.push(`Resistencia cercana: ${nearResistances[0].price.toFixed(2)} (${nearResistances[0].touches} toques)`);
  }

  // 7. POC del volume profile
  if (poc) {
    const pocDist = ((price - poc.priceLevel) / price * 100);
    details.push(`POC (volumen concentrado): ${poc.priceLevel.toFixed(2)} (${pocDist > 0 ? "+" : ""}${pocDist.toFixed(1)}% del precio)`);
  }

  // 8. Volumen
  if (volumeRatio > 2) {
    details.push(`Volumen alto: ${volumeRatio.toFixed(1)}× el promedio`);
  } else if (volumeRatio < 0.5) {
    details.push(`Volumen bajo: ${volumeRatio.toFixed(1)}× el promedio — poca convicción`);
  }

  // ------------------------------------------------------------------
  // DECISIÓN
  // ------------------------------------------------------------------
  const bullishPatterns = patterns.filter((p) => p.bias === "bullish");
  const bearishPatterns = patterns.filter((p) => p.bias === "bearish");
  const confirmedBullish = bullishPatterns.filter((p) => p.confirmed);
  const confirmedBearish = bearishPatterns.filter((p) => p.confirmed);

  let bias: MarketBias = "neutral";
  let biasStrength = 50;
  let action: ActionType = "WAIT";
  let reading = "";
  let triggerCondition: string | null = null;

  const bullScore = bullishPatterns.reduce((s, p) => s + p.strength, 0);
  const bearScore = bearishPatterns.reduce((s, p) => s + p.strength, 0);

  if (bullScore > bearScore + 30) {
    bias = "bullish";
    biasStrength = Math.min(95, 50 + bullScore - bearScore);
  } else if (bearScore > bullScore + 30) {
    bias = "bearish";
    biasStrength = Math.min(95, 50 + bearScore - bullScore);
  }

  if (confirmedBullish.length >= 2 && volumeRatio >= 1.0) {
    action = "BUY";
    reading = `${confirmedBullish.map((p) => p.name).join(" + ")} · Vol ${volumeRatio.toFixed(1)}×`;
  } else if (confirmedBearish.length >= 2) {
    action = "SELL";
    reading = confirmedBearish.map((p) => p.name).join(" + ");
  } else if (bullishPatterns.length > 0 && !bullishPatterns.some((p) => p.confirmed)) {
    action = "WATCH";
    const pending = bullishPatterns.find((p) => !p.confirmed);
    reading = `${pending?.name} en formación`;
    triggerCondition = pending?.confirmationRule ?? null;
  } else if (bearishPatterns.length > 0 && !bearishPatterns.some((p) => p.confirmed)) {
    action = "WATCH";
    const pending = bearishPatterns.find((p) => !p.confirmed);
    reading = `${pending?.name} en formación`;
    triggerCondition = pending?.confirmationRule ?? null;
  } else {
    action = "WAIT";
    reading = "Sin setup claro";
  }

  // ------------------------------------------------------------------
  // PRONÓSTICO ACCIONABLE
  // ------------------------------------------------------------------
  let forecast = "";
  const nearSup = levels.filter((l) => l.kind === "support" && l.price < price).sort((a, b) => b.price - a.price)[0];
  const nearRes = levels.filter((l) => l.kind === "resistance" && l.price > price).sort((a, b) => a.price - b.price)[0];

  if (action === "BUY") {
    const stopPrice = nearSup ? nearSup.price : price * (1 - atrPct / 100 * 2);
    const targetPrice = nearRes ? nearRes.price : price * (1 + atrPct / 100 * 3);
    const rr = (price - stopPrice) > 0 ? ((targetPrice - price) / (price - stopPrice)).toFixed(1) : "∞";
    forecast = `Comprar → Target $${targetPrice.toFixed(0)} (+${((targetPrice - price) / price * 100).toFixed(1)}%) · Stop $${stopPrice.toFixed(0)} · R:R ${rr}:1`;
  } else if (action === "SELL") {
    forecast = `Salir — ${confirmedBearish.map((p) => p.name).join(" + ")}${nearSup ? ` · Soporte $${nearSup.price.toFixed(0)}` : ""}`;
  } else if (action === "WATCH") {
    const pending = [...bullishPatterns, ...bearishPatterns].find((p) => !p.confirmed);
    if (pending) {
      forecast = `Esperando: ${pending.confirmationRule}`;
    } else {
      forecast = `Señales mixtas — esperar definición`;
    }
  } else {
    forecast = `Sin setup — preservar capital`;
  }

  // ------------------------------------------------------------------
  // FASE DEL MERCADO (Wyckoff simplificado)
  // ------------------------------------------------------------------
  let marketPhase: "accumulation" | "advance" | "distribution" | "decline" = "accumulation";
  let marketPhaseLabel = "";

  const priceAboveEma50 = price > ema50;
  const priceAboveEma200 = price > ema200;
  const ema50AboveEma200 = ema50 > ema200;
  const trendStrong = Math.abs(ema9 - ema50) / ema50 * 100 > 0.5;

  if (priceAboveEma50 && priceAboveEma200 && ema50AboveEma200 && trendStrong) {
    marketPhase = "advance";
    marketPhaseLabel = "Avance — tendencia alcista activa. Precio sobre medias alineadas al alza.";
  } else if (!priceAboveEma50 && !priceAboveEma200 && !ema50AboveEma200 && trendStrong) {
    marketPhase = "decline";
    marketPhaseLabel = "Caída — tendencia bajista activa. Precio bajo medias alineadas a la baja.";
  } else if (priceAboveEma200 && !trendStrong) {
    marketPhase = "distribution";
    marketPhaseLabel = "Distribución — consolidación tras subida. Medias laterales, posible techo.";
  } else if (!priceAboveEma200 && !trendStrong) {
    marketPhase = "accumulation";
    marketPhaseLabel = "Acumulación — consolidación tras caída. Medias laterales, posible piso.";
  } else if (priceAboveEma200 && ema9 < ema21) {
    marketPhase = "distribution";
    marketPhaseLabel = "Distribución — precio sobre EMA200 pero momentum débil. Precaución.";
  } else if (!priceAboveEma200 && ema9 > ema21) {
    marketPhase = "accumulation";
    marketPhaseLabel = "Acumulación — precio bajo EMA200 pero momentum mejorando. Posible reversión.";
  }

  // ------------------------------------------------------------------
  // CONTEXTUAL SCORE (6 dimensiones)
  // ------------------------------------------------------------------
  const emaAligned = (ema9 > ema21 && ema21 > ema50) || (ema9 < ema21 && ema21 < ema50);

  // Structure trend
  const ph = triangleResult.pivotHighs;
  const pl = triangleResult.pivotLows;
  let structTrend: "uptrend" | "downtrend" | "ranging" = "ranging";
  if (ph.length >= 2 && pl.length >= 2) {
    const hh = ph[ph.length - 1].price > ph[ph.length - 2].price;
    const hl = pl[pl.length - 1].price > pl[pl.length - 2].price;
    if (hh && hl) structTrend = "uptrend";
    const lh = ph[ph.length - 1].price < ph[ph.length - 2].price;
    const ll = pl[pl.length - 1].price < pl[pl.length - 2].price;
    if (lh && ll) structTrend = "downtrend";
  }

  // Pattern base rates (from Bulkowski)
  const patternRates: Record<string, number> = {
    "Triángulo Ascendente": 68, "Triángulo Descendente": 58, "Triángulo Simétrico": 65,
    "Tendencia bajista": 55, "Tendencia alcista": 55,
    "RSI Sobreventa": 60, "RSI Sobrecompra": 60,
    "FVG Alcista": 45, "FVG Bajista": 45,
    "Rechazo Alcista": 50, "Rechazo Bajista": 50,
  };

  // Phase alignment bonuses
  const phaseBonus: Record<string, Record<string, number>> = {
    accumulation: { bullish: 20, bearish: -15 },
    advance: { bullish: 15, bearish: -10 },
    distribution: { bearish: 20, bullish: -15 },
    decline: { bearish: 15, bullish: -10 },
  };

  // Calculate per-dimension scores
  const patScores = patterns.map((p) => {
    let s = patternRates[p.name] || 50;
    if (p.confirmed) s += 15; else s -= 10;
    return Math.min(100, Math.max(0, s * (p.strength / 100) + s * 0.3));
  });
  const csPattern = patScores.length > 0 ? patScores.reduce((a, b) => a + b, 0) / patScores.length : 30;

  const phaseMod = phaseBonus[marketPhase]?.[bias] || 0;
  const csPhase = Math.min(100, Math.max(0, 50 + phaseMod + (patterns.some((p) => p.confirmed) ? 10 : 0)));

  const csMtf = 60; // No HTF available in portal — neutral
  const isBreakout = patterns.some((p) => p.confirmed);
  let csVolume = 50;
  if (isBreakout && volumeRatio >= 2) csVolume = 95;
  else if (isBreakout && volumeRatio >= 1.5) csVolume = 80;
  else if (volumeRatio >= 1) csVolume = 60;
  else if (volumeRatio >= 0.5) csVolume = 35;
  else csVolume = 15;

  let csStructure = 50;
  if (structTrend === "uptrend" && bias === "bullish") csStructure = 80;
  else if (structTrend === "downtrend" && bias === "bearish") csStructure = 80;
  else if (structTrend === "uptrend" && bias === "bearish") csStructure = 25;
  else if (structTrend === "downtrend" && bias === "bullish") csStructure = 30;

  let csMomentum = 50;
  if (bias === "bullish" && rsiVal < 30) csMomentum += 20;
  if (bias === "bearish" && rsiVal > 70) csMomentum += 20;
  if (emaAligned) csMomentum += 15;

  // Weighted total
  const csTotal = Math.min(100, Math.max(0,
    csPattern * 0.25 + csPhase * 0.20 + csMtf * 0.15 +
    csVolume * 0.20 + csStructure * 0.10 + csMomentum * 0.10
  ));

  const csLabel = csTotal >= 85 ? "Alta certeza" : csTotal >= 75 ? "Entrada fuerte" :
    csTotal >= 60 ? "Entrada moderada" : csTotal >= 40 ? "Observar" : "Sin setup";

  const csReasons: string[] = [];
  if (csPattern >= 70) csReasons.push(`Patrón fuerte (${csPattern.toFixed(0)})`);
  if (csPhase >= 70) csReasons.push(`Fase alineada (${marketPhase})`);
  if (csVolume >= 80) csReasons.push(`Volumen confirma (${volumeRatio.toFixed(1)}×)`);
  if (csStructure >= 70) csReasons.push(`Estructura ${structTrend}`);
  if (csMomentum >= 70) csReasons.push(`Momentum fuerte`);
  if (csReasons.length === 0) csReasons.push("Contexto insuficiente");

  const contextScore = {
    total: Math.round(csTotal),
    pattern: Math.round(csPattern),
    phase: Math.round(csPhase),
    mtf: Math.round(csMtf),
    volume: Math.round(csVolume),
    structure: Math.round(csStructure),
    momentum: Math.round(csMomentum),
    label: csLabel,
    reasons: csReasons,
  };

  return {
    timestamp: new Date().toISOString(),
    symbol, timeframe, price,
    patterns, levels, fvgs, rejections, volumeProfile,
    ema9, ema21, ema50, ema200, rsi: rsiVal,
    atr: atrVal, atrPct, volumeRatio,
    bias, biasStrength, action, reading, forecast, details, triggerCondition,
    marketPhase, marketPhaseLabel,
    contextScore,
    pivotHighs: triangleResult.pivotHighs,
    pivotLows: triangleResult.pivotLows,
  };
}
