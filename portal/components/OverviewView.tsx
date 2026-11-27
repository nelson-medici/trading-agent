"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { formatUsd, formatPct } from "@/lib/utils";
import { Wallet, Layers, Gauge, Activity, Eye, TrendingUp, DollarSign } from "lucide-react";

interface Summary {
  current_equity: number | null;
  hwm: number | null;
  current_dd: number | null;
  total_invested: number | null;
  total_gain: number | null;
  total_gain_pct: number | null;
  open_positions: number | null;
  candidates: number | null;
  watchlist_count: number | null;
  kill_active: boolean | null;
  unacked_alerts: number | null;
  engine_status: string | null;
  engine_last_heartbeat: string | null;
}

interface Score {
  symbol: string;
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

interface Position {
  symbol: string;
  size_units: number;
  entry_price: number;
  current_price: number | null;
  stop_price: number;
  target_price: number;
  unrealized_pnl_usd: number | null;
  unrealized_pnl_pct: number | null;
  current_score: number | null;
  opened_at: string;
}

export default function OverviewView() {
  const supabase = createClient();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [scores, setScores] = useState<Score[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);

  useEffect(() => {
    async function load() {
      const [summaryRes, scoresRes, posRes] = await Promise.all([
        supabase.from("v_dashboard_summary").select("*").single(),
        // Último score por símbolo — tomo top 20 ordenado desc y luego dedupeo en front
        supabase.from("scores").select("*").order("ts", { ascending: false }).limit(20),
        supabase.from("positions").select("*"),
      ]);
      if (summaryRes.data) setSummary(summaryRes.data as Summary);
      if (scoresRes.data) {
        // dedupe por symbol (primer ocurrencia = más reciente)
        const seen = new Set<string>();
        const unique: Score[] = [];
        for (const s of scoresRes.data as Score[]) {
          if (!seen.has(s.symbol)) {
            seen.add(s.symbol);
            unique.push(s);
          }
        }
        setScores(unique);
      }
      if (posRes.data) setPositions(posRes.data as Position[]);
    }
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [supabase]);

  if (!summary) {
    return <div className="text-zinc-500 text-xs">cargando...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Stats row 1 — plata */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Equity actual" value={summary.current_equity != null ? formatUsd(summary.current_equity) : "—"} icon={Wallet} tone="accent" />
        <Stat label="Inversión" value={summary.total_invested != null ? formatUsd(summary.total_invested) : "—"} icon={DollarSign} sub="Aportes netos" />
        <Stat
          label="Ganancia"
          value={summary.total_gain != null ? formatUsd(summary.total_gain) : "—"}
          sub={summary.total_gain_pct != null ? `${(summary.total_gain_pct * 100).toFixed(2)}% vs inversión` : undefined}
          tone={(summary.total_gain ?? 0) > 0 ? "success" : (summary.total_gain ?? 0) < 0 ? "danger" : "neutral"}
          icon={TrendingUp}
        />
        <Stat label="HWM" value={summary.hwm != null ? formatUsd(summary.hwm) : "—"} sub="Pico histórico" />
      </div>

      {/* Stats row 2 — estado */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="DD desde HWM" value={summary.current_dd != null ? formatPct(summary.current_dd) : "—"} tone={summary.current_dd && summary.current_dd > 0.08 ? "warn" : "neutral"} icon={Gauge} />
        <Stat label="Posiciones abiertas" value={summary.open_positions ?? 0} icon={Layers} />
        <Stat label="Candidatos / Watch" value={`${summary.candidates ?? 0} / ${summary.watchlist_count ?? 0}`} icon={Eye} sub="Próximos a operar" />
        <Stat label="Engine" value={summary.engine_status ?? "unknown"} sub={summary.engine_last_heartbeat ? new Date(summary.engine_last_heartbeat).toLocaleTimeString() : "sin heartbeat"} tone={summary.engine_status === "healthy" ? "success" : "warn"} icon={Activity} />
      </div>

      {summary.kill_active && (
        <div className="border border-red-800 bg-red-950/20 p-4 text-xs">
          <div className="text-red-300 uppercase tracking-wider text-[10px] mb-1">Kill switch ACTIVO</div>
          <div className="text-zinc-400">Sistema pausado. Ir a Control para revisar y reanudar.</div>
        </div>
      )}

      {/* Posiciones abiertas */}
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Posiciones abiertas ({positions.length})</h2>
        {positions.length === 0 ? (
          <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">
            No hay posiciones abiertas.
          </div>
        ) : (
          <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="text-left px-3 py-2">Symbol</th>
                  <th className="text-right px-3 py-2">Size</th>
                  <th className="text-right px-3 py-2">Entry</th>
                  <th className="text-right px-3 py-2">Current</th>
                  <th className="text-right px-3 py-2">Stop</th>
                  <th className="text-right px-3 py-2">Target</th>
                  <th className="text-right px-3 py-2">PnL</th>
                  <th className="text-right px-3 py-2">Score</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const pnlPos = (p.unrealized_pnl_usd ?? 0) >= 0;
                  return (
                    <tr key={p.symbol} className="border-b border-zinc-900">
                      <td className="px-3 py-2 text-zinc-100 font-medium">{p.symbol}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{p.size_units.toFixed(6)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">${p.entry_price.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">${(p.current_price ?? p.entry_price).toFixed(2)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-400">${p.stop_price.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-400">${p.target_price.toFixed(2)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pnlPos ? "text-emerald-400" : "text-red-400"}`}>
                        {formatUsd(p.unrealized_pnl_usd ?? 0)} ({((p.unrealized_pnl_pct ?? 0) * 100).toFixed(2)}%)
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{(p.current_score ?? 0).toFixed(1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Scoring por activo */}
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Último scoring por activo</h2>
        {scores.length === 0 ? (
          <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">
            Sin scores todavía. Esperando primer ciclo del engine.
          </div>
        ) : (
          <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="text-left px-3 py-2">Symbol</th>
                  <th className="text-right px-3 py-2">Total</th>
                  <th className="text-right px-3 py-2">Technical</th>
                  <th className="text-right px-3 py-2">Fund.</th>
                  <th className="text-right px-3 py-2">Sent.</th>
                  <th className="text-right px-3 py-2">Risk</th>
                  <th className="text-right px-3 py-2">Timing</th>
                  <th className="text-center px-3 py-2">Aligned</th>
                  <th className="text-center px-3 py-2">State</th>
                  <th className="text-center px-3 py-2">HC</th>
                  <th className="text-right px-3 py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((s) => (
                  <tr key={s.symbol} className="border-b border-zinc-900">
                    <td className="px-3 py-2 text-zinc-100 font-medium">{s.symbol}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-medium ${scoreColor(s.score_total)}`}>{s.score_total.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{(s.score_technical ?? 0).toFixed(0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{(s.score_fundamental ?? 0).toFixed(0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{(s.score_sentiment ?? 0).toFixed(0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{(s.score_risk ?? 0).toFixed(0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{(s.score_timing ?? 0).toFixed(0)}</td>
                    <td className="px-3 py-2 text-center text-zinc-400">{s.indicators_aligned ?? 0}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 ${stateBadge(s.state)}`}>{s.state}</span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      {s.passes_high_confidence ? <span className="text-emerald-400">✓</span> : <span className="text-zinc-700">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-500 tabular-nums">{new Date(s.ts).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="text-[10px] text-zinc-600">
        actualiza cada 15s · {new Date().toLocaleTimeString()}
      </div>
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 85) return "text-lime-400";
  if (score >= 75) return "text-emerald-400";
  if (score >= 60) return "text-amber-400";
  return "text-zinc-500";
}

function stateBadge(state: string): string {
  switch (state) {
    case "ENTERED": return "bg-lime-950 text-lime-400 border border-lime-900";
    case "CANDIDATE": return "bg-emerald-950 text-emerald-400 border border-emerald-900";
    case "WATCHLIST": return "bg-amber-950 text-amber-400 border border-amber-900";
    case "EXIT": return "bg-red-950 text-red-400 border border-red-900";
    default: return "bg-zinc-900 text-zinc-500 border border-zinc-800";
  }
}

function Stat({ label, value, sub, icon: Icon, tone = "neutral" }: { label: string; value: any; sub?: string; icon?: any; tone?: string }) {
  const color = { neutral: "text-zinc-100", accent: "text-lime-400", success: "text-emerald-400", warn: "text-amber-400", danger: "text-red-400" }[tone] || "text-zinc-100";
  return (
    <div className="border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-start justify-between">
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
        {Icon && <Icon className="w-3.5 h-3.5 text-zinc-600" />}
      </div>
      <div className={`mt-2 text-2xl font-light ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-zinc-500 mt-1">{sub}</div>}
    </div>
  );
}
