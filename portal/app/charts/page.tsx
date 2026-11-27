"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import CandlestickChart, { Candle, EmaOverlay, Marker, HorizontalLine } from "@/components/CandlestickChart";
import { computeEMA, formatUsd } from "@/lib/utils";
import { detectLevels, detectFVG, detectRejections, computeVolumeProfile, type PriceLevel, type FVGZone, type Rejection, type VolumeProfileBar } from "@/lib/patterns";

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
    const shortTF = ["1m", "5m"];
    if (assetClass === "crypto" && shortTF.includes(timeframe)) {
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

    // Sort markers by time (lightweight-charts lo exige)
    m.sort((a, b) => {
      const ta = typeof a.time === "string" ? new Date(a.time).getTime() : a.time;
      const tb = typeof b.time === "string" ? new Date(b.time).getTime() : b.time;
      return ta - tb;
    });
    return m;
  }, [trades, signals, showTrades, showSignals, showRejections, rejectionCandles]);

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

    // Soportes y resistencias
    for (const lv of priceLevels) {
      lines.push({
        price: lv.price,
        color: lv.kind === "support" ? "#22d3ee" : "#f472b6",
        title: `${lv.kind === "support" ? "S" : "R"} (${lv.touches}t)`,
        lineStyle: 2, // Dashed
      });
    }

    // FVG zones como pares de líneas (top y bottom del gap)
    for (const fvg of fvgZones) {
      const color = fvg.kind === "bullish" ? "#22d3ee40" : "#f472b640";
      lines.push({ price: fvg.top, color, title: `FVG ${fvg.kind === "bullish" ? "↑" : "↓"} top`, lineStyle: 1 });
      lines.push({ price: fvg.bottom, color, title: `FVG bottom`, lineStyle: 1 });
    }

    // Volume Profile POC
    if (showVolProfile) {
      const poc = volProfile.find((b) => b.isPOC);
      if (poc) {
        lines.push({ price: poc.priceLevel, color: "#fbbf24", title: `POC (${poc.pct.toFixed(0)}%)`, lineStyle: 0 });
      }
    }

    return lines;
  }, [positions, showPositionLevels, priceLevels, fvgZones, volProfile, showVolProfile]);

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

          <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500">
            {lastPrice != null && (
              <span>Last: <span className="text-zinc-100 tabular-nums">${lastPrice.toFixed(2)}</span></span>
            )}
            <span className="text-zinc-700">·</span>
            <span>{candles.length} candles</span>
          </div>
        </div>

        {/* Toggles */}
        <div className="flex flex-wrap gap-2 text-[10px]">
          <Toggle label="EMA 20" active={showEMA20} onToggle={() => setShowEMA20(!showEMA20)} color="#60a5fa" />
          <Toggle label="EMA 50" active={showEMA50} onToggle={() => setShowEMA50(!showEMA50)} color="#f59e0b" />
          <Toggle label="EMA 200" active={showEMA200} onToggle={() => setShowEMA200(!showEMA200)} color="#ec4899" />
          <Toggle label="Trades" active={showTrades} onToggle={() => setShowTrades(!showTrades)} color="#84cc16" />
          <Toggle label="Signals" active={showSignals} onToggle={() => setShowSignals(!showSignals)} color="#06b6d4" />
          <Toggle label="Position levels" active={showPositionLevels} onToggle={() => setShowPositionLevels(!showPositionLevels)} color="#a1a1aa" />
          <span className="text-zinc-700">|</span>
          <Toggle label="S/R" active={showSR} onToggle={() => setShowSR(!showSR)} color="#22d3ee" />
          <Toggle label="FVG" active={showFVG} onToggle={() => setShowFVG(!showFVG)} color="#22d3ee" />
          <Toggle label="Rechazo" active={showRejections} onToggle={() => setShowRejections(!showRejections)} color="#f472b6" />
          <Toggle label="Vol Profile" active={showVolProfile} onToggle={() => setShowVolProfile(!showVolProfile)} color="#fbbf24" />
        </div>

        {/* Chart */}
        <div className="border border-zinc-800 bg-zinc-950 p-2">
          {candles.length === 0 ? (
            <div className="h-[480px] flex items-center justify-center text-zinc-600 text-xs">
              Sin datos OHLCV para {symbol} {timeframe}. Corré backfill o esperá al próximo tick del engine.
            </div>
          ) : (
            <CandlestickChart
              candles={candles}
              emas={emas}
              markers={markers}
              horizontalLines={horizontalLines}
              height={520}
            />
          )}
        </div>

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
