"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase";
import Shell from "@/components/Shell";
import { formatUsd } from "@/lib/utils";
import { ArrowLeft, TrendingUp, BarChart3 } from "lucide-react";

interface Score {
  symbol: string;
  pool: string | null;
  score_total: number;
  score_technical: number | null;
  score_fundamental: number | null;
  score_sentiment: number | null;
  score_risk: number | null;
  score_timing: number | null;
  state: string;
  passes_high_confidence: boolean | null;
  indicators_aligned: number | null;
  ts: string;
}

interface Decision {
  id: string;
  symbol: string;
  action: string;
  score: number | null;
  justification: string | null;
  risks: string[] | null;
  stop_price: number | null;
  target_price: number | null;
  size_units: number | null;
  notional_usd: number | null;
  entry_price: number | null;
  status: string;
  rejected_reason: string | null;
  created_at: string;
  executed_at: string | null;
  pool: string | null;
}

interface Trade {
  id: string;
  symbol: string;
  side: string;
  pool: string;
  strategy_name: string | null;
  entry_price: number;
  exit_price: number;
  entry_at: string;
  exit_at: string;
  pnl_usd: number;
  pnl_pct: number;
  exit_reason: string | null;
  hold_hours: number | null;
}

export default function SymbolDetailPage() {
  const params = useParams();
  const router = useRouter();
  const supabase = createClient();
  const symbol = decodeURIComponent(String(params?.symbol || ""));

  const [loading, setLoading] = useState(true);
  const [scoreHistory, setScoreHistory] = useState<Score[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [expandedDecision, setExpandedDecision] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      setLoading(false);
    });
  }, [router, supabase]);

  useEffect(() => {
    if (loading || !symbol) return;
    async function load() {
      const [sc, dc, tr] = await Promise.all([
        supabase.from("scores").select("*").eq("symbol", symbol).order("ts", { ascending: false }).limit(200),
        supabase.from("decisions").select("*").eq("symbol", symbol).order("created_at", { ascending: false }).limit(100),
        supabase.from("trades").select("*").eq("symbol", symbol).order("exit_at", { ascending: false }).limit(50),
      ]);
      if (sc.data) setScoreHistory(sc.data as Score[]);
      if (dc.data) setDecisions(dc.data as Decision[]);
      if (tr.data) setTrades(tr.data as Trade[]);
    }
    load();
    const iv = setInterval(load, 20000);
    return () => clearInterval(iv);
  }, [loading, symbol, supabase]);

  const current = scoreHistory[0];

  const stats = useMemo(() => {
    if (decisions.length === 0 && trades.length === 0) return null;
    const executed = decisions.filter((d) => d.status === "executed").length;
    const rejected = decisions.filter((d) => d.status === "rejected").length;
    const wins = trades.filter((t) => t.pnl_usd > 0).length;
    const losses = trades.filter((t) => t.pnl_usd < 0).length;
    const totalPnl = trades.reduce((s, t) => s + t.pnl_usd, 0);
    const avgScore = decisions.length > 0
      ? decisions.filter((d) => d.score != null).reduce((s, d) => s + (d.score ?? 0), 0) / (decisions.filter((d) => d.score != null).length || 1)
      : 0;
    return { executed, rejected, wins, losses, totalPnl, avgScore, nDecisions: decisions.length, nTrades: trades.length };
  }, [decisions, trades]);

  if (loading) return null;

  return (
    <Shell current="decisions">
      <div className="space-y-6">

        {/* Back link */}
        <Link href="/decisions" className="inline-flex items-center gap-2 text-[11px] text-zinc-500 hover:text-lime-400">
          <ArrowLeft className="w-3 h-3" /> Volver a Decisiones
        </Link>

        {/* Header con score actual */}
        {current ? (
          <div className="border border-zinc-800 bg-zinc-950 p-4 flex items-center justify-between flex-wrap gap-4">
            <div>
              <div className="text-2xl text-zinc-100 font-medium">{symbol}</div>
              <div className="text-[10px] text-zinc-500 mt-1">
                Pool: <span className="text-zinc-300 uppercase">{current.pool || "—"}</span>
                {" · "} Último scoring: {new Date(current.ts).toLocaleString()}
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">Score actual</div>
                <div className={`text-3xl font-light tabular-nums ${scoreColor(current.score_total)}`}>{current.score_total.toFixed(1)}</div>
                <div className={`text-[10px] uppercase tracking-wider px-2 py-0.5 border inline-block ${stateBadge(current.state)}`}>{current.state}</div>
              </div>
              <Link href={`/charts?symbol=${encodeURIComponent(symbol)}`}
                className="flex items-center gap-2 border border-lime-700 text-lime-400 hover:bg-lime-950/30 px-3 py-2 text-xs uppercase tracking-wider">
                <BarChart3 className="w-3.5 h-3.5" /> Ver chart
              </Link>
            </div>
          </div>
        ) : (
          <div className="border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-xl text-zinc-100">{symbol}</div>
            <div className="text-xs text-zinc-600 mt-2">Sin scores registrados para este símbolo todavía.</div>
          </div>
        )}

        {/* KPIs del símbolo */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <Stat label="Decisiones" value={stats.nDecisions} />
            <Stat label="Ejecutadas" value={stats.executed} tone="success" />
            <Stat label="Rechazadas" value={stats.rejected} tone={stats.rejected > 0 ? "warn" : "neutral"} />
            <Stat label="Trades cerrados" value={stats.nTrades} />
            <Stat label="W / L" value={`${stats.wins} / ${stats.losses}`} tone={stats.wins >= stats.losses ? "success" : "danger"} />
            <Stat label="PnL total" value={formatUsd(stats.totalPnl)} tone={stats.totalPnl >= 0 ? "success" : "danger"} />
          </div>
        )}

        {/* Score timeline sparkline */}
        {scoreHistory.length > 1 && (
          <section>
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Evolución del score ({scoreHistory.length} puntos)</h2>
            <div className="border border-zinc-800 bg-zinc-950 p-4">
              <ScoreSparkline scores={[...scoreHistory].reverse()} />
            </div>
          </section>
        )}

        {/* Desglose componentes del score actual */}
        {current && (
          <section>
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Componentes del score actual</h2>
            <div className="grid grid-cols-5 gap-2">
              <ComponentCard label="Técnico" value={current.score_technical} />
              <ComponentCard label="Fundamental" value={current.score_fundamental} />
              <ComponentCard label="Sentimiento" value={current.score_sentiment} />
              <ComponentCard label="Riesgo" value={current.score_risk} />
              <ComponentCard label="Timing" value={current.score_timing} />
            </div>
            <div className="mt-3 text-[11px] text-zinc-500 flex items-center gap-4">
              <span>High-confidence check: {current.passes_high_confidence ? <span className="text-emerald-400">PASS</span> : <span className="text-zinc-500">NO</span>}</span>
              <span>· {current.indicators_aligned ?? 0} indicadores alineados</span>
            </div>
          </section>
        )}

        {/* Historial de decisiones */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Historial de decisiones ({decisions.length})</h2>
          {decisions.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin decisiones para este símbolo.</div>
          ) : (
            <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="w-6"></th>
                    <th className="text-left px-3 py-2">Timestamp</th>
                    <th className="text-center px-2 py-2">Acción</th>
                    <th className="text-center px-2 py-2">Status</th>
                    <th className="text-right px-2 py-2">Score</th>
                    <th className="text-right px-2 py-2">Entry</th>
                    <th className="text-right px-2 py-2">Stop</th>
                    <th className="text-right px-2 py-2">Target</th>
                    <th className="text-right px-2 py-2">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map((d) => {
                    const expanded = expandedDecision === d.id;
                    return (
                      <>
                        <tr key={d.id} onClick={() => setExpandedDecision(expanded ? null : d.id)}
                          className="border-b border-zinc-900 hover:bg-zinc-900/40 cursor-pointer">
                          <td className="px-2 text-zinc-600 text-xs">{expanded ? "▼" : "▶"}</td>
                          <td className="px-3 py-2 text-[10px] text-zinc-500 tabular-nums whitespace-nowrap">{new Date(d.created_at).toLocaleString()}</td>
                          <td className="px-2 py-2 text-center">
                            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 border ${actionBadge(d.action)}`}>{d.action}</span>
                          </td>
                          <td className="px-2 py-2 text-center">
                            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 border ${statusBadge(d.status)}`}>{d.status}</span>
                          </td>
                          <td className={`px-2 py-2 text-right tabular-nums ${d.score != null ? scoreColor(d.score) : "text-zinc-500"}`}>{d.score != null ? d.score.toFixed(1) : "—"}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-zinc-300">{d.entry_price != null ? `$${d.entry_price.toFixed(2)}` : "—"}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-red-400">{d.stop_price != null ? `$${d.stop_price.toFixed(2)}` : "—"}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-emerald-400">{d.target_price != null ? `$${d.target_price.toFixed(2)}` : "—"}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-zinc-300">{d.notional_usd != null ? formatUsd(d.notional_usd) : "—"}</td>
                        </tr>
                        {expanded && (
                          <tr className="border-b border-zinc-900 bg-zinc-950/60">
                            <td colSpan={9} className="px-6 py-3 text-xs space-y-2">
                              {d.justification && (
                                <div><span className="text-zinc-500 text-[10px] uppercase tracking-wider">Justificación:</span> <span className="text-zinc-300">{d.justification}</span></div>
                              )}
                              {d.rejected_reason && (
                                <div><span className="text-red-400 text-[10px] uppercase tracking-wider">Rechazada:</span> <span className="text-red-300">{d.rejected_reason}</span></div>
                              )}
                              {d.risks && d.risks.length > 0 && (
                                <div><span className="text-zinc-500 text-[10px] uppercase tracking-wider">Riesgos:</span> <span className="text-amber-300">{d.risks.join(" · ")}</span></div>
                              )}
                              {d.executed_at && (
                                <div className="text-[10px] text-zinc-600">Ejecutada: {new Date(d.executed_at).toLocaleString()} (latencia {((new Date(d.executed_at).getTime() - new Date(d.created_at).getTime()) / 1000).toFixed(1)}s)</div>
                              )}
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

        {/* Trades cerrados */}
        {trades.length > 0 && (
          <section>
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Trades cerrados de {symbol} ({trades.length})</h2>
            <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="text-left px-3 py-2">Cerrado</th>
                    <th className="text-left px-3 py-2">Strategy</th>
                    <th className="text-right px-2 py-2">Entry</th>
                    <th className="text-right px-2 py-2">Exit</th>
                    <th className="text-right px-2 py-2">PnL $</th>
                    <th className="text-right px-2 py-2">PnL %</th>
                    <th className="text-center px-2 py-2">Motivo</th>
                    <th className="text-right px-2 py-2">Hold</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} className="border-b border-zinc-900">
                      <td className="px-3 py-2 text-[10px] text-zinc-500 tabular-nums whitespace-nowrap">{new Date(t.exit_at).toLocaleString()}</td>
                      <td className="px-3 py-2 text-[10px] text-zinc-400">{t.strategy_name || "score_based"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">${t.entry_price.toFixed(2)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">${t.exit_price.toFixed(2)}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${t.pnl_usd >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatUsd(t.pnl_usd)}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${t.pnl_usd >= 0 ? "text-emerald-400" : "text-red-400"}`}>{(t.pnl_pct * 100).toFixed(2)}%</td>
                      <td className="px-2 py-2 text-center">
                        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 border ${exitReasonBadge(t.exit_reason)}`}>{t.exit_reason || "—"}</span>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-zinc-400">{(t.hold_hours ?? 0).toFixed(1)}h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

      </div>
    </Shell>
  );
}

// ---- helpers ----

function Stat({ label, value, tone = "neutral" }: { label: string; value: any; tone?: string }) {
  const color = { neutral: "text-zinc-100", success: "text-emerald-400", warn: "text-amber-400", danger: "text-red-400" }[tone] || "text-zinc-100";
  return (
    <div className="border border-zinc-800 bg-zinc-950 p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      <div className={`mt-1 text-lg font-light tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function ComponentCard({ label, value }: { label: string; value: number | null }) {
  const v = value ?? 0;
  const color = v >= 75 ? "text-emerald-400" : v >= 60 ? "text-amber-400" : "text-zinc-500";
  return (
    <div className="border border-zinc-800 bg-zinc-950 p-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`text-2xl font-light tabular-nums mt-1 ${color}`}>{v.toFixed(0)}</div>
    </div>
  );
}

function ScoreSparkline({ scores }: { scores: Score[] }) {
  const w = 800, h = 120, pad = 20;
  const values = scores.map((s) => s.score_total);
  const minV = 0; // escala fija 0-100 para contexto
  const maxV = 100;
  const points = values.map((v, i) => {
    const x = pad + (i / Math.max(1, values.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - minV) / (maxV - minV)) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  // Líneas de referencia
  const refs = [60, 75, 85];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-24">
      {/* ejes de referencia */}
      {refs.map((r) => {
        const y = h - pad - ((r - minV) / (maxV - minV)) * (h - 2 * pad);
        const color = r === 85 ? "#84cc16" : r === 75 ? "#10b981" : "#f59e0b";
        return (
          <g key={r}>
            <line x1={pad} x2={w - pad} y1={y} y2={y} stroke={color} strokeDasharray="3,3" strokeWidth="0.5" opacity="0.5" />
            <text x={w - pad + 2} y={y + 3} fill={color} fontSize="9" opacity="0.7">{r}</text>
          </g>
        );
      })}
      {/* polyline del score */}
      <polyline points={points} fill="none" stroke="#a3e635" strokeWidth="1.5" />
      {/* último punto */}
      {values.length > 0 && (() => {
        const lastV = values[values.length - 1];
        const x = pad + ((values.length - 1) / Math.max(1, values.length - 1)) * (w - 2 * pad);
        const y = h - pad - ((lastV - minV) / (maxV - minV)) * (h - 2 * pad);
        return <circle cx={x} cy={y} r="3" fill="#a3e635" />;
      })()}
    </svg>
  );
}

function scoreColor(score: number): string {
  if (score >= 85) return "text-lime-400";
  if (score >= 75) return "text-emerald-400";
  if (score >= 60) return "text-amber-400";
  return "text-zinc-500";
}

function stateBadge(state: string): string {
  return {
    ENTERED: "border-lime-700 text-lime-400 bg-lime-950/40",
    AGGRESSIVE: "border-lime-700 text-lime-400 bg-lime-950/40",
    CANDIDATE: "border-emerald-700 text-emerald-400 bg-emerald-950/40",
    WATCHLIST: "border-amber-700 text-amber-400 bg-amber-950/40",
    EXIT: "border-red-700 text-red-400 bg-red-950/40",
    IGNORE: "border-zinc-800 text-zinc-500",
  }[state] || "border-zinc-800 text-zinc-500";
}

function actionBadge(a: string): string {
  return {
    BUY: "border-emerald-700 text-emerald-400 bg-emerald-950/30",
    SELL: "border-red-700 text-red-400 bg-red-950/30",
    HOLD: "border-zinc-700 text-zinc-400",
  }[a] || "border-zinc-800 text-zinc-500";
}

function statusBadge(s: string): string {
  return {
    pending: "border-amber-700 text-amber-400 bg-amber-950/30",
    executed: "border-lime-700 text-lime-400 bg-lime-950/30",
    approved: "border-emerald-700 text-emerald-400 bg-emerald-950/30",
    rejected: "border-red-700 text-red-400 bg-red-950/30",
    canceled: "border-zinc-800 text-zinc-500",
  }[s] || "border-zinc-800 text-zinc-500";
}

function exitReasonBadge(r: string | null): string {
  switch (r) {
    case "target": return "border-emerald-700 text-emerald-400 bg-emerald-950/30";
    case "stop": return "border-red-700 text-red-400 bg-red-950/30";
    case "score_broken": return "border-amber-700 text-amber-400 bg-amber-950/30";
    case "rotation": return "border-blue-700 text-blue-400 bg-blue-950/30";
    default: return "border-zinc-800 text-zinc-500";
  }
}
