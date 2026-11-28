"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import CandlestickChart, { Candle, EmaOverlay, Marker, HorizontalLine, TrendLine, type ChartHandle, type PatternZone } from "@/components/CandlestickChart";
import { computeEMA, formatUsd } from "@/lib/utils";
import { detectLevels, detectFVG, detectRejections, computeVolumeProfile, type PriceLevel, type FVGZone, type Rejection, type VolumeProfileBar } from "@/lib/patterns";
import { analyzeMarket, type AnalysisResult } from "@/lib/analyzer";
import { detectCandlePatterns, detectMarketStructure, type CandlePattern, type StructurePoint, type MarketStructure } from "@/lib/candlePatterns";
import { detectChartPatterns, type ChartPattern } from "@/lib/chartPatterns";
import { Search, TrendingUp, TrendingDown, Minus, Clock, Eye, ShoppingCart, XCircle, Save, ChevronDown, ChevronUp } from "lucide-react";

const UNIVERSE_CRYPTO = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "AVAX/USDT", "LINK/USDT", "DOT/USDT", "MATIC/USDT", "ARB/USDT"];
const UNIVERSE_EQUITIES = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "TSLA", "META", "AMZN"];

interface Trade {
  symbol: string;
  entry_at: string;
  exit_at: string;
  entry_price: number;
  exit_price: number;
  pnl_usd: number;
  exit_reason: string;
}

interface Position {
  symbol: string;
  pool: string;
  entry_price: number;
  stop_price: number;
  target_price: number;
  opened_at: string;
}

interface StrategySignal {
  strategy_name: string;
  symbol: string;
  ts: string;
  action: string;
  entry_price: number;
  stop_price: number;
  target_price: number;
}

export default function ChartsPage() {
  const supabase = createClient();
  const router = useRouter();
  const chartRef = useRef<ChartHandle>(null);
  const [loading, setLoading] = useState(true);
  const [assetClass, setAssetClass] = useState<"crypto" | "equities">("crypto");
  const [symbol, setSymbol] = useState("BTC/USDT");

  // Soporta links tipo /charts?symbol=SOL/USDT (desde histórico, decisiones, scalper)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("symbol");
    if (!q) return;
    if (UNIVERSE_EQUITIES.includes(q)) { setAssetClass("equities"); setSymbol(q); }
    else if (UNIVERSE_CRYPTO.includes(q)) { setAssetClass("crypto"); setSymbol(q); }
  }, []);
  const [timeframe, setTimeframe] = useState("1h");
  const [showEMA20, setShowEMA20] = useState(true);
  const [showEMA50, setShowEMA50] = useState(true);
  const [showEMA200, setShowEMA200] = useState(true);
  const [showTrades, setShowTrades] = useState(true);
  const [showSignals, setShowSignals] = useState(true);
  const [showPositionLevels, setShowPositionLevels] = useState(true);
  const [showSR, setShowSR] = useState(false);
  const [showFVG, setShowFVG] = useState(false);
  const [showRejections, setShowRejections] = useState(false);
  const [showVolProfile, setShowVolProfile] = useState(false);
  const [showCandlePatterns, setShowCandlePatterns] = useState(false);
  const [showStructure, setShowStructure] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [savedAnalyses, setSavedAnalyses] = useState<AnalysisResult[]>([]);
  const [patternOverlay, setPatternOverlay] = useState<ChartPattern[]>([]);
  const [patternOverlayActive, setPatternOverlayActive] = useState(false);

  // Límites por timeframe: 1m→120 (2h), 5m→120 (10h), 15m+→500
  const limitOptions: Record<string, number[]> = {
    "1m": [60, 120, 240],
    "5m": [60, 120, 240],
    "15m": [100, 200, 500],
    "1h": [100, 200, 500],
    "4h": [100, 200, 500],
  };
  const defaultLimits: Record<string, number> = { "1m": 120, "5m": 120, "15m": 200, "1h": 500, "4h": 200 };
  const [limit, setLimit] = useState(defaultLimits[timeframe] || 500);

  const [candles, setCandles] = useState<Candle[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [signals, setSignals] = useState<StrategySignal[]>([]);
  const [lastPrice, setLastPrice] = useState<number | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      setLoading(false);
    });
  }, [router, supabase]);

  // Al cambiar asset class, cambiar el symbol default
  useEffect(() => {
    if (assetClass === "crypto" && !UNIVERSE_CRYPTO.includes(symbol)) {
      setSymbol("BTC/USDT");
    }
    if (assetClass === "equities" && !UNIVERSE_EQUITIES.includes(symbol)) {
      setSymbol("SPY");
    }
  }, [assetClass]);

  // Fetch de velas: 1m/5m directo de Binance API, el resto de Supabase
  async function fetchCandles(): Promise<Candle[]> {
    if (assetClass === "crypto") {
      // Binance public API — no necesita auth
      const binanceSymbol = symbol.replace("/", "");
      const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${timeframe}&limit=${limit}`;
      try {
        const resp = await fetch(url);
        if (!resp.ok) return [];
        const data = await resp.json();
        return (data as any[]).map((k: any) => ({
          time: new Date(k[0]).toISOString(),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
        }));
      } catch {
        return [];
      }
    }
    // DB para 15m, 1h, 4h
    const { data } = await supabase
      .from("ohlcv")
      .select("ts, open, high, low, close, volume")
      .eq("symbol", symbol)
      .eq("timeframe", timeframe)
      .order("ts", { ascending: false })
      .limit(limit);
    if (!data) return [];
    return [...data].reverse().map((r: any) => ({
      time: r.ts,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));
  }

  useEffect(() => {
    if (loading) return;
    async function load() {
      const [candleData, tradesRes, posRes, sigRes] = await Promise.all([
        fetchCandles(),
        supabase.from("trades").select("*").eq("symbol", symbol).order("exit_at", { ascending: false }).limit(100),
        supabase.from("positions").select("*").eq("symbol", symbol),
        supabase.from("strategy_signals").select("*").eq("symbol", symbol).neq("action", "NONE").order("ts", { ascending: false }).limit(50),
      ]);
      setCandles(candleData);
      if (candleData.length > 0) setLastPrice(candleData[candleData.length - 1].close);
      if (tradesRes.data) setTrades(tradesRes.data as Trade[]);
      if (posRes.data) setPositions(posRes.data as Position[]);
      if (sigRes.data) setSignals(sigRes.data as StrategySignal[]);
    }
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [loading, symbol, timeframe, limit, supabase]);

  // EMAs
  const emas: EmaOverlay[] = useMemo(() => {
    if (candles.length === 0) return [];
    const closes = candles.map((c) => c.close);
    const result: EmaOverlay[] = [];
    if (showEMA20) {
      const vals = computeEMA(closes, 20);
      result.push({
        period: 20,
        color: "#60a5fa",
        values: candles.map((c, i) => vals[i] !== null ? { time: c.time, value: vals[i]! } : null).filter(Boolean) as any,
      });
    }
    if (showEMA50) {
      const vals = computeEMA(closes, 50);
      result.push({
        period: 50,
        color: "#f59e0b",
        values: candles.map((c, i) => vals[i] !== null ? { time: c.time, value: vals[i]! } : null).filter(Boolean) as any,
      });
    }
    if (showEMA200) {
      const vals = computeEMA(closes, 200);
      result.push({
        period: 200,
        color: "#ec4899",
        values: candles.map((c, i) => vals[i] !== null ? { time: c.time, value: vals[i]! } : null).filter(Boolean) as any,
      });
    }
    return result;
  }, [candles, showEMA20, showEMA50, showEMA200]);

  // Patrones detectados client-side (deben ir antes de markers que los usa)
  const priceLevels: PriceLevel[] = useMemo(() => {
    if (!showSR || candles.length < 20) return [];
    return detectLevels(candles, 5, 0.005, 2, 8);
  }, [candles, showSR]);

  const fvgZones: FVGZone[] = useMemo(() => {
    if (!showFVG || candles.length < 5) return [];
    return detectFVG(candles, 0.002);
  }, [candles, showFVG]);

  const rejectionCandles: Rejection[] = useMemo(() => {
    if (!showRejections || candles.length < 5 || priceLevels.length === 0) return [];
    return detectRejections(candles, priceLevels, 2.0, 0.005);
  }, [candles, priceLevels, showRejections]);

  const volProfile: VolumeProfileBar[] = useMemo(() => {
    if (!showVolProfile || candles.length < 10) return [];
    return computeVolumeProfile(candles, 24);
  }, [candles, showVolProfile]);

  // Candle patterns — solo los significativos (strength ≥ 2), últimas 15 velas
  const candlePatterns: CandlePattern[] = useMemo(() => {
    if (!showCandlePatterns || candles.length < 10) return [];
    return detectCandlePatterns(candles, 15).filter((p) => p.strength >= 2);
  }, [candles, showCandlePatterns]);

  // Market structure (HH/HL/LH/LL)
  const marketStructure: MarketStructure = useMemo(() => {
    if (!showStructure || candles.length < 20) return { points: [], trend: "ranging" as const, description: "" };
    return detectMarketStructure(candles, 5);
  }, [candles, showStructure]);

  // Chart patterns (Flag, Double Top/Bottom, Wedge, H&S, Rectangle)
  const chartPatternsDetected: ChartPattern[] = useMemo(() => {
    if (candles.length < 25) return [];
    // Run detection when analysis is active or structure is on
    if (!analysis && !showStructure) return [];
    return detectChartPatterns(candles);
  }, [candles, analysis, showStructure]);

  // Trend lines: triangle boundaries + structure channels + chart patterns
  const trendLines: TrendLine[] = useMemo(() => {
    const lines: TrendLine[] = [];

    // Triangle lines from analysis pivots
    if (analysis && analysis.pivotHighs.length >= 2 && analysis.pivotLows.length >= 2) {
      const ph = analysis.pivotHighs.slice(-3);
      const pl = analysis.pivotLows.slice(-3);
      // Upper trendline (connecting highs)
      if (ph.length >= 2) {
        lines.push({
          points: ph.map((p) => ({ time: p.time, value: p.price })),
          color: "#f472b680", // pink = resistance
          lineWidth: 2,
        });
      }
      // Lower trendline (connecting lows)
      if (pl.length >= 2) {
        lines.push({
          points: pl.map((p) => ({ time: p.time, value: p.price })),
          color: "#22d3ee80", // cyan = support
          lineWidth: 2,
        });
      }
    }

    // Price projection (expected path based on analysis)
    if (analysis && candles.length > 5) {
      const lastCandle = candles[candles.length - 1];
      const price = analysis.price;
      const nearSup = analysis.levels.filter((l) => l.kind === "support" && l.price < price).sort((a, b) => b.price - a.price)[0];
      const nearRes = analysis.levels.filter((l) => l.kind === "resistance" && l.price > price).sort((a, b) => a.price - b.price)[0];

      // Calculate time steps for future projection (extend beyond chart)
      const lastTime = typeof lastCandle.time === "string" ? new Date(lastCandle.time).getTime() / 1000 : lastCandle.time;
      const barDuration = candles.length >= 2
        ? ((typeof candles[candles.length - 1].time === "string" ? new Date(candles[candles.length - 1].time).getTime() : (candles[candles.length - 1].time as number) * 1000) -
           (typeof candles[candles.length - 2].time === "string" ? new Date(candles[candles.length - 2].time).getTime() : (candles[candles.length - 2].time as number) * 1000)) / 1000
        : 3600;

      const projPoints: { time: number | string; value: number }[] = [{ time: lastCandle.time, value: price }];

      if (analysis.action === "BUY" || (analysis.action === "WATCH" && analysis.bias === "bullish")) {
        // Bullish projection: dip to support → bounce to target
        const dip = nearSup ? nearSup.price : price * 0.98;
        const target = nearRes ? nearRes.price : price * 1.04;
        projPoints.push({ time: lastTime + barDuration * 3, value: dip });
        projPoints.push({ time: lastTime + barDuration * 8, value: target });
      } else if (analysis.action === "SELL" || (analysis.action === "WATCH" && analysis.bias === "bearish")) {
        // Bearish projection: bounce to resistance → fall to target
        const bounce = nearRes ? nearRes.price : price * 1.02;
        const target = nearSup ? nearSup.price : price * 0.96;
        projPoints.push({ time: lastTime + barDuration * 3, value: bounce });
        projPoints.push({ time: lastTime + barDuration * 8, value: target });
      } else {
        // Lateral: oscillate
        const mid = price;
        const range = analysis.atrPct / 100 * price * 2;
        projPoints.push({ time: lastTime + barDuration * 4, value: mid + range * 0.5 });
        projPoints.push({ time: lastTime + barDuration * 8, value: mid - range * 0.3 });
      }

      lines.push({
        points: projPoints,
        color: analysis.bias === "bullish" ? "#fbbf2480" : analysis.bias === "bearish" ? "#f97316" : "#71717a80",
        lineWidth: 2,
        lineStyle: 1 as any, // Dotted
      });
    }

    // Structure channels from market structure pivots
    if (showStructure && marketStructure.points.length >= 3) {
      const highs = marketStructure.points.filter((p) => p.label === "HH" || p.label === "LH").slice(-3);
      const lows = marketStructure.points.filter((p) => p.label === "HL" || p.label === "LL").slice(-3);
      if (highs.length >= 2) {
        lines.push({
          points: highs.map((p) => ({ time: p.time, value: p.price })),
          color: marketStructure.trend === "uptrend" ? "#10b98160" : "#ef444460",
          lineWidth: 1,
          lineStyle: 2 as any, // Dashed
        });
      }
      if (lows.length >= 2) {
        lines.push({
          points: lows.map((p) => ({ time: p.time, value: p.price })),
          color: marketStructure.trend === "uptrend" ? "#34d39960" : "#f8717160",
          lineWidth: 1,
          lineStyle: 2 as any,
        });
      }
    }

    // Chart pattern lines from analysis (Flag, Double Top, Wedge, H&S, Rectangle)
    for (const cp of chartPatternsDetected) {
      for (const pl of cp.lines) {
        lines.push({
          points: pl.points,
          color: pl.color,
          lineWidth: pl.lineWidth ?? 1,
          lineStyle: pl.style === "dotted" ? 1 as any : pl.style === "dashed" ? 2 as any : 0 as any,
        });
      }
      if (cp.projectionLine) {
        lines.push({
          points: cp.projectionLine.points,
          color: cp.projectionLine.color,
          lineWidth: cp.projectionLine.lineWidth ?? 2,
          lineStyle: 1 as any,
        });
      }
    }

    // Pattern overlay (from "Patrones" button) — high contrast lines
    if (patternOverlayActive) {
      // Colores de alto contraste por tipo de patrón
      const overlayColors: Record<string, string> = {
        "Bull Flag": "#00e676",
        "Bear Flag": "#ff1744",
        "Double Top": "#ff5252",
        "Double Bottom": "#69f0ae",
        "Head & Shoulders": "#ff6e40",
        "Inverse Head & Shoulders": "#00e5ff",
        "Rising Wedge": "#ff9100",
        "Falling Wedge": "#00bfa5",
        "Rectangle Breakout Up": "#76ff03",
        "Rectangle Breakout Down": "#f50057",
        "Rectangle": "#7c4dff",
      };

      for (const cp of patternOverlay) {
        const baseColor = overlayColors[cp.nameEn] ?? (cp.bias === "bullish" ? "#00e676" : "#ff1744");
        // Pattern trendlines — NO titles on axis
        for (const pl of cp.lines) {
          lines.push({
            points: pl.points,
            color: baseColor,
            lineWidth: (pl.lineWidth ?? 1) + 1,
            lineStyle: pl.style === "dotted" ? 1 as any : pl.style === "dashed" ? 2 as any : 0 as any,
          });
        }
        // Projection line
        if (cp.projectionLine) {
          lines.push({
            points: cp.projectionLine.points,
            color: baseColor + "80",
            lineWidth: 2,
            lineStyle: 1 as any,
          });
        }
        // Neckline — extend only within the pattern's time range
        if (cp.neckline && cp.lines.length > 0) {
          const firstPt = cp.lines[0].points[0];
          const lastPt = cp.lines[cp.lines.length - 1].points[cp.lines[cp.lines.length - 1].points.length - 1];
          lines.push({
            points: [
              { time: firstPt.time, value: cp.neckline },
              { time: lastPt.time, value: cp.neckline },
            ],
            color: "#ffd740",
            lineWidth: 1,
            lineStyle: 2 as any,
          });
        }
      }
    }

    return lines;
  }, [analysis, showStructure, marketStructure, chartPatternsDetected, patternOverlayActive, patternOverlay, candles]);

  // Markers: trades (entry + exit) y signals
  const markers: Marker[] = useMemo(() => {
    const m: Marker[] = [];
    if (showTrades) {
      for (const t of trades) {
        m.push({
          time: t.entry_at,
          position: "belowBar",
          color: "#84cc16",
          shape: "arrowUp",
          text: `BUY $${t.entry_price.toFixed(2)}`,
        });
        m.push({
          time: t.exit_at,
          position: "aboveBar",
          color: t.pnl_usd >= 0 ? "#10b981" : "#ef4444",
          shape: "arrowDown",
          text: `${t.exit_reason.toUpperCase()} $${t.exit_price.toFixed(2)} (${t.pnl_usd >= 0 ? "+" : ""}$${t.pnl_usd.toFixed(2)})`,
        });
      }
    }
    if (showSignals) {
      for (const s of signals) {
        if (s.action === "BUY") {
          m.push({
            time: s.ts,
            position: "belowBar",
            color: "#06b6d4",
            shape: "circle",
            text: `SIG ${s.strategy_name}`,
          });
        }
      }
    }
    // Rejection candles
    if (showRejections) {
      for (const r of rejectionCandles) {
        m.push({
          time: r.time,
          position: r.kind === "bullish" ? "belowBar" : "aboveBar",
          color: r.kind === "bullish" ? "#22d3ee" : "#f472b6",
          shape: "circle",
          text: `${r.kind === "bullish" ? "↑" : "↓"} wick ${r.wickRatio.toFixed(1)}×`,
        });
      }
    }

    // Análisis actual — solo marcador de acción, sin listar cada patrón
    if (analysis && candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      const actionColors: Record<string, string> = { BUY: "#10b981", SELL: "#ef4444", WATCH: "#f59e0b", WAIT: "#71717a" };
      const actionShapes: Record<string, "arrowUp" | "arrowDown" | "circle" | "square"> = {
        BUY: "arrowUp", SELL: "arrowDown", WATCH: "circle", WAIT: "square",
      };
      m.push({
        time: lastCandle.time,
        position: analysis.action === "SELL" ? "aboveBar" : "belowBar",
        color: actionColors[analysis.action] || "#71717a",
        shape: actionShapes[analysis.action] || "square",
        text: `${analysis.action} ${analysis.biasStrength}%`,
      });
    }

    // Análisis guardados — marcar sobre el gráfico en sus timestamps
    for (const sa of savedAnalyses) {
      if (sa.symbol !== symbol) continue;
      // Buscar la vela más cercana al timestamp del análisis
      const aTime = new Date(sa.timestamp).getTime();
      let closestCandle = candles[candles.length - 1];
      let closestDist = Infinity;
      for (const c of candles) {
        const cTime = typeof c.time === "string" ? new Date(c.time).getTime() : c.time * 1000;
        const dist = Math.abs(cTime - aTime);
        if (dist < closestDist) { closestDist = dist; closestCandle = c; }
      }
      if (closestCandle && closestDist < 86400000) { // dentro de 24h
        const actionColors: Record<string, string> = { BUY: "#10b981", SELL: "#ef4444", WATCH: "#f59e0b", WAIT: "#52525b" };
        m.push({
          time: closestCandle.time,
          position: "inBar",
          color: actionColors[sa.action] || "#52525b",
          shape: "square",
          text: `${sa.action} ${new Date(sa.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        });
      }
    }

    // Candlestick pattern markers — compactos, solo nombre corto
    if (showCandlePatterns) {
      for (const cp of candlePatterns) {
        const c = candles[cp.idx];
        if (!c) continue;
        // Nombre corto para no saturar
        const shortName = cp.nameEn === "Marubozu" ? "MRB" :
          cp.nameEn === "Hammer" ? "HMR" : cp.nameEn === "Shooting Star" ? "SS" :
          cp.nameEn === "Bullish Engulfing" ? "ENG↑" : cp.nameEn === "Bearish Engulfing" ? "ENG↓" :
          cp.nameEn === "Dark Cloud Cover" ? "DCC" : cp.nameEn === "Harami" ? "HRM" : cp.nameEn.slice(0, 3);
        m.push({
          time: c.time,
          position: cp.bias === "bullish" ? "belowBar" : "aboveBar",
          color: cp.bias === "bullish" ? "#34d399" : "#fb923c",
          shape: cp.strength >= 3 ? "arrowUp" : "circle",
          text: shortName,
        });
      }
    }

    // Market structure labels (HH/HL/LH/LL)
    if (showStructure) {
      const structColors: Record<string, string> = {
        HH: "#10b981", HL: "#34d399",
        LH: "#ef4444", LL: "#f87171",
      };
      for (const sp of marketStructure.points) {
        const c = candles[sp.idx];
        if (!c) continue;
        const isHigh = sp.label === "HH" || sp.label === "LH";
        m.push({
          time: c.time,
          position: isHigh ? "aboveBar" : "belowBar",
          color: structColors[sp.label] || "#a78bfa",
          shape: "square",
          text: sp.label,
        });
      }
    }

    // Pattern overlay: no markers needed — zone labels at the top show pattern names

    // Sort markers by time (lightweight-charts lo exige)
    m.sort((a, b) => {
      const ta = typeof a.time === "string" ? new Date(a.time).getTime() : a.time;
      const tb = typeof b.time === "string" ? new Date(b.time).getTime() : b.time;
      return ta - tb;
    });
    return m;
  }, [trades, signals, showTrades, showSignals, showRejections, rejectionCandles, analysis, savedAnalyses, symbol, candles, showCandlePatterns, candlePatterns, showStructure, marketStructure, patternOverlayActive, patternOverlay]);

  // Pattern zones for the top bar of the chart
  const patternZones: PatternZone[] = useMemo(() => {
    const zones: PatternZone[] = [];

    // Colors per pattern type
    const zoneColors: Record<string, string> = {
      "Double Top": "#ef4444",
      "Double Bottom": "#10b981",
      "Triple Top": "#ef4444",
      "Triple Bottom": "#10b981",
      "Head & Shoulders": "#f97316",
      "Inverse Head & Shoulders": "#06b6d4",
      "Bull Flag": "#22c55e",
      "Bear Flag": "#ef4444",
      "Pennant": "#a855f7",
      "Rising Wedge": "#f59e0b",
      "Falling Wedge": "#14b8a6",
      "Descending Channel": "#ec4899",
      "Ascending Channel": "#8b5cf6",
      "Rectangle": "#6366f1",
      "Rounding Bottom": "#2dd4bf",
      "Diamond": "#f472b6",
      "ABCD": "#fbbf24",
      "Gartley": "#38bdf8",
      "Butterfly": "#c084fc",
    };

    // From pattern overlay (Patrones button)
    if (patternOverlayActive) {
      for (const cp of patternOverlay) {
        if (cp.lines.length === 0) continue;
        // Get time range from the pattern's lines
        const allTimes = cp.lines.flatMap((l) => l.points.map((p) => p.time));
        if (allTimes.length < 2) continue;
        const fromTime = allTimes[0];
        const toTime = allTimes[allTimes.length - 1];
        zones.push({
          name: cp.name,
          color: zoneColors[cp.nameEn] ?? (cp.bias === "bullish" ? "#10b981" : "#ef4444"),
          fromTime,
          toTime,
        });
      }
    }

    // From analysis chart patterns
    for (const cp of chartPatternsDetected) {
      if (cp.lines.length === 0) continue;
      const allTimes = cp.lines.flatMap((l) => l.points.map((p) => p.time));
      if (allTimes.length < 2) continue;
      zones.push({
        name: cp.name,
        color: zoneColors[cp.nameEn] ?? (cp.bias === "bullish" ? "#10b981" : "#ef4444"),
        fromTime: allTimes[0],
        toTime: allTimes[allTimes.length - 1],
      });
    }

    return zones;
  }, [patternOverlayActive, patternOverlay, chartPatternsDetected]);

  // Horizontal lines: posiciones + soportes/resistencias + FVGs + Volume Profile POC
  const horizontalLines: HorizontalLine[] = useMemo(() => {
    const lines: HorizontalLine[] = [];

    if (showPositionLevels) {
      for (const p of positions) {
        lines.push({ price: p.entry_price, color: "#a1a1aa", title: `entry [${p.pool}]` });
        lines.push({ price: p.stop_price, color: "#ef4444", title: "stop" });
        lines.push({ price: p.target_price, color: "#10b981", title: "target" });
      }
    }

    // Soportes y resistencias — solo los 2 más cercanos al precio actual (1 soporte + 1 resistencia)
    if (candles.length > 0) {
      const curPrice = candles[candles.length - 1].close;
      const supports = priceLevels.filter((l) => l.kind === "support").sort((a, b) => b.price - a.price);
      const resistances = priceLevels.filter((l) => l.kind === "resistance").sort((a, b) => a.price - b.price);
      const nearSup = supports.find((s) => s.price < curPrice);
      const nearRes = resistances.find((r) => r.price > curPrice);
      if (nearSup) lines.push({ price: nearSup.price, color: "#22d3ee", title: `S ${nearSup.touches}t`, lineStyle: 2 });
      if (nearRes) lines.push({ price: nearRes.price, color: "#f472b6", title: `R ${nearRes.touches}t`, lineStyle: 2 });
    }

    // FVG: solo el gap más cercano al precio (no todos)
    if (fvgZones.length > 0 && candles.length > 0) {
      const curPrice = candles[candles.length - 1].close;
      const nearest = fvgZones.reduce((best, fvg) => {
        const dist = Math.min(Math.abs(fvg.top - curPrice), Math.abs(fvg.bottom - curPrice));
        const bestDist = Math.min(Math.abs(best.top - curPrice), Math.abs(best.bottom - curPrice));
        return dist < bestDist ? fvg : best;
      });
      const color = nearest.kind === "bullish" ? "#22d3ee40" : "#f472b640";
      lines.push({ price: nearest.top, color, title: `FVG ${nearest.kind === "bullish" ? "↑" : "↓"}`, lineStyle: 1 });
      lines.push({ price: nearest.bottom, color, title: "", lineStyle: 1 });
    }

    // Volume Profile POC
    if (showVolProfile) {
      const poc = volProfile.find((b) => b.isPOC);
      if (poc) {
        lines.push({ price: poc.priceLevel, color: "#fbbf24", title: `POC (${poc.pct.toFixed(0)}%)`, lineStyle: 0 });
      }
    }

    // Líneas del análisis: solo trigger price (sin EMA200 duplicada ni S/R duplicados)
    if (analysis) {
      for (const p of analysis.patterns) {
        if (!p.confirmed && p.confirmationRule) {
          const priceMatch = p.confirmationRule.match(/(\d+[.,]?\d*)/);
          if (priceMatch) {
            const triggerPrice = parseFloat(priceMatch[1].replace(",", ""));
            if (triggerPrice > 0 && Math.abs(triggerPrice - analysis.price) / analysis.price < 0.1) {
              lines.push({ price: triggerPrice, color: "#f59e0b", title: `⚡ trigger`, lineStyle: 1 });
            }
          }
        }
      }
    }

    return lines;
  }, [positions, showPositionLevels, priceLevels, fvgZones, volProfile, showVolProfile, analysis, showStructure, marketStructure]);

  if (loading) return null;

  const options = assetClass === "crypto" ? UNIVERSE_CRYPTO : UNIVERSE_EQUITIES;

  return (
    <Shell current="charts">
      <div className="space-y-4">
        {/* Controles */}
        <div className="border border-zinc-800 bg-zinc-950 p-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            {(["crypto", "equities"] as const).map((cls) => (
              <button key={cls} onClick={() => setAssetClass(cls)}
                className={`text-[10px] uppercase tracking-wider px-2 py-1 border ${assetClass === cls ? "border-lime-500 text-lime-400 bg-lime-950/30" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}>
                {cls}
              </button>
            ))}
          </div>

          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}
            className="bg-black border border-zinc-800 px-2 py-1 text-xs text-zinc-100 focus:border-lime-500 outline-none font-mono">
            {options.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <div className="flex items-center gap-1">
            {(assetClass === "equities" ? ["15m", "1h"] : ["1m", "5m", "15m", "1h", "4h"]).map((tf) => (
              <button key={tf} onClick={() => { setTimeframe(tf); setLimit(defaultLimits[tf] || 500); }}
                className={`text-[10px] uppercase tracking-wider px-2 py-1 border ${timeframe === tf ? "border-lime-500 text-lime-400 bg-lime-950/30" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}>
                {tf}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 ml-2">
            {(limitOptions[timeframe] || [100, 200, 500]).map((n) => (
              <button key={n} onClick={() => setLimit(n)}
                className={`text-[10px] uppercase tracking-wider px-2 py-1 border ${limit === n ? "border-zinc-500 text-zinc-200 bg-zinc-900" : "border-zinc-900 text-zinc-600 hover:text-zinc-300"}`}>
                {n}
              </button>
            ))}
          </div>

          <button onClick={() => {
              if (candles.length < 20) return;
              const result = analyzeMarket(candles, symbol, timeframe);
              setAnalysis(result);
              setAnalysisOpen(true);
              // Prender overlays
              setShowSR(true);
              setShowFVG(true);
              setShowRejections(true);
              setShowCandlePatterns(true);
              setShowStructure(true);
            }}
            disabled={candles.length < 20}
            className="flex items-center gap-1.5 border border-violet-700 bg-violet-950/30 px-3 py-1 text-[10px] uppercase tracking-wider text-violet-300 hover:bg-violet-950/50 hover:border-violet-500 transition-colors disabled:opacity-30">
            <Search className="w-3 h-3" /> Analizar
          </button>

          <button onClick={() => {
              if (candles.length < 20) return;
              if (patternOverlayActive) {
                setPatternOverlay([]);
                setPatternOverlayActive(false);
                setShowCandlePatterns(false);
                setShowStructure(false);
              } else {
                // Detectar patrones solo en las velas VISIBLES en pantalla
                let visibleCandles = candles;
                const range = chartRef.current?.getVisibleRange();
                if (range && range.to - range.from >= 15) {
                  visibleCandles = candles.slice(range.from, range.to + 1);
                }
                const cp = detectChartPatterns(visibleCandles);
                setPatternOverlay(cp);
                setPatternOverlayActive(true);
                setShowCandlePatterns(true);
                setShowStructure(true);
              }
            }}
            disabled={candles.length < 20}
            className={`flex items-center gap-1.5 border px-3 py-1 text-[10px] uppercase tracking-wider transition-colors disabled:opacity-30 ${
              patternOverlayActive
                ? "border-cyan-500 text-cyan-300 bg-cyan-950/40"
                : "border-cyan-800 bg-cyan-950/20 text-cyan-400 hover:bg-cyan-950/40 hover:border-cyan-600"
            }`}>
            <Eye className="w-3 h-3" /> {patternOverlayActive ? "Limpiar" : "Patrones"}
          </button>

          <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500">
            {lastPrice != null && (
              <span>Last: <span className="text-zinc-100 tabular-nums">${lastPrice.toFixed(2)}</span></span>
            )}
            <span className="text-zinc-700">·</span>
            <span>{candles.length} candles</span>
          </div>
        </div>

        {/* Toggles */}
        <div className="flex flex-wrap gap-2 text-[10px] items-center">
          <button onClick={() => {
            const anyOn = showEMA20 || showEMA50 || showEMA200 || showTrades || showSignals || showPositionLevels || showSR || showFVG || showRejections || showVolProfile || showCandlePatterns || showStructure;
            const next = !anyOn;
            setShowEMA20(next); setShowEMA50(next); setShowEMA200(next);
            setShowTrades(next); setShowSignals(next); setShowPositionLevels(next);
            setShowSR(next); setShowFVG(next); setShowRejections(next);
            setShowVolProfile(next); setShowCandlePatterns(next); setShowStructure(next);
          }}
            className="border border-zinc-700 px-2 py-1 text-zinc-500 hover:text-zinc-200 hover:border-zinc-500 uppercase tracking-wider transition-colors">
            {(showEMA20 || showEMA50 || showEMA200 || showTrades || showSignals || showPositionLevels || showSR || showFVG || showRejections || showVolProfile || showCandlePatterns || showStructure) ? "Limpiar" : "Mostrar"}
          </button>
          <span className="text-zinc-800">|</span>
          <Toggle label="EMA 20" active={showEMA20} onToggle={() => setShowEMA20(!showEMA20)} color="#60a5fa" />
          <Toggle label="EMA 50" active={showEMA50} onToggle={() => setShowEMA50(!showEMA50)} color="#f59e0b" />
          <Toggle label="EMA 200" active={showEMA200} onToggle={() => setShowEMA200(!showEMA200)} color="#ec4899" />
          <Toggle label="Trades" active={showTrades} onToggle={() => setShowTrades(!showTrades)} color="#84cc16" />
          <Toggle label="Signals" active={showSignals} onToggle={() => setShowSignals(!showSignals)} color="#06b6d4" />
          <Toggle label="Pos" active={showPositionLevels} onToggle={() => setShowPositionLevels(!showPositionLevels)} color="#a1a1aa" />
          <span className="text-zinc-800">|</span>
          <Toggle label="S/R" active={showSR} onToggle={() => setShowSR(!showSR)} color="#22d3ee" />
          <Toggle label="FVG" active={showFVG} onToggle={() => setShowFVG(!showFVG)} color="#22d3ee" />
          <Toggle label="Rechazo" active={showRejections} onToggle={() => setShowRejections(!showRejections)} color="#f472b6" />
          <Toggle label="Vol" active={showVolProfile} onToggle={() => setShowVolProfile(!showVolProfile)} color="#fbbf24" />
          <span className="text-zinc-800">|</span>
          <Toggle label="Velas" active={showCandlePatterns} onToggle={() => setShowCandlePatterns(!showCandlePatterns)} color="#34d399" />
          <Toggle label="Estructura" active={showStructure} onToggle={() => setShowStructure(!showStructure)} color="#818cf8" />
        </div>

        {/* Chart + Drawer lateral */}
        <div className="flex gap-0">
          {/* Chart */}
          <div className={`border border-zinc-800 bg-zinc-950 p-2 ${analysis && analysisOpen ? "flex-1 min-w-0" : "w-full"}`}>
            {candles.length === 0 ? (
              <div className="h-[480px] flex items-center justify-center text-zinc-600 text-xs">
                Sin datos OHLCV para {symbol} {timeframe}. Corré backfill o esperá al próximo tick del engine.
              </div>
            ) : (
              <CandlestickChart
                ref={chartRef}
                candles={candles}
                emas={emas}
                markers={markers}
                horizontalLines={horizontalLines}
                trendLines={trendLines}
                patternZones={patternZones}
                height={520}
              />
            )}
          </div>

          {/* Drawer de análisis (lateral derecho) — diseño visual compacto */}
          {analysis && analysisOpen && (
            <div className="w-[300px] flex-shrink-0 border border-l-0 border-violet-800/50 bg-zinc-950 overflow-y-auto max-h-[556px] hidden lg:block">
              {/* Header: acción + bias + controles */}
              <div className="px-3 py-2 border-b border-violet-900/30 flex items-center justify-between bg-violet-950/20 sticky top-0 z-10 backdrop-blur">
                <div className="flex items-center gap-2">
                  <span className={`text-base font-bold tracking-tight ${
                    analysis.action === "BUY" ? "text-emerald-400" :
                    analysis.action === "SELL" ? "text-red-400" :
                    analysis.action === "WATCH" ? "text-amber-400" : "text-zinc-500"
                  }`}>{analysis.action}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 ${
                    analysis.bias === "bullish" ? "bg-emerald-950 text-emerald-400" :
                    analysis.bias === "bearish" ? "bg-red-950 text-red-400" : "bg-zinc-900 text-zinc-500"
                  }`}>{analysis.bias === "bullish" ? "▲" : analysis.bias === "bearish" ? "▼" : "—"} {analysis.biasStrength}%</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setSavedAnalyses((prev) => [analysis, ...prev].slice(0, 20))}
                    className="p-1 text-zinc-600 hover:text-violet-300" title="Guardar">
                    <Save className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setAnalysisOpen(false)}
                    className="text-zinc-600 hover:text-zinc-300 text-lg leading-none">×</button>
                </div>
              </div>

              {/* Contextual Score — 6 barras dimensionales */}
              <div className="px-3 py-2 border-b border-zinc-800 space-y-1">
                {/* Score total + label */}
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-[9px] uppercase tracking-wider px-2 py-0.5 font-medium ${
                      analysis.marketPhase === "advance" ? "bg-emerald-950 text-emerald-300" :
                      analysis.marketPhase === "decline" ? "bg-red-950 text-red-300" :
                      analysis.marketPhase === "distribution" ? "bg-amber-950 text-amber-300" :
                      "bg-sky-950 text-sky-300"
                    }`}>{analysis.marketPhase === "advance" ? "▲" :
                      analysis.marketPhase === "decline" ? "▼" :
                      analysis.marketPhase === "distribution" ? "◆" : "◇"} {analysis.marketPhase}</span>
                  </div>
                  <span className={`text-[10px] font-medium ${
                    analysis.contextScore.total >= 75 ? "text-emerald-400" :
                    analysis.contextScore.total >= 60 ? "text-amber-400" :
                    analysis.contextScore.total >= 40 ? "text-zinc-400" : "text-zinc-600"
                  }`}>{analysis.contextScore.label}</span>
                </div>

                {/* 6 mini-barras */}
                {([
                  ["PAT", analysis.contextScore.pattern],
                  ["FASE", analysis.contextScore.phase],
                  ["MTF", analysis.contextScore.mtf],
                  ["VOL", analysis.contextScore.volume],
                  ["ESTR", analysis.contextScore.structure],
                  ["MOM", analysis.contextScore.momentum],
                ] as [string, number][]).map(([label, val]) => (
                  <div key={label} className="flex items-center gap-1.5">
                    <span className="text-[8px] uppercase tracking-wider text-zinc-600 w-7">{label}</span>
                    <div className="flex-1 h-1.5 bg-zinc-900 overflow-hidden">
                      <div className={`h-full ${val >= 70 ? "bg-emerald-500" : val >= 50 ? "bg-amber-500" : val >= 30 ? "bg-orange-500" : "bg-red-500"}`}
                        style={{ width: `${val}%` }} />
                    </div>
                    <span className="text-[8px] tabular-nums text-zinc-500 w-5 text-right">{val}</span>
                  </div>
                ))}

                {/* Reasons */}
                {analysis.contextScore.reasons.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {analysis.contextScore.reasons.map((r, i) => (
                      <span key={i} className="text-[8px] text-zinc-500 bg-zinc-900 px-1.5 py-0.5">{r}</span>
                    ))}
                  </div>
                )}
              </div>

              {/* Forecast — conciso */}
              <div className="px-3 py-2 border-b border-zinc-800">
                <div className={`text-[11px] leading-relaxed ${
                  analysis.action === "BUY" ? "text-emerald-300" :
                  analysis.action === "SELL" ? "text-red-300" :
                  analysis.action === "WATCH" ? "text-amber-200" : "text-zinc-500"
                }`}>{analysis.forecast}</div>
              </div>

              {/* Indicadores como barras visuales */}
              <div className="px-3 py-2 space-y-1.5">
                {/* RSI gauge */}
                <div className="flex items-center gap-2">
                  <span className="text-[9px] uppercase tracking-wider text-zinc-600 w-8">RSI</span>
                  <div className="flex-1 h-2 bg-zinc-900 relative overflow-hidden">
                    <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-600 via-zinc-600 to-red-600 w-full opacity-30" />
                    <div className="absolute top-0 bottom-0 w-1 bg-white" style={{ left: `${Math.min(100, analysis.rsi)}%` }} />
                    {/* Zonas extremas */}
                    <div className="absolute inset-y-0 left-0 w-[30%] border-r border-emerald-500/30" />
                    <div className="absolute inset-y-0 right-0 w-[30%] border-l border-red-500/30" />
                  </div>
                  <span className={`text-[11px] tabular-nums font-medium w-8 text-right ${
                    analysis.rsi < 30 ? "text-emerald-400" : analysis.rsi > 70 ? "text-red-400" : "text-zinc-400"
                  }`}>{analysis.rsi.toFixed(0)}</span>
                </div>

                {/* Volume bar */}
                <div className="flex items-center gap-2">
                  <span className="text-[9px] uppercase tracking-wider text-zinc-600 w-8">VOL</span>
                  <div className="flex-1 h-2 bg-zinc-900 overflow-hidden">
                    <div className={`h-full transition-all ${
                      analysis.volumeRatio > 1.5 ? "bg-emerald-500" : analysis.volumeRatio < 0.5 ? "bg-red-500" : "bg-zinc-600"
                    }`} style={{ width: `${Math.min(100, analysis.volumeRatio * 40)}%` }} />
                  </div>
                  <span className={`text-[11px] tabular-nums font-medium w-8 text-right ${
                    analysis.volumeRatio > 1.5 ? "text-emerald-400" : analysis.volumeRatio < 0.5 ? "text-red-400" : "text-zinc-400"
                  }`}>{analysis.volumeRatio.toFixed(1)}×</span>
                </div>

                {/* ATR bar */}
                <div className="flex items-center gap-2">
                  <span className="text-[9px] uppercase tracking-wider text-zinc-600 w-8">ATR</span>
                  <div className="flex-1 h-2 bg-zinc-900 overflow-hidden">
                    <div className="h-full bg-violet-600/60" style={{ width: `${Math.min(100, analysis.atrPct * 20)}%` }} />
                  </div>
                  <span className="text-[11px] tabular-nums font-medium w-8 text-right text-zinc-400">{analysis.atrPct.toFixed(2)}%</span>
                </div>

                {/* Trend: EMAs como semáforo */}
                <div className="flex items-center gap-2">
                  <span className="text-[9px] uppercase tracking-wider text-zinc-600 w-8">EMA</span>
                  <div className="flex gap-1 flex-1">
                    {/* 9>21 */}
                    <div className={`h-2 flex-1 ${analysis.ema9 > analysis.ema21 ? "bg-emerald-500" : "bg-red-500"}`} title={`9/21 ${analysis.ema9 > analysis.ema21 ? "↑" : "↓"}`} />
                    {/* Price vs EMA200 */}
                    <div className={`h-2 flex-1 ${analysis.price > analysis.ema200 ? "bg-emerald-500" : "bg-red-500"}`} title={`vs EMA200 ${analysis.price > analysis.ema200 ? "↑" : "↓"}`} />
                  </div>
                  <span className={`text-[11px] font-medium w-8 text-right ${
                    analysis.ema9 > analysis.ema21 && analysis.price > analysis.ema200 ? "text-emerald-400" :
                    analysis.ema9 < analysis.ema21 && analysis.price < analysis.ema200 ? "text-red-400" : "text-amber-400"
                  }`}>{analysis.ema9 > analysis.ema21 ? "↑" : "↓"}</span>
                </div>
              </div>

              {/* Patrones como chips compactos */}
              {analysis.patterns.length > 0 && (
                <div className="px-3 py-2 border-t border-zinc-900">
                  <div className="flex flex-wrap gap-1">
                    {analysis.patterns.map((p, i) => (
                      <span key={i} className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 ${
                        p.confirmed
                          ? p.bias === "bullish" ? "bg-emerald-950/40 text-emerald-300 border border-emerald-800/50"
                          : p.bias === "bearish" ? "bg-red-950/40 text-red-300 border border-red-800/50"
                          : "bg-zinc-900 text-zinc-400 border border-zinc-800"
                          : "bg-zinc-900/50 text-zinc-500 border border-zinc-800/50 border-dashed"
                      }`} title={p.description}>
                        <span className={`w-1.5 h-1.5 rounded-full ${p.confirmed ? "bg-current" : "bg-zinc-600"}`} />
                        {p.name}
                        <span className="text-[8px] opacity-60">{p.strength}%</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Chart patterns (Flag, H&S, etc.) con niveles */}
              {chartPatternsDetected.length > 0 && (
                <div className="px-3 py-2 border-t border-indigo-900/30">
                  {chartPatternsDetected.slice(0, 2).map((cp, i) => (
                    <div key={i} className={`mb-1.5 last:mb-0 border px-2 py-1.5 ${
                      cp.bias === "bullish" ? "border-emerald-900/50 bg-emerald-950/10" : "border-red-900/50 bg-red-950/10"
                    }`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] font-medium text-zinc-200">{cp.name}</span>
                        <span className={`text-[9px] px-1.5 py-0.5 ${
                          cp.status === "confirmed" ? "bg-lime-900/40 text-lime-300" :
                          cp.status === "projected" ? "bg-violet-900/40 text-violet-300" :
                          "bg-zinc-800 text-zinc-500"
                        }`}>{cp.status === "confirmed" ? "✓" : "○"} {cp.confidence}%</span>
                      </div>
                      {/* Niveles inline */}
                      <div className="flex gap-3 text-[10px] tabular-nums">
                        {cp.entry != null && <span className="text-zinc-400">Entry <span className="text-zinc-200">${cp.entry.toFixed(0)}</span></span>}
                        {cp.stop != null && <span className="text-zinc-400">Stop <span className="text-red-400">${cp.stop.toFixed(0)}</span></span>}
                        {cp.target != null && <span className="text-zinc-400">Target <span className="text-emerald-400">${cp.target.toFixed(0)}</span></span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Trigger — automático */}
              {analysis.triggerCondition && (
                <div className="px-3 py-1.5 border-t border-amber-900/30 bg-amber-950/5 flex items-center gap-2">
                  <Eye className="w-3 h-3 text-amber-400 flex-shrink-0" />
                  <span className="text-[10px] text-amber-200/80 flex-1">{analysis.triggerCondition}</span>
                  <span className="text-[8px] uppercase tracking-wider text-zinc-600 flex-shrink-0">auto</span>
                </div>
              )}

              {/* Footer */}
              <div className="px-3 py-1.5 border-t border-zinc-900 flex items-center justify-between text-[9px] text-zinc-600 tabular-nums">
                <span>{analysis.reading}</span>
                <span>{new Date(analysis.timestamp).toLocaleTimeString()}</span>
              </div>
            </div>
          )}
        </div>

        {/* Pattern overlay summary */}
        {patternOverlayActive && patternOverlay.length > 0 && (
          <div className="border border-cyan-800/50 bg-cyan-950/10 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wider text-cyan-400">
                Patrones detectados · {patternOverlay.length}
              </span>
              <button onClick={() => { setPatternOverlay([]); setPatternOverlayActive(false); }}
                className="text-[9px] text-zinc-600 hover:text-zinc-300 uppercase">limpiar</button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {patternOverlay.map((cp, i) => (
                <div key={i} className={`border px-3 py-2 ${
                  cp.bias === "bullish" ? "border-emerald-900/50 bg-emerald-950/10" : "border-red-900/50 bg-red-950/10"
                }`}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-[12px] font-medium ${cp.bias === "bullish" ? "text-emerald-300" : "text-red-300"}`}>
                        {cp.bias === "bullish" ? "▲" : "▼"} {cp.name}
                      </span>
                    </div>
                    <span className={`text-[9px] px-1.5 py-0.5 ${
                      cp.status === "confirmed" ? "bg-lime-900/50 text-lime-300" :
                      "bg-zinc-800 text-zinc-500"
                    }`}>{cp.status === "confirmed" ? "✓ Confirmado" : "En formación"} · {cp.confidence}%</span>
                  </div>
                  <div className="text-[10px] text-zinc-400 mb-1.5">{cp.description}</div>
                  <div className="flex gap-4 text-[10px] tabular-nums">
                    {cp.entry != null && (
                      <span className="text-zinc-500">Entry <span className="text-white">${cp.entry.toFixed(2)}</span></span>
                    )}
                    {cp.stop != null && (
                      <span className="text-zinc-500">Stop <span className="text-red-400">${cp.stop.toFixed(2)}</span></span>
                    )}
                    {cp.target != null && (
                      <span className="text-zinc-500">Target <span className="text-emerald-400">${cp.target.toFixed(2)}</span></span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {patternOverlay.length === 0 && (
              <div className="text-[11px] text-zinc-600 text-center py-2">
                No se detectaron patrones chartistas en las últimas {candles.length} velas.
              </div>
            )}
          </div>
        )}

        {patternOverlayActive && patternOverlay.length === 0 && (
          <div className="border border-zinc-800 bg-zinc-950 p-4 text-center text-[11px] text-zinc-500">
            No se detectaron patrones chartistas (doble techo/piso, H&S, banderas, cuñas, rectángulo) en las últimas {candles.length} velas.
          </div>
        )}

        {/* Panel mobile: compacto visual */}
        {analysis && analysisOpen && (
          <div className="lg:hidden border border-violet-800/50 bg-zinc-950 overflow-hidden">
            <div className="px-3 py-2 flex items-center justify-between bg-violet-950/20">
              <div className="flex items-center gap-2">
                <span className={`text-sm font-bold ${
                  analysis.action === "BUY" ? "text-emerald-400" : analysis.action === "SELL" ? "text-red-400" :
                  analysis.action === "WATCH" ? "text-amber-400" : "text-zinc-500"
                }`}>{analysis.action}</span>
                <span className={`text-[10px] px-1.5 py-0.5 ${
                  analysis.bias === "bullish" ? "bg-emerald-950 text-emerald-400" :
                  analysis.bias === "bearish" ? "bg-red-950 text-red-400" : "bg-zinc-900 text-zinc-500"
                }`}>{analysis.biasStrength}%</span>
                <span className={`text-[10px] tabular-nums ${analysis.rsi < 30 ? "text-emerald-400" : analysis.rsi > 70 ? "text-red-400" : "text-zinc-500"}`}>RSI {analysis.rsi.toFixed(0)}</span>
                <span className={`text-[10px] tabular-nums ${analysis.volumeRatio > 1.5 ? "text-emerald-400" : "text-zinc-500"}`}>Vol {analysis.volumeRatio.toFixed(1)}×</span>
              </div>
              <button onClick={() => setAnalysisOpen(false)} className="text-zinc-600 text-lg leading-none">×</button>
            </div>
            {analysis.patterns.length > 0 && (
              <div className="px-3 py-1.5 flex flex-wrap gap-1 border-t border-zinc-900">
                {analysis.patterns.map((p, i) => (
                  <span key={i} className={`text-[9px] px-1.5 py-0.5 ${p.confirmed
                    ? p.bias === "bullish" ? "bg-emerald-950/40 text-emerald-300" : "bg-red-950/40 text-red-300"
                    : "bg-zinc-900 text-zinc-500 border border-dashed border-zinc-800"}`}>
                    {p.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Historial de análisis guardados */}
        {savedAnalyses.length > 0 && (
          <details className="border border-zinc-800 bg-zinc-950">
            <summary className="px-3 py-2 text-[10px] uppercase tracking-wider text-zinc-500 cursor-pointer hover:text-zinc-300">
              Análisis guardados ({savedAnalyses.length})
            </summary>
            <div className="border-t border-zinc-900 divide-y divide-zinc-900">
              {savedAnalyses.map((a, i) => (
                <div key={i} className="px-3 py-2 flex items-center justify-between text-[11px] hover:bg-zinc-900/50 cursor-pointer"
                  onClick={() => { setAnalysis(a); setAnalysisOpen(true); setSymbol(a.symbol); setTimeframe(a.timeframe); }}>
                  <div className="flex items-center gap-3">
                    <span className={`font-medium ${
                      a.action === "BUY" ? "text-emerald-400" : a.action === "SELL" ? "text-red-400" :
                      a.action === "WATCH" ? "text-amber-400" : "text-zinc-400"
                    }`}>{a.action}</span>
                    <span className="text-zinc-300">{a.symbol}</span>
                    <span className="text-zinc-600">{a.timeframe}</span>
                    <span className="text-zinc-500">{a.patterns.length} patrones</span>
                  </div>
                  <span className="text-zinc-600 tabular-nums">{new Date(a.timestamp).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        {/* Volume Profile panel */}
        {showVolProfile && volProfile.length > 0 && (
          <div className="border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Volume Profile</div>
            <div className="flex items-end gap-px h-20">
              {volProfile.map((bar, i) => {
                const maxPct = Math.max(...volProfile.map((b) => b.pct));
                const h = maxPct > 0 ? (bar.pct / maxPct) * 100 : 0;
                return (
                  <div key={i} className="flex-1 flex flex-col items-center justify-end" title={`$${bar.priceLevel.toFixed(2)} · ${bar.pct.toFixed(1)}%`}>
                    <div
                      className={`w-full ${bar.isPOC ? "bg-amber-400" : "bg-zinc-600"}`}
                      style={{ height: `${h}%`, minHeight: bar.pct > 0 ? "1px" : 0 }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[9px] text-zinc-600 mt-1">
              <span>${volProfile[0]?.priceLevel.toFixed(2)}</span>
              <span className="text-amber-400">POC ${volProfile.find((b) => b.isPOC)?.priceLevel.toFixed(2)}</span>
              <span>${volProfile[volProfile.length - 1]?.priceLevel.toFixed(2)}</span>
            </div>
          </div>
        )}

        {/* Info extras */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <InfoBox title="Posición activa">
            {positions.length === 0 ? (
              <div className="text-zinc-600 text-xs">Sin posición en {symbol}</div>
            ) : (
              positions.map((p) => (
                <div key={p.pool} className="text-xs text-zinc-300">
                  <span className="text-zinc-500">[{p.pool}]</span> entry ${p.entry_price.toFixed(2)} ·{" "}
                  <span className="text-red-400">stop ${p.stop_price.toFixed(2)}</span> ·{" "}
                  <span className="text-emerald-400">target ${p.target_price.toFixed(2)}</span>
                </div>
              ))
            )}
          </InfoBox>

          <InfoBox title={`Últimos trades (${trades.length})`}>
            {trades.length === 0 ? (
              <div className="text-zinc-600 text-xs">Sin trades cerrados</div>
            ) : (
              <div className="space-y-1">
                {trades.slice(0, 3).map((t, i) => (
                  <div key={i} className="text-[11px] flex justify-between">
                    <span className="text-zinc-400">{t.exit_reason}</span>
                    <span className={t.pnl_usd >= 0 ? "text-emerald-400" : "text-red-400"}>
                      {formatUsd(t.pnl_usd)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </InfoBox>

          <InfoBox title={`Señales recientes (${signals.length})`}>
            {signals.length === 0 ? (
              <div className="text-zinc-600 text-xs">Sin señales</div>
            ) : (
              <div className="space-y-1">
                {signals.slice(0, 3).map((s, i) => (
                  <div key={i} className="text-[11px] flex justify-between">
                    <span className="text-zinc-400">{s.strategy_name}</span>
                    <span className="text-zinc-300">${s.entry_price?.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </InfoBox>
        </div>
      </div>
    </Shell>
  );
}

function Toggle({ label, active, onToggle, color }: { label: string; active: boolean; onToggle: () => void; color: string }) {
  return (
    <button onClick={onToggle}
      className={`flex items-center gap-1.5 border px-2 py-1 uppercase tracking-wider transition-colors ${
        active ? "border-zinc-700 text-zinc-200 bg-zinc-900" : "border-zinc-900 text-zinc-600 hover:text-zinc-300"
      }`}>
      <span className="w-2 h-2" style={{ background: active ? color : "#52525b" }} />
      {label}
    </button>
  );
}

function InfoBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-zinc-800 bg-zinc-950 p-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">{title}</div>
      {children}
    </div>
  );
}
