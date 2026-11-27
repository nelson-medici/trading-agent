"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import { formatUsd, formatPct } from "@/lib/utils";
import { Play, Clock, CheckCircle2, XCircle, TrendingUp, TrendingDown, Heart, HeartCrack, AlertCircle } from "lucide-react";

interface StrategyConfig {
  key: string;
  value: {
    [strategyName: string]: {
      enabled: boolean;
      pools: string[];
      min_confidence: number;
      params: Record<string, any>;
    };
  };
}

interface Signal {
  id: string;
  strategy_name: string;
  symbol: string;
  pool: string;
  ts: string;
  action: string;
  confidence: number;
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  reasoning: string | null;
  metadata: any;
}

interface BacktestResult {
  id: string;
  strategy_name: string;
  symbol: string;
  timeframe: string;
  start_date: string;
  end_date: string;
  initial_capital: number;
  final_capital: number;
  total_return_pct: number;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  profit_factor: number;
  sharpe_ratio: number;
  max_drawdown_pct: number;
  avg_win_usd: number;
  avg_loss_usd: number;
  avg_hold_hours: number;
  params: any;
  run_at: string;
}

interface BacktestJob {
  id: string;
  strategy_name: string;
  symbol: string;
  timeframe: string;
  initial_capital: number;
  risk_per_trade_pct: number;
  status: string;
  error_message: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const KNOWN_STRATEGIES = ["orb_intraday", "orb_intraday_equities", "ema_golden_pullback", "donchian_breakout"];
const UNIVERSE = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "AVAX/USDT", "LINK/USDT", "DOT/USDT", "MATIC/USDT", "ARB/USDT"];

export default function StrategiesPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [strategies, setStrategies] = useState<any>({});
  const [signals, setSignals] = useState<Signal[]>([]);
  const [results, setResults] = useState<BacktestResult[]>([]);
  const [jobs, setJobs] = useState<BacktestJob[]>([]);
  const [performance, setPerformance] = useState<any[]>([]);

  // Form state
  const [btStrategy, setBtStrategy] = useState("orb_intraday");
  const [btSymbol, setBtSymbol] = useState("BTC/USDT");
  const [btTimeframe, setBtTimeframe] = useState("1h");
  const [btCapital, setBtCapital] = useState("10000");
  const [btRisk, setBtRisk] = useState("1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      setLoading(false);
    });
  }, [router, supabase]);

  async function load() {
    const [cfgRes, sigRes, resRes, jobRes, perfRes] = await Promise.all([
      supabase.from("config").select("value").eq("key", "strategies.enabled").single(),
      supabase.from("strategy_signals").select("*").order("ts", { ascending: false }).limit(500),
      supabase.from("backtest_results").select("*").order("run_at", { ascending: false }).limit(50),
      supabase.from("backtest_jobs").select("*").order("requested_at", { ascending: false }).limit(10),
      supabase.from("v_strategy_performance").select("*"),
    ]);
    if (cfgRes.data?.value) setStrategies(cfgRes.data.value);
    if (sigRes.data) setSignals(sigRes.data as Signal[]);
    if (resRes.data) setResults(resRes.data as BacktestResult[]);
    if (jobRes.data) setJobs(jobRes.data as BacktestJob[]);
    if (perfRes.data) setPerformance(perfRes.data);
  }

  useEffect(() => {
    if (loading) return;
    load();
    const iv = setInterval(load, 10000);  // más frecuente para ver jobs completarse
    return () => clearInterval(iv);
  }, [loading]);

  if (loading) return null;

  async function runBacktest() {
    const capital = parseFloat(btCapital);
    const risk = parseFloat(btRisk) / 100;
    if (!capital || capital <= 0 || !risk || risk <= 0) {
      setMsg("Capital o risk inválido");
      return;
    }
    setBusy(true);
    const { error } = await supabase.from("backtest_jobs").insert({
      strategy_name: btStrategy,
      symbol: btSymbol,
      timeframe: btTimeframe,
      initial_capital: capital,
      risk_per_trade_pct: risk,
    });
    setBusy(false);
    if (error) { setMsg(`Error: ${error.message}`); return; }
    setMsg("Backtest encolado. El engine lo ejecuta en <1 min.");
    await load();
    setTimeout(() => setMsg(""), 5000);
  }

  return (
    <Shell current="strategies">
      <div className="space-y-6">
        {/* Strategies habilitadas */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Strategies habilitadas</h2>
          {Object.keys(strategies).length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin strategies configuradas.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {Object.entries(strategies).map(([name, cfg]: any) => (
                <div key={name} className="border border-zinc-800 bg-zinc-950 p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="text-sm text-zinc-100 font-medium">{name}</div>
                      <div className="text-[10px] text-zinc-500 mt-0.5">
                        pools: {(cfg.pools || []).join(", ")} · min_conf: {cfg.min_confidence}
                      </div>
                    </div>
                    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 border ${cfg.enabled ? "border-lime-700 text-lime-400 bg-lime-950/30" : "border-zinc-700 text-zinc-500"}`}>
                      {cfg.enabled ? "ON" : "OFF"}
                    </span>
                  </div>
                  <details className="text-[11px] text-zinc-500 mt-2">
                    <summary className="cursor-pointer hover:text-zinc-300">Parámetros</summary>
                    <pre className="mt-2 bg-black border border-zinc-900 p-2 text-[10px] overflow-x-auto">{JSON.stringify(cfg.params || {}, null, 2)}</pre>
                  </details>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Formulario backtest */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Correr backtest</h2>
          <div className="border border-zinc-800 bg-zinc-950 p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Strategy</label>
                <select value={btStrategy} onChange={(e) => setBtStrategy(e.target.value)}
                  className="w-full bg-black border border-zinc-800 px-2 py-1.5 text-xs text-zinc-100 focus:border-lime-500 outline-none font-mono">
                  {KNOWN_STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Symbol</label>
                <select value={btSymbol} onChange={(e) => setBtSymbol(e.target.value)}
                  className="w-full bg-black border border-zinc-800 px-2 py-1.5 text-xs text-zinc-100 focus:border-lime-500 outline-none font-mono">
                  {UNIVERSE.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Timeframe</label>
                <select value={btTimeframe} onChange={(e) => setBtTimeframe(e.target.value)}
                  className="w-full bg-black border border-zinc-800 px-2 py-1.5 text-xs text-zinc-100 focus:border-lime-500 outline-none font-mono">
                  <option value="15m">15m</option>
                  <option value="1h">1h</option>
                  <option value="4h">4h</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Capital USD</label>
                <input type="number" value={btCapital} onChange={(e) => setBtCapital(e.target.value)}
                  className="w-full bg-black border border-zinc-800 px-2 py-1.5 text-xs text-zinc-100 focus:border-lime-500 outline-none font-mono" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Risk % / trade</label>
                <input type="number" step="0.1" value={btRisk} onChange={(e) => setBtRisk(e.target.value)}
                  className="w-full bg-black border border-zinc-800 px-2 py-1.5 text-xs text-zinc-100 focus:border-lime-500 outline-none font-mono" />
              </div>
            </div>
            <button onClick={runBacktest} disabled={busy}
              className="border border-lime-700 hover:border-lime-500 text-lime-300 hover:bg-lime-950/50 px-4 py-2 text-xs uppercase tracking-wider disabled:opacity-50 flex items-center gap-2">
              <Play className="w-3 h-3" /> Correr backtest
            </button>
            {msg && <div className={`text-xs ${msg.startsWith("Error") ? "text-red-400" : "text-lime-300"}`}>{msg}</div>}
          </div>
        </section>

        {/* Cola de jobs */}
        {jobs.length > 0 && (
          <section>
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Jobs recientes</h2>
            <div className="space-y-1">
              {jobs.map((j) => {
                const icon = j.status === "done" ? CheckCircle2 : j.status === "failed" ? XCircle : Clock;
                const Icon = icon;
                const color = j.status === "done" ? "text-lime-400" : j.status === "failed" ? "text-red-400" : "text-amber-400";
                return (
                  <div key={j.id} className="border border-zinc-900 bg-zinc-950 p-2 text-[11px] flex items-center gap-3">
                    <Icon className={`w-3.5 h-3.5 ${color}`} />
                    <span className="text-zinc-300">{j.strategy_name}</span>
                    <span className="text-zinc-500">{j.symbol} {j.timeframe}</span>
                    <span className={`${color} uppercase text-[10px]`}>{j.status}</span>
                    {j.error_message && <span className="text-red-400 text-[10px] truncate">{j.error_message}</span>}
                    <span className="ml-auto text-zinc-600 text-[10px]">{new Date(j.requested_at).toLocaleTimeString()}</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Ranking de performance en vivo */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Performance en vivo (30 días)</h2>
          {performance.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin trades cerrados aún por strategy. Se completa cuando el engine cierre trades.</div>
          ) : (
            <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="text-left px-3 py-2">#</th>
                    <th className="text-left px-3 py-2">Strategy</th>
                    <th className="text-right px-3 py-2">Trades</th>
                    <th className="text-right px-3 py-2">Win%</th>
                    <th className="text-right px-3 py-2">PF</th>
                    <th className="text-right px-3 py-2">Sharpe-like</th>
                    <th className="text-right px-3 py-2">PnL total</th>
                    <th className="text-right px-3 py-2">Avg Win</th>
                    <th className="text-right px-3 py-2">Avg Loss</th>
                    <th className="text-right px-3 py-2">Avg Hold</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.map((p: any, i: number) => (
                    <tr key={p.strategy_name} className="border-b border-zinc-900">
                      <td className="px-3 py-2 text-zinc-500">{i + 1}</td>
                      <td className="px-3 py-2 text-zinc-100 font-medium">{p.strategy_name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{p.total_trades}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${p.win_rate >= 0.5 ? "text-emerald-400" : "text-amber-400"}`}>{(p.win_rate * 100).toFixed(1)}%</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${p.profit_factor >= 1.5 ? "text-emerald-400" : p.profit_factor >= 1 ? "text-amber-400" : "text-red-400"}`}>{Number(p.profit_factor).toFixed(2)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${p.sharpe_like >= 1 ? "text-emerald-400" : p.sharpe_like >= 0.5 ? "text-amber-400" : "text-red-400"}`}>{Number(p.sharpe_like).toFixed(2)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${Number(p.total_pnl_usd) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatUsd(Number(p.total_pnl_usd))}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-400">{formatUsd(Number(p.avg_win_usd))}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-400">{formatUsd(Number(p.avg_loss_usd))}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{Number(p.avg_hold_hours).toFixed(1)}h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Resultados de backtests */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Resultados backtests ({results.length})</h2>
          {results.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin backtests corridos.</div>
          ) : (
            <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="text-left px-3 py-2">Strategy</th>
                    <th className="text-left px-3 py-2">Symbol</th>
                    <th className="text-left px-3 py-2">TF</th>
                    <th className="text-right px-3 py-2">Trades</th>
                    <th className="text-right px-3 py-2">Win%</th>
                    <th className="text-right px-3 py-2">PF</th>
                    <th className="text-right px-3 py-2">Sharpe</th>
                    <th className="text-right px-3 py-2">Max DD</th>
                    <th className="text-right px-3 py-2">Return</th>
                    <th className="text-right px-3 py-2">Capital Final</th>
                    <th className="text-right px-3 py-2">Run</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.id} className="border-b border-zinc-900">
                      <td className="px-3 py-2 text-zinc-100">{r.strategy_name}</td>
                      <td className="px-3 py-2 text-zinc-300">{r.symbol}</td>
                      <td className="px-3 py-2 text-zinc-500">{r.timeframe}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.total_trades}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${r.win_rate >= 0.5 ? "text-emerald-400" : "text-amber-400"}`}>{(r.win_rate * 100).toFixed(1)}%</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${r.profit_factor >= 1.5 ? "text-emerald-400" : r.profit_factor >= 1 ? "text-amber-400" : "text-red-400"}`}>{r.profit_factor.toFixed(2)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${r.sharpe_ratio >= 1 ? "text-emerald-400" : r.sharpe_ratio >= 0.5 ? "text-amber-400" : "text-red-400"}`}>{r.sharpe_ratio.toFixed(2)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${r.max_drawdown_pct <= 0.15 ? "text-emerald-400" : r.max_drawdown_pct <= 0.25 ? "text-amber-400" : "text-red-400"}`}>{(r.max_drawdown_pct * 100).toFixed(2)}%</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${r.total_return_pct >= 0 ? "text-emerald-400" : "text-red-400"}`}>{(r.total_return_pct * 100).toFixed(2)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatUsd(r.final_capital)}</td>
                      <td className="px-3 py-2 text-right text-zinc-500 text-[10px]">{new Date(r.run_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Health por estrategia + feed filtrado */}
        <SignalsSection signals={signals} />
      </div>
    </Shell>
  );
}

// ================================================================
// Sección de señales: health + feed filtrado
// ================================================================
function SignalsSection({ signals }: { signals: Signal[] }) {
  const [actionFilter, setActionFilter] = useState<"active" | "all" | "none">("active");
  const [stratFilter, setStratFilter] = useState<string>("all");

  // Health agregado por estrategia
  const health = useMemo(() => {
    const nowMs = Date.now();
    const H24 = 24 * 3600_000;
    const H7D = 7 * H24;
    const map = new Map<string, {
      strategy: string;
      pools: Set<string>;
      lastEvalMs: number;
      buy24: number;
      buy7d: number;
      none24: number;
      noneReasons: Map<string, number>;
      lastBuyMs: number | null;
    }>();

    for (const s of signals) {
      const tsMs = new Date(s.ts).getTime();
      const existing = map.get(s.strategy_name) || {
        strategy: s.strategy_name,
        pools: new Set<string>(),
        lastEvalMs: 0,
        buy24: 0, buy7d: 0, none24: 0,
        noneReasons: new Map<string, number>(),
        lastBuyMs: null,
      };
      existing.pools.add(s.pool);
      if (tsMs > existing.lastEvalMs) existing.lastEvalMs = tsMs;

      if (s.action === "BUY") {
        if (nowMs - tsMs <= H24) existing.buy24++;
        if (nowMs - tsMs <= H7D) existing.buy7d++;
        if (!existing.lastBuyMs || tsMs > existing.lastBuyMs) existing.lastBuyMs = tsMs;
      }
      if (s.action === "NONE") {
        if (nowMs - tsMs <= H24) {
          existing.none24++;
          const reason = s.reasoning || "sin razón";
          existing.noneReasons.set(reason, (existing.noneReasons.get(reason) || 0) + 1);
        }
      }
      map.set(s.strategy_name, existing);
    }

    return Array.from(map.values()).map((h) => ({
      ...h,
      topReasons: Array.from(h.noneReasons.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3),
      pools: Array.from(h.pools).sort(),
    })).sort((a, b) => a.strategy.localeCompare(b.strategy));
  }, [signals]);

  // Listado filtrado
  const filteredSignals = useMemo(() => {
    return signals.filter((s) => {
      if (actionFilter === "active" && s.action === "NONE") return false;
      if (actionFilter === "none" && s.action !== "NONE") return false;
      if (stratFilter !== "all" && s.strategy_name !== stratFilter) return false;
      return true;
    }).slice(0, 50);
  }, [signals, actionFilter, stratFilter]);

  const strategyOptions = Array.from(new Set(signals.map((s) => s.strategy_name))).sort();

  return (
    <>
      {/* Health por estrategia */}
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Health por estrategia (últimas 24h)</h2>
        {health.length === 0 ? (
          <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin evaluaciones registradas.</div>
        ) : (
          <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="w-6"></th>
                  <th className="text-left px-3 py-2">Strategy</th>
                  <th className="text-left px-3 py-2">Pools</th>
                  <th className="text-right px-2 py-2">Últ. eval</th>
                  <th className="text-right px-2 py-2">BUY 24h</th>
                  <th className="text-right px-2 py-2">BUY 7d</th>
                  <th className="text-right px-2 py-2">NONE 24h</th>
                  <th className="text-right px-2 py-2">Últ. BUY</th>
                  <th className="text-left px-3 py-2">Top razones de NONE</th>
                </tr>
              </thead>
              <tbody>
                {health.map((h) => {
                  // Health visual: verde si BUY reciente, amarillo si silencio largo, rojo si nunca BUY
                  const hoursSinceBuy = h.lastBuyMs ? (Date.now() - h.lastBuyMs) / 3600_000 : null;
                  const Icon = h.buy24 > 0 ? Heart : hoursSinceBuy == null ? HeartCrack : AlertCircle;
                  const color = h.buy24 > 0 ? "text-lime-400" : hoursSinceBuy == null ? "text-red-500" : hoursSinceBuy < 168 ? "text-amber-400" : "text-red-400";
                  return (
                    <tr key={h.strategy} className="border-b border-zinc-900 align-top">
                      <td className="px-2 pt-2.5"><Icon className={`w-3.5 h-3.5 ${color}`} /></td>
                      <td className="px-3 py-2 text-zinc-100 font-medium">{h.strategy}</td>
                      <td className="px-3 py-2 text-[10px] uppercase text-zinc-500">{h.pools.join(" · ")}</td>
                      <td className="px-2 py-2 text-right text-[10px] text-zinc-500 tabular-nums">{relativeTime(h.lastEvalMs)}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${h.buy24 > 0 ? "text-lime-400 font-medium" : "text-zinc-600"}`}>{h.buy24}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${h.buy7d > 0 ? "text-emerald-400" : "text-zinc-600"}`}>{h.buy7d}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-zinc-500">{h.none24}</td>
                      <td className="px-2 py-2 text-right text-[10px] text-zinc-500 tabular-nums">{h.lastBuyMs ? relativeTime(h.lastBuyMs) : "nunca"}</td>
                      <td className="px-3 py-2 text-[10px]">
                        {h.topReasons.length === 0 ? (
                          <span className="text-zinc-700">—</span>
                        ) : (
                          <div className="space-y-0.5">
                            {h.topReasons.map(([reason, n]) => (
                              <div key={reason} className="flex items-baseline gap-2">
                                <span className="text-zinc-600 tabular-nums w-6 text-right">{n}×</span>
                                <span className="text-zinc-400">{reason}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-2 text-[10px] text-zinc-600">
          <span className="text-lime-400">●</span> operando &nbsp;
          <span className="text-amber-400">●</span> silencio &lt;7d &nbsp;
          <span className="text-red-400">●</span> silencio largo &nbsp;
          <span className="text-red-500">●</span> nunca dio BUY
        </div>
      </section>

      {/* Feed filtrado */}
      <section>
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">// Feed de señales ({filteredSignals.length} de {signals.length})</h2>
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              <FilterBtn active={actionFilter === "active"} onClick={() => setActionFilter("active")}>Solo BUY/SELL</FilterBtn>
              <FilterBtn active={actionFilter === "all"} onClick={() => setActionFilter("all")}>Todas</FilterBtn>
              <FilterBtn active={actionFilter === "none"} onClick={() => setActionFilter("none")}>Solo NONE</FilterBtn>
            </div>
            <select value={stratFilter} onChange={(e) => setStratFilter(e.target.value)}
              className="bg-black border border-zinc-800 px-2 py-1 text-[10px] text-zinc-200 font-mono focus:border-lime-500 outline-none">
              <option value="all">Todas strategies</option>
              {strategyOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {filteredSignals.length === 0 ? (
          <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">
            {actionFilter === "active" ? "Sin señales de entrada/salida activas. Cambiá a 'Todas' para ver el tráfico de evaluaciones NONE." : "Sin señales en este filtro."}
          </div>
        ) : (
          <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="w-6"></th>
                  <th className="text-left px-3 py-2">Símbolo</th>
                  <th className="text-left px-3 py-2">Strategy</th>
                  <th className="text-left px-2 py-2">Pool</th>
                  <th className="text-center px-2 py-2">Acción</th>
                  <th className="text-right px-2 py-2">Conf</th>
                  <th className="text-left px-3 py-2">Razón / plan</th>
                  <th className="text-right px-2 py-2">Cuándo</th>
                </tr>
              </thead>
              <tbody>
                {filteredSignals.map((s) => {
                  const isBuy = s.action === "BUY";
                  const isSell = s.action === "SELL";
                  const Icon = isBuy ? TrendingUp : isSell ? TrendingDown : Clock;
                  const iconColor = isBuy ? "text-lime-400" : isSell ? "text-red-400" : "text-zinc-600";
                  return (
                    <tr key={s.id} className="border-b border-zinc-900">
                      <td className="px-2"><Icon className={`w-3 h-3 ${iconColor}`} /></td>
                      <td className="px-3 py-1.5 text-zinc-100 font-medium">{s.symbol}</td>
                      <td className="px-3 py-1.5 text-[10px] text-zinc-400">{s.strategy_name}</td>
                      <td className="px-2 py-1.5 text-[10px] uppercase text-zinc-500">{s.pool}</td>
                      <td className="px-2 py-1.5 text-center">
                        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 border ${
                          isBuy ? "border-lime-700 text-lime-400 bg-lime-950/30"
                          : isSell ? "border-red-700 text-red-400 bg-red-950/30"
                          : "border-zinc-800 text-zinc-600"
                        }`}>{s.action}</span>
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${s.confidence > 0 ? "text-zinc-300" : "text-zinc-700"}`}>
                        {s.confidence > 0 ? s.confidence.toFixed(0) : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-zinc-400">
                        {isBuy ? (
                          <span className="text-[11px]">
                            E: <span className="text-zinc-200">${s.entry_price?.toFixed(2)}</span> ·
                            S: <span className="text-red-400">${s.stop_price?.toFixed(2)}</span> ·
                            T: <span className="text-emerald-400">${s.target_price?.toFixed(2)}</span>
                            {s.reasoning && <span className="text-zinc-500 ml-2">· {s.reasoning}</span>}
                          </span>
                        ) : (
                          <span className="text-[11px] text-zinc-500">{s.reasoning || "—"}</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[10px] text-zinc-500 tabular-nums whitespace-nowrap">
                        {new Date(s.ts).toLocaleTimeString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function FilterBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`text-[10px] uppercase tracking-wider px-2 py-1 border ${active ? "border-lime-500 text-lime-400 bg-lime-950/30" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}>
      {children}
    </button>
  );
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
