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
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  notional_usd: number | null;
  created_at: string;
  executed_at: string | null;
  status: string;
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
    // Matchear por created_at dentro de una ventana ±10 min alrededor del entry.
    // (el engine crea la decision, abre la posición y recién después marca status=executed,
    // así que executed_at puede ser posterior al entry_at del trade).
    const entryMs = new Date(entryAt).getTime();
    const windowMs = 10 * 60 * 1000;
    const after = new Date(entryMs - windowMs).toISOString();
    const before = new Date(entryMs + windowMs).toISOString();

    const { data } = await supabase
      .from("decisions")
      .select("*")
      .eq("symbol", symbol)
      .in("status", ["executed", "approved", "pending"])
      .gte("created_at", after)
      .lte("created_at", before)
      .order("created_at", { ascending: false })
      .limit(10);

    if (data && data.length > 0) {
      // Elegir la decisión cuyo created_at esté más cerca del entry_at del trade
      const best = (data as Decision[]).reduce((best, curr) => {
        const bestDelta = Math.abs(entryMs - new Date(best.created_at).getTime());
        const currDelta = Math.abs(entryMs - new Date(curr.created_at).getTime());
        return currDelta < bestDelta ? curr : best;
      });
      setDecisions((prev) => ({ ...prev, [tradeId]: best }));
    } else {
      // Marcar como no encontrada para que no quede en loading infinito
      setDecisions((prev) => ({ ...prev, [tradeId]: { id: "__none__", symbol, justification: null, risks: null, score: null, entry_price: null, stop_price: null, target_price: null, notional_usd: null, created_at: "", executed_at: null, status: "not_found" } }));
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
                        {isExpanded && <ExpandedRow trade={t} decision={decisions[t.id]} />}
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

function ExpandedRow({ trade: t, decision }: { trade: Trade; decision: Decision | undefined }) {
  const notionalEntry = t.size_units * t.entry_price;
  const notionalExit = t.size_units * t.exit_price;
  const commission = t.commission_usd ?? notionalEntry * 0.001;
  const grossPnl = (t.exit_price - t.entry_price) * t.size_units;
  const entryMs = new Date(t.entry_at).getTime();
  const decisionCreatedMs = decision?.created_at ? new Date(decision.created_at).getTime() : null;
  const latencyS = decisionCreatedMs != null ? (entryMs - decisionCreatedMs) / 1000 : null;

  // Risk & reward teóricos (si hay decision con stop/target)
  const stop = decision?.stop_price ?? null;
  const target = decision?.target_price ?? null;
  const riskPerUnit = stop != null ? Math.abs(t.entry_price - stop) : null;
  const rewardPerUnit = target != null ? Math.abs(target - t.entry_price) : null;
  const rr = riskPerUnit && rewardPerUnit ? rewardPerUnit / riskPerUnit : null;

  // Cuánto se alejó el exit del stop original (para detectar stops muy pegados vs slippage)
  const exitVsStop = stop != null ? ((t.exit_price - stop) / stop) * 100 : null;
  const exitVsTarget = target != null ? ((t.exit_price - target) / target) * 100 : null;

  const notFound = decision && decision.id === "__none__";

  return (
    <tr className="border-b border-zinc-900 bg-zinc-950/40">
      <td colSpan={12} className="px-6 py-5">
        <div className="space-y-4">

          {/* FILA 1: Timeline + plan original */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            {/* Timeline del trade */}
            <div className="border border-zinc-900 p-3 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">// Timeline</div>
              {decision && !notFound && (
                <RowKV k="Decisión creada" v={new Date(decision.created_at).toLocaleString()} sub={latencyS != null ? `${latencyS.toFixed(1)}s hasta entry` : undefined} />
              )}
              <RowKV k="Apertura" v={new Date(t.entry_at).toLocaleString()} />
              <RowKV k="Cierre" v={new Date(t.exit_at).toLocaleString()} />
              <RowKV k="Duración" v={`${(t.hold_hours ?? 0).toFixed(2)} h`} />
            </div>

            {/* Plan original (de la decision) */}
            <div className="border border-zinc-900 p-3 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">// Plan original</div>
              {decision && !notFound ? (
                <>
                  <RowKV k="Entry planeado" v={decision.entry_price != null ? `$${decision.entry_price.toFixed(4)}` : "—"} />
                  <RowKV k="Stop" v={stop != null ? `$${stop.toFixed(4)}` : "—"}
                    sub={stop != null ? `${((stop - t.entry_price) / t.entry_price * 100).toFixed(2)}% desde entry` : undefined}
                    tone="danger" />
                  <RowKV k="Target" v={target != null ? `$${target.toFixed(4)}` : "—"}
                    sub={target != null ? `${((target - t.entry_price) / t.entry_price * 100).toFixed(2)}% desde entry` : undefined}
                    tone="success" />
                  <RowKV k="Risk / Reward" v={rr != null ? `1 : ${rr.toFixed(2)}` : "—"} />
                </>
              ) : notFound ? (
                <div className="text-zinc-600">Sin decisión asociada (puede haber sido manual o pre-tracking).</div>
              ) : (
                <div className="text-zinc-600">Buscando decisión...</div>
              )}
            </div>

            {/* Ejecución real */}
            <div className="border border-zinc-900 p-3 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">// Ejecución real</div>
              <RowKV k="Entry real" v={`$${t.entry_price.toFixed(4)}`} />
              <RowKV k="Exit real" v={`$${t.exit_price.toFixed(4)}`}
                sub={exitVsStop != null && t.exit_reason === "stop" ? `${exitVsStop >= 0 ? "+" : ""}${exitVsStop.toFixed(2)}% vs stop` : exitVsTarget != null && t.exit_reason === "target" ? `${exitVsTarget >= 0 ? "+" : ""}${exitVsTarget.toFixed(2)}% vs target` : undefined} />
              <RowKV k="Size" v={`${t.size_units.toFixed(6)} u`} />
              <RowKV k="Notional" v={`${formatUsd(notionalEntry)} → ${formatUsd(notionalExit)}`} />
            </div>
          </div>

          {/* FILA 2: Descomposición del PnL */}
          <div className="border border-zinc-900 p-3">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">// Descomposición del PnL</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <PnlCell label="Precio" value={grossPnl} sub={`(${t.exit_price.toFixed(4)} − ${t.entry_price.toFixed(4)}) × ${t.size_units.toFixed(4)}`} />
              <PnlCell label="Comisión" value={-Math.abs(commission)} sub={`~0.1% sobre ${formatUsd(notionalEntry)}`} />
              <PnlCell label="PnL neto $" value={t.pnl_usd} bold />
              <div className="border border-zinc-800 p-2">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">PnL %</div>
                <div className={`text-lg tabular-nums font-light ${t.pnl_pct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {(t.pnl_pct * 100).toFixed(2)}%
                </div>
                <div className="text-[10px] text-zinc-600">sobre el notional invertido</div>
              </div>
            </div>
          </div>

          {/* FILA 3: Scoring y motivo */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Justificación */}
            <div className="border border-zinc-900 p-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">// Justificación de entrada</div>
              {decision && !notFound && decision.justification ? (
                <div className="text-xs text-zinc-300 leading-relaxed">{decision.justification}</div>
              ) : notFound ? (
                <div className="text-xs text-zinc-600">—</div>
              ) : (
                <div className="text-xs text-zinc-600">Buscando decisión asociada...</div>
              )}
              {decision && !notFound && decision.risks && decision.risks.length > 0 && (
                <div className="mt-3 pt-2 border-t border-zinc-900">
                  <div className="text-[10px] uppercase tracking-wider text-amber-500 mb-1">Riesgos identificados</div>
                  <div className="flex flex-wrap gap-1">
                    {decision.risks.map((r, i) => (
                      <span key={i} className="text-[10px] px-1.5 py-0.5 border border-amber-900 text-amber-300 bg-amber-950/20">{r}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Lectura del cierre */}
            <div className="border border-zinc-900 p-3 space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">// Lectura del cierre</div>
              <div className="text-xs text-zinc-300">
                <ExitInterpretation trade={t} decision={decision && !notFound ? decision : null} />
              </div>
              <div className="pt-2 border-t border-zinc-900 flex items-center gap-4 text-[11px]">
                <Link href={`/decisions/${encodeURIComponent(t.symbol)}`} className="text-lime-400 hover:underline">
                  → Decisiones de {t.symbol}
                </Link>
                <Link href={`/charts?symbol=${encodeURIComponent(t.symbol)}`} className="text-lime-400 hover:underline">
                  → Chart
                </Link>
              </div>
            </div>
          </div>

        </div>
      </td>
    </tr>
  );
}

function RowKV({ k, v, sub, tone = "neutral" }: { k: string; v: string; sub?: string; tone?: string }) {
  const color = { neutral: "text-zinc-200", success: "text-emerald-400", warn: "text-amber-400", danger: "text-red-400" }[tone] || "text-zinc-200";
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500 pt-0.5">{k}</span>
      <span className="text-right">
        <div className={`tabular-nums ${color}`}>{v}</div>
        {sub && <div className="text-[9px] text-zinc-600">{sub}</div>}
      </span>
    </div>
  );
}

function PnlCell({ label, value, sub, bold = false }: { label: string; value: number; sub?: string; bold?: boolean }) {
  const color = value > 0 ? "text-emerald-400" : value < 0 ? "text-red-400" : "text-zinc-400";
  return (
    <div className="border border-zinc-800 p-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`tabular-nums ${bold ? "text-lg font-light" : "text-sm"} ${color}`}>{formatUsd(value)}</div>
      {sub && <div className="text-[9px] text-zinc-600 mt-0.5">{sub}</div>}
    </div>
  );
}

function ExitInterpretation({ trade: t, decision }: { trade: Trade; decision: Decision | null }) {
  const reason = t.exit_reason;
  const hold = t.hold_hours ?? 0;
  const scoreHeld = t.score_at_entry != null && t.score_at_exit != null && Math.abs(t.score_at_entry - t.score_at_exit) < 0.01;

  if (reason === "stop" && hold < 0.5) {
    return <>Stop saltó en <span className="text-amber-300">{(hold * 60).toFixed(0)} min</span>. El movimiento adverso fue inmediato tras la entrada — típico de stop demasiado pegado o entrada sobre un pico. Con stop más ancho (ATR×2.5) o entrada confirmada por retest, este caso podría haberse evitado.</>;
  }
  if (reason === "stop") {
    return <>Stop ejecutado tras <span className="text-amber-300">{hold.toFixed(1)}h</span> de hold. El setup se rompió. {scoreHeld ? "El score se mantuvo igual, así que el stop fue puramente por precio (no por deterioro de señal)." : "El score cambió durante el trade — revisar si convenía salir antes."}</>;
  }
  if (reason === "target") {
    return <>Target alcanzado en <span className="text-emerald-400">{hold.toFixed(1)}h</span>. La tesis se materializó según lo planeado. {decision?.target_price ? `Entry → target = ${(((decision.target_price - t.entry_price) / t.entry_price) * 100).toFixed(2)}%.` : ""}</>;
  }
  if (reason === "score_broken") {
    return <>Salida por deterioro de señal: el score cayó por debajo del threshold mientras la posición estaba abierta. Protección anti-reversión.</>;
  }
  if (reason === "rotation") {
    return <>Cerrado para liberar capital hacia una oportunidad con score más alto en el mismo pool.</>;
  }
  if (reason === "manual") {
    return <>Cierre manual desde el portal.</>;
  }
  return <>Cerrado por motivo: <span className="text-zinc-400">{reason ?? "desconocido"}</span>.</>;
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
