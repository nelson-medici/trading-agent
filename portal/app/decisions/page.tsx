"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Shell from "@/components/Shell";
import { formatUsd } from "@/lib/utils";
import { ArrowUpDown, ChevronRight } from "lucide-react";

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
  requires_confirmation: boolean;
  created_at: string;
  executed_at: string | null;
  pool: string | null;
}

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

type SortKey = "symbol" | "score_total" | "state" | "ts";

export default function DecisionsPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [scores, setScores] = useState<Score[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("score_total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      setLoading(false);
    });
  }, [router, supabase]);

  useEffect(() => {
    if (loading) return;
    async function load() {
      const [decRes, scoresRes] = await Promise.all([
        supabase.from("decisions").select("*").order("created_at", { ascending: false }).limit(200),
        supabase.from("scores").select("*").order("ts", { ascending: false }).limit(200),
      ]);
      if (decRes.data) setDecisions(decRes.data as Decision[]);
      if (scoresRes.data) {
        // Último score por símbolo
        const seen = new Set<string>();
        const unique: Score[] = [];
        for (const s of scoresRes.data as Score[]) {
          if (!seen.has(s.symbol)) { seen.add(s.symbol); unique.push(s); }
        }
        setScores(unique);
      }
    }
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [supabase, loading]);

  const sortedScores = useMemo(() => {
    const copy = [...scores];
    const dir = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      let av: any = (a as any)[sortKey];
      let bv: any = (b as any)[sortKey];
      if (sortKey === "ts") { av = new Date(av).getTime(); bv = new Date(bv).getTime(); }
      if (av == null) return 1; if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return copy;
  }, [scores, sortKey, sortDir]);

  if (loading) return null;

  const filtered = filter === "all" ? decisions : decisions.filter((d) => d.status === filter);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  return (
    <Shell current="decisions">
      <div className="space-y-6">

        {/* TABLA DE SCORES */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">// Último scoring por activo</h2>
            <span className="text-[10px] text-zinc-600">click un símbolo para ver su historial</span>
          </div>

          {sortedScores.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin scores todavía.</div>
          ) : (
            <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <ThSort label="Símbolo" active={sortKey === "symbol"} dir={sortDir} onClick={() => toggleSort("symbol")} align="left" />
                    <th className="text-left px-3 py-2">Pool</th>
                    <ThSort label="Score" active={sortKey === "score_total"} dir={sortDir} onClick={() => toggleSort("score_total")} align="right" />
                    <th className="text-right px-2 py-2">Tech</th>
                    <th className="text-right px-2 py-2">Fund</th>
                    <th className="text-right px-2 py-2">Sent</th>
                    <th className="text-right px-2 py-2">Risk</th>
                    <th className="text-right px-2 py-2">Time</th>
                    <ThSort label="State" active={sortKey === "state"} dir={sortDir} onClick={() => toggleSort("state")} align="center" />
                    <th className="text-center px-2 py-2">HC</th>
                    <th className="text-center px-2 py-2">Align</th>
                    <ThSort label="Actualizado" active={sortKey === "ts"} dir={sortDir} onClick={() => toggleSort("ts")} align="right" />
                    <th className="w-6"></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedScores.map((s) => (
                    <tr key={s.symbol}
                      onClick={() => router.push(`/decisions/${encodeURIComponent(s.symbol)}`)}
                      className="border-b border-zinc-900 hover:bg-zinc-900/40 cursor-pointer">
                      <td className="px-3 py-2 text-zinc-100 font-medium">{s.symbol}</td>
                      <td className="px-3 py-2 text-[10px] uppercase text-zinc-500">{s.pool || "—"}</td>
                      <td className={`px-3 py-2 text-right tabular-nums text-sm ${scoreColor(s.score_total)}`}>{s.score_total.toFixed(1)}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${componentColor(s.score_technical)}`}>{fmt(s.score_technical)}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${componentColor(s.score_fundamental)}`}>{fmt(s.score_fundamental)}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${componentColor(s.score_sentiment)}`}>{fmt(s.score_sentiment)}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${componentColor(s.score_risk)}`}>{fmt(s.score_risk)}</td>
                      <td className={`px-2 py-2 text-right tabular-nums ${componentColor(s.score_timing)}`}>{fmt(s.score_timing)}</td>
                      <td className="px-2 py-2 text-center">
                        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 border ${stateBadge(s.state)}`}>{s.state}</span>
                      </td>
                      <td className="px-2 py-2 text-center text-[10px]">
                        {s.passes_high_confidence ? <span className="text-emerald-400">PASS</span> : <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="px-2 py-2 text-center text-zinc-400 tabular-nums">{s.indicators_aligned ?? 0}</td>
                      <td className="px-3 py-2 text-right text-[10px] text-zinc-500 tabular-nums">{relativeTime(s.ts)}</td>
                      <td className="px-2 text-zinc-700"><ChevronRight className="w-3 h-3" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* TABLA DE DECISIONES */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">// Decisiones recientes ({filtered.length})</h2>
            <div className="flex gap-1">
              {["all", "pending", "executed", "rejected", "canceled"].map((f) => (
                <button key={f} onClick={() => setFilter(f)}
                  className={`text-[10px] uppercase tracking-wider px-2 py-1 border ${filter === f ? "border-lime-500 text-lime-400 bg-lime-950/30" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}>
                  {f}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin decisiones en este filtro.</div>
          ) : (
            <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="text-left px-3 py-2">Timestamp</th>
                    <th className="text-left px-3 py-2">Símbolo</th>
                    <th className="text-left px-3 py-2">Pool</th>
                    <th className="text-center px-2 py-2">Acción</th>
                    <th className="text-center px-2 py-2">Status</th>
                    <th className="text-right px-2 py-2">Score</th>
                    <th className="text-right px-2 py-2">Entry</th>
                    <th className="text-right px-2 py-2">Stop</th>
                    <th className="text-right px-2 py-2">Target</th>
                    <th className="text-right px-2 py-2">Size</th>
                    <th className="text-left px-3 py-2">Justificación / motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.id}
                      onClick={() => router.push(`/decisions/${encodeURIComponent(d.symbol)}`)}
                      className="border-b border-zinc-900 hover:bg-zinc-900/40 cursor-pointer align-top">
                      <td className="px-3 py-2 text-[10px] text-zinc-500 tabular-nums whitespace-nowrap">{new Date(d.created_at).toLocaleString()}</td>
                      <td className="px-3 py-2 text-zinc-100 font-medium">{d.symbol}</td>
                      <td className="px-3 py-2 text-[10px] uppercase text-zinc-500">{d.pool || "—"}</td>
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
                      <td className="px-3 py-2 text-zinc-400 max-w-[320px]">
                        <div className="truncate" title={d.justification || d.rejected_reason || ""}>
                          {d.rejected_reason && <span className="text-red-400">✗ {d.rejected_reason} · </span>}
                          {d.justification || "—"}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </div>
    </Shell>
  );
}

// --- helpers ---

function ThSort({ label, active, dir, onClick, align }: { label: string; active: boolean; dir: "asc" | "desc"; onClick: () => void; align: "left" | "right" | "center" }) {
  const alignCls = { left: "text-left", right: "text-right", center: "text-center" }[align];
  return (
    <th className={`${alignCls} px-3 py-2 cursor-pointer select-none hover:text-zinc-300`} onClick={onClick}>
      <span className={`inline-flex items-center gap-1 ${active ? "text-lime-400" : ""}`}>
        {label}
        <ArrowUpDown className="w-3 h-3 opacity-60" />
        {active && <span className="text-[8px]">{dir === "asc" ? "↑" : "↓"}</span>}
      </span>
    </th>
  );
}

function fmt(v: number | null): string {
  return v == null ? "—" : v.toFixed(0);
}

function scoreColor(score: number): string {
  if (score >= 85) return "text-lime-400";
  if (score >= 75) return "text-emerald-400";
  if (score >= 60) return "text-amber-400";
  return "text-zinc-500";
}

function componentColor(v: number | null): string {
  const n = v ?? 0;
  if (n >= 75) return "text-emerald-400";
  if (n >= 60) return "text-amber-400";
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

function relativeTime(ts: string): string {
  const diffMs = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
