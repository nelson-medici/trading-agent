"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Shell from "@/components/Shell";
import { formatUsd } from "@/lib/utils";
import { ChevronDown, ChevronRight, TrendingUp, TrendingDown, Target, Shield, Clock, Zap, BarChart3 } from "lucide-react";

interface Trade {
  id: string;
  symbol: string;
  side: string;
  size_units: number;
  entry_price: number;
  exit_price: number;
  entry_at: string;
  exit_at: string;
  pnl_usd: number;
  pnl_pct: number;
  commission_usd: number | null;
  exit_reason: string | null;
  hold_hours: number | null;
  score_at_entry: number | null;
  score_at_exit: number | null;
  pool: string;
  strategy_name: string | null;
}

interface Decision {
  id: string;
  symbol: string;
  justification: string | null;
  risks: string[] | null;
  score: number | null;
  created_at: string;
}

export default function HistoryPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  // Filters
  const [fPool, setFPool] = useState<string>("all");
  const [fStrategy, setFStrategy] = useState<string>("all");
  const [fReason, setFReason] = useState<string>("all");
  const [fSymbol, setFSymbol] = useState<string>("all");
  const [fDays, setFDays] = useState<number>(30);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      setLoading(false);
    });
  }, [router, supabase]);

  useEffect(() => {
    if (loading) return;
    async function load() {
      const since = new Date(Date.now() - fDays * 24 * 3600_000).toISOString();
      const { data } = await supabase
        .from("trades")
        .select("*")
        .gte("exit_at", since)
        .order("exit_at", { ascending: false })
        .limit(500);
      if (data) setTrades(data as Trade[]);
    }
    load();
    const iv = setInterval(load, 20000);
    return () => clearInterval(iv);
  }, [loading, fDays, supabase]);

  async function loadDecision(tradeId: string, symbol: string, entryAt: string) {
    if (decisions[tradeId]) return;
    // Buscar decisión más cercana en el tiempo al entry de este trade
    const { data } = await supabase
      .from("decisions")
      .select("*")
      .eq("symbol", symbol)
      .eq("status", "executed")
      .lte("executed_at", entryAt)
      .order("executed_at", { ascending: false })
      .limit(1);
    if (data && data.length > 0) {
      setDecisions((prev) => ({ ...prev, [tradeId]: data[0] as Decision }));
    }
  }

  const filtered = useMemo(() => {
    return trades.filter((t) => {
      if (fPool !== "all" && t.pool !== fPool) return false;
      if (fStrategy !== "all" && (t.strategy_name || "score_based") !== fStrategy) return false;
      if (fReason !== "all" && t.exit_reason !== fReason) return false;
      if (fSymbol !== "all" && t.symbol !== fSymbol) return false;
      return true;
    });
  }, [trades, fPool, fStrategy, fReason, fSymbol]);

  // Opciones de filtro dinámicas
  const pools = useMemo(() => Array.from(new Set(trades.map((t) => t.pool))).sort(), [trades]);
  const strategies = useMemo(() => Array.from(new Set(trades.map((t) => t.strategy_name || "score_based"))).sort(), [trades]);
  const reasons = useMemo(() => Array.from(new Set(trades.map((t) => t.exit_reason).filter(Boolean))).sort(), [trades]);
  const symbols = useMemo(() => Array.from(new Set(trades.map((t) => t.symbol))).sort(), [trades]);

  // Agregaciones
  const stats = useMemo(() => {
    const n = filtered.length;
    const wins = filtered.filter((t) => t.pnl_usd > 0);
    const losses = filtered.filter((t) => t.pnl_usd < 0);
    const totalPnl = filtered.reduce((s, t) => s + t.pnl_usd, 0);
    const winRate = n > 0 ? wins.length / n : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl_usd, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl_usd, 0) / losses.length : 0;
    const pf = Math.abs(avgLoss * losses.length) > 0 ? (avgWin * wins.length) / Math.abs(avgLoss * losses.length) : 0;
    const avgHold = n > 0 ? filtered.reduce((s, t) => s + (t.hold_hours ?? 0), 0) / n : 0;

    const byReason: Record<string, number> = {};
    for (const t of filtered) {
      const r = t.exit_reason || "unknown";
      byReason[r] = (byReason[r] || 0) + 1;
    }

    const byStrategy: Record<string, { n: number; pnl: number }> = {};
    for (const t of filtered) {
      const s = t.strategy_name || "score_based";
      if (!byStrategy[s]) byStrategy[s] = { n: 0, pnl: 0 };
      byStrategy[s].n += 1;
      byStrategy[s].pnl += t.pnl_usd;
    }

    return { n, wins: wins.length, losses: losses.length, totalPnl, winRate, avgWin, avgLoss, pf, avgHold, byReason, byStrategy };
  }, [filtered]);

  if (loading) return null;

  return (
    <Shell current="history">
      <div className="space-y-6">
        {/* Filtros */}
        <div className="border border-zinc-800 bg-zinc-950 p-3 flex flex-wrap items-center gap-3 text-xs">
          <Filter label="Pool" value={fPool} onChange={setFPool} options={["all", ...pools]} />
          <Filter label="Strategy" value={fStrategy} onChange={setFStrategy} options={["all", ...strategies]} />
          <Filter label="Exit reason" value={fReason} onChange={setFReason} options={["all", ...reasons as string[]]} />
          <Filter label="Symbol" value={fSymbol} onChange={setFSymbol} options={["all", ...symbols]} />
          <div className="flex items-center gap-1 ml-2">
            {[7, 30, 90, 365].map((d) => (
              <button key={d} onClick={() => setFDays(d)}
                className={`text-[10px] uppercase tracking-wider px-2 py-1 border ${fDays === d ? "border-lime-500 text-lime-400 bg-lime-950/30" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}>
                {d}d
              </button>
            ))}
          </div>
          <span className="ml-auto text-zinc-500 text-[11px]">{filtered.length} trades · de {trades.length}</span>
        </div>

        {/* Stats top-level */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <StatCard label="Trades" value={stats.n} />
          <StatCard label="Win rate" value={`${(stats.winRate * 100).toFixed(1)}%`} tone={stats.winRate >= 0.5 ? "success" : "warn"} />
          <StatCard label="PnL total" value={formatUsd(stats.totalPnl)} tone={stats.totalPnl >= 0 ? "success" : "danger"} />
          <StatCard label="Profit factor" value={stats.pf.toFixed(2)} tone={stats.pf >= 1.5 ? "success" : stats.pf >= 1 ? "warn" : "danger"} />
          <StatCard label="Avg win" value={formatUsd(stats.avgWin)} tone="success" />
          <StatCard label="Avg loss" value={formatUsd(stats.avgLoss)} tone="danger" />
        </div>

        {/* Agregaciones secundarias */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Por exit reason */}
          <div className="border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">// Por motivo de salida</div>
            <div className="space-y-1">
              {Object.entries(stats.byReason).sort((a, b) => b[1] - a[1]).map(([reason, count]) => (
                <div key={reason} className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2 text-zinc-300">
                    <ReasonIcon reason={reason} />
                    <span className="uppercase text-[10px]">{reason}</span>
                  </span>
                  <span className="tabular-nums text-zinc-500">{count} ({((count / stats.n) * 100).toFixed(0)}%)</span>
                </div>
              ))}
            </div>
          </div>

          {/* Por strategy */}
          <div className="border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">// PnL por strategy</div>
            <div className="space-y-1">
              {Object.entries(stats.byStrategy).sort((a, b) => b[1].pnl - a[1].pnl).map(([strat, s]) => (
                <div key={strat} className="flex items-center justify-between text-xs">
                  <span className="text-zinc-300">{strat}</span>
                  <span className="flex items-center gap-2 text-[11px]">
                    <span className="text-zinc-600">{s.n} trades</span>
                    <span className={`tabular-nums ${s.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatUsd(s.pnl)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Tabla de trades */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Trades cerrados</h2>
          {filtered.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin trades en este filtro.</div>
          ) : (
            <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="w-6"></th>
                    <th className="text-left px-3 py-2">Símbolo</th>
                    <th className="text-left px-3 py-2">Pool</th>
                    <th className="text-left px-3 py-2">Strategy</th>
                    <th className="text-right px-3 py-2">Entry</th>
                    <th className="text-right px-3 py-2">Exit</th>
                    <th className="text-right px-3 py-2">PnL $</th>
                    <th className="text-right px-3 py-2">PnL %</th>
                    <th className="text-center px-3 py-2">Motivo</th>
                    <th className="text-right px-3 py-2">Hold</th>
                    <th className="text-right px-3 py-2">Score E / X</th>
                    <th className="text-right px-3 py-2">Cerrado</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => {
                    const isWin = t.pnl_usd >= 0;
                    const isExpanded = expanded === t.id;
                    return (
                      <>
                        <tr key={t.id}
                          onClick={() => {
                            const willOpen = !isExpanded;
                            setExpanded(willOpen ? t.id : null);
                            if (willOpen) loadDecision(t.id, t.symbol, t.entry_at);
                          }}
                          className="border-b border-zinc-900 hover:bg-zinc-900/30 cursor-pointer">
                          <td className="px-2 text-zinc-600">{isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}</td>
                          <td className="px-3 py-2 text-zinc-100 font-medium">{t.symbol}</td>
                          <td className="px-3 py-2 text-zinc-400 text-[10px] uppercase">{t.pool}</td>
                          <td className="px-3 py-2 text-zinc-400 text-[10px]">{t.strategy_name || "score_based"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">${t.entry_price.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">${t.exit_price.toFixed(2)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${isWin ? "text-emerald-400" : "text-red-400"}`}>{formatUsd(t.pnl_usd)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${isWin ? "text-emerald-400" : "text-red-400"}`}>{(t.pnl_pct * 100).toFixed(2)}%</td>
                          <td className="px-3 py-2 text-center">
                            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 border ${reasonBadge(t.exit_reason)}`}>{t.exit_reason}</span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{(t.hold_hours ?? 0).toFixed(1)}h</td>
                          <td className="px-3 py-2 text-right tabular-nums text-zinc-500 text-[10px]">
                            {t.score_at_entry != null ? t.score_at_entry.toFixed(0) : "—"} / {t.score_at_exit != null ? t.score_at_exit.toFixed(0) : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-zinc-500 text-[10px]">{new Date(t.exit_at).toLocaleString()}</td>
                        </tr>
                        {isExpanded && (
                          <tr className="border-b border-zinc-900 bg-zinc-950/40">
                            <td colSpan={12} className="px-6 py-4">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                                <div>
                                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Justificación de entrada</div>
                                  {decisions[t.id] ? (
                                    <div className="text-zinc-300">{decisions[t.id].justification}</div>
                                  ) : (
                                    <div className="text-zinc-600">Buscando decisión asociada...</div>
                                  )}
                                  {decisions[t.id]?.risks && decisions[t.id].risks!.length > 0 && (
                                    <div className="mt-2 text-red-400 text-[11px]">
                                      Riesgos: {decisions[t.id].risks!.join(", ")}
                                    </div>
                                  )}
                                </div>
                                <div className="space-y-1 text-zinc-400">
                                  <div><span className="text-zinc-500">Entry time:</span> {new Date(t.entry_at).toLocaleString()}</div>
                                  <div><span className="text-zinc-500">Exit time:</span> {new Date(t.exit_at).toLocaleString()}</div>
                                  <div><span className="text-zinc-500">Size:</span> {t.size_units} unidades</div>
                                  <div><span className="text-zinc-500">Notional entry:</span> {formatUsd(t.size_units * t.entry_price)}</div>
                                  <div><span className="text-zinc-500">Comisión:</span> {formatUsd(t.commission_usd ?? 0)}</div>
                                  <div className="pt-2">
                                    <Link href={`/charts`} className="text-lime-400 hover:underline text-[11px]">
                                      → Ver chart de {t.symbol}
                                    </Link>
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}:</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="bg-black border border-zinc-800 px-2 py-1 text-[11px] text-zinc-100 focus:border-lime-500 outline-none font-mono">
        {options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    </div>
  );
}

function StatCard({ label, value, tone = "neutral" }: { label: string; value: any; tone?: string }) {
  const color = { neutral: "text-zinc-100", success: "text-emerald-400", warn: "text-amber-400", danger: "text-red-400" }[tone] || "text-zinc-100";
  return (
    <div className="border border-zinc-800 bg-zinc-950 p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      <div className={`mt-1 text-lg font-light tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function ReasonIcon({ reason }: { reason: string }) {
  const map: Record<string, any> = {
    stop: Shield,
    target: Target,
    score_broken: TrendingDown,
    rotation: Zap,
    manual: BarChart3,
    eod: Clock,
  };
  const Icon = map[reason] || Clock;
  const color = reason === "target" ? "text-emerald-400" : reason === "stop" ? "text-red-400" : "text-zinc-400";
  return <Icon className={`w-3 h-3 ${color}`} />;
}

function reasonBadge(reason: string | null): string {
  switch (reason) {
    case "target": return "border-emerald-700 text-emerald-400 bg-emerald-950/30";
    case "stop": return "border-red-700 text-red-400 bg-red-950/30";
    case "score_broken": return "border-amber-700 text-amber-400 bg-amber-950/30";
    case "rotation": return "border-blue-700 text-blue-400 bg-blue-950/30";
    case "manual": return "border-zinc-600 text-zinc-300 bg-zinc-900";
    default: return "border-zinc-800 text-zinc-500";
  }
}
