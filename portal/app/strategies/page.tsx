"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import { formatUsd, formatPct } from "@/lib/utils";
import { Play, Clock, CheckCircle2, XCircle, TrendingUp, TrendingDown } from "lucide-react";

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

const KNOWN_STRATEGIES = ["orb_intraday"];
const UNIVERSE = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "AVAX/USDT", "LINK/USDT", "DOT/USDT", "MATIC/USDT", "ARB/USDT"];

export default function StrategiesPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [strategies, setStrategies] = useState<any>({});
  const [signals, setSignals] = useState<Signal[]>([]);
  const [results, setResults] = useState<BacktestResult[]>([]);
  const [jobs, setJobs] = useState<BacktestJob[]>([]);

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
    const [cfgRes, sigRes, resRes, jobRes] = await Promise.all([
      supabase.from("config").select("value").eq("key", "strategies.enabled").single(),
      supabase.from("strategy_signals").select("*").order("created_at", { ascending: false }).limit(30),
      supabase.from("backtest_results").select("*").order("run_at", { ascending: false }).limit(50),
      supabase.from("backtest_jobs").select("*").order("requested_at", { ascending: false }).limit(10),
    ]);
    if (cfgRes.data?.value) setStrategies(cfgRes.data.value);
    if (sigRes.data) setSignals(sigRes.data as Signal[]);
    if (resRes.data) setResults(resRes.data as BacktestResult[]);
    if (jobRes.data) setJobs(jobRes.data as BacktestJob[]);
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

        {/* Señales recientes */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Señales recientes ({signals.length})</h2>
          {signals.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin señales todavía.</div>
          ) : (
            <div className="space-y-2">
              {signals.slice(0, 20).map((s) => {
                const isBuy = s.action === "BUY";
                const isNone = s.action === "NONE";
                const Icon = isBuy ? TrendingUp : isNone ? Clock : TrendingDown;
                return (
                  <div key={s.id} className={`border p-3 ${isBuy ? "border-lime-800 bg-lime-950/10" : isNone ? "border-zinc-900 bg-zinc-950" : "border-red-800 bg-red-950/10"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Icon className={`w-3.5 h-3.5 ${isBuy ? "text-lime-400" : isNone ? "text-zinc-500" : "text-red-400"}`} />
                          <span className="text-zinc-100 font-medium text-sm">{s.symbol}</span>
                          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 border ${isBuy ? "border-lime-800 text-lime-400" : isNone ? "border-zinc-800 text-zinc-500" : "border-red-800 text-red-400"}`}>
                            {s.action}
                          </span>
                          <span className="text-[10px] text-zinc-500">{s.strategy_name}</span>
                          <span className="text-[10px] text-zinc-600">pool: {s.pool}</span>
                          {s.confidence > 0 && <span className="text-[10px] text-zinc-400">conf: {s.confidence.toFixed(0)}</span>}
                        </div>
                        {s.reasoning && <div className="text-[11px] text-zinc-400">{s.reasoning}</div>}
                        {isBuy && (
                          <div className="flex gap-4 mt-1 text-[10px] text-zinc-500">
                            <span>Entry: <span className="text-zinc-300">${s.entry_price?.toFixed(2)}</span></span>
                            <span>Stop: <span className="text-red-400">${s.stop_price?.toFixed(2)}</span></span>
                            <span>Target: <span className="text-emerald-400">${s.target_price?.toFixed(2)}</span></span>
                          </div>
                        )}
                      </div>
                      <div className="text-[10px] text-zinc-600 whitespace-nowrap">{new Date(s.ts).toLocaleTimeString()}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}
