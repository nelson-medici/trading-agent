"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import { formatUsd } from "@/lib/utils";

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
  confidence_checks: any;
  indicators_aligned: number | null;
  ts: string;
}

export default function DecisionsPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [scores, setScores] = useState<Score[]>([]);
  const [filter, setFilter] = useState<string>("all");

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
        supabase.from("decisions").select("*").order("created_at", { ascending: false }).limit(100),
        supabase.from("scores").select("*").order("ts", { ascending: false }).limit(20),
      ]);
      if (decRes.data) setDecisions(decRes.data as Decision[]);
      if (scoresRes.data) {
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

  if (loading) return null;

  const filtered = filter === "all" ? decisions : decisions.filter((d) => d.status === filter);

  return (
    <Shell current="decisions">
      <div className="space-y-6">
        {/* Último scoring por activo */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Último scoring (por activo)</h2>
          {scores.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin scores todavía.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {scores.map((s) => (
                <ScoreCard key={s.symbol} score={s} />
              ))}
            </div>
          )}
        </section>

        {/* Filtro de decisiones */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">// Decisiones ({filtered.length})</h2>
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
            <div className="space-y-2">
              {filtered.map((d) => <DecisionCard key={d.id} decision={d} />)}
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}

function ScoreCard({ score }: { score: Score }) {
  const stateBadge = {
    ENTERED: "bg-lime-950 text-lime-400 border-lime-900",
    CANDIDATE: "bg-emerald-950 text-emerald-400 border-emerald-900",
    WATCHLIST: "bg-amber-950 text-amber-400 border-amber-900",
    EXIT: "bg-red-950 text-red-400 border-red-900",
    IGNORE: "bg-zinc-900 text-zinc-500 border-zinc-800",
  }[score.state] || "bg-zinc-900 text-zinc-500 border-zinc-800";

  const checks = score.confidence_checks || {};

  return (
    <div className="border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-lg text-zinc-100 font-medium">{score.symbol}</div>
          <div className="text-[10px] text-zinc-600">{new Date(score.ts).toLocaleString()}</div>
        </div>
        <div className="text-right">
          <div className={`text-3xl font-light ${score.score_total >= 85 ? "text-lime-400" : score.score_total >= 75 ? "text-emerald-400" : score.score_total >= 60 ? "text-amber-400" : "text-zinc-500"}`}>
            {score.score_total.toFixed(1)}
          </div>
          <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 border ${stateBadge}`}>{score.state}</span>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-1 text-[10px] mb-3">
        <Component label="Tech" value={score.score_technical} />
        <Component label="Fund" value={score.score_fundamental} />
        <Component label="Sent" value={score.score_sentiment} />
        <Component label="Risk" value={score.score_risk} />
        <Component label="Time" value={score.score_timing} />
      </div>

      <div className="text-[10px] text-zinc-500">
        <div className="mb-1">High-confidence check: {score.passes_high_confidence ? <span className="text-emerald-400">PASS</span> : <span className="text-zinc-500">NO</span>} · {score.indicators_aligned ?? 0} indicadores alineados</div>
        {Object.keys(checks).length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {Object.entries(checks).map(([k, v]: any) => (
              <span key={k} className={`px-1.5 py-0.5 border text-[9px] ${v ? "border-emerald-900 text-emerald-400" : "border-zinc-800 text-zinc-600"}`}>
                {v ? "✓" : "✗"} {k}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Component({ label, value }: { label: string; value: number | null }) {
  const v = value ?? 0;
  const color = v >= 75 ? "text-emerald-400" : v >= 60 ? "text-amber-400" : "text-zinc-500";
  return (
    <div className="border border-zinc-900 p-2">
      <div className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</div>
      <div className={`text-sm tabular-nums ${color}`}>{v.toFixed(0)}</div>
    </div>
  );
}

function DecisionCard({ decision }: { decision: Decision }) {
  const statusColor = {
    pending: "text-amber-400 border-amber-900 bg-amber-950/20",
    approved: "text-emerald-400 border-emerald-900 bg-emerald-950/20",
    executed: "text-lime-400 border-lime-900 bg-lime-950/20",
    rejected: "text-red-400 border-red-900 bg-red-950/20",
    canceled: "text-zinc-500 border-zinc-800 bg-zinc-900/20",
  }[decision.status] || "text-zinc-500 border-zinc-800";

  return (
    <div className={`border p-3 ${statusColor}`}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <span className="text-zinc-100 font-medium">{decision.symbol}</span>
          <span className="ml-2 text-[10px] uppercase tracking-wider text-zinc-400">{decision.action}</span>
          <span className="ml-2 text-[10px] uppercase tracking-wider">· {decision.status}</span>
        </div>
        <div className="text-[10px] text-zinc-500">{new Date(decision.created_at).toLocaleString()}</div>
      </div>

      {decision.justification && (
        <div className="text-xs text-zinc-300 mb-2">{decision.justification}</div>
      )}

      {decision.rejected_reason && (
        <div className="text-xs text-red-400 mb-2">Rechazada: {decision.rejected_reason}</div>
      )}

      <div className="grid grid-cols-5 gap-2 text-[11px] text-zinc-400">
        {decision.score != null && <div>Score: <span className="text-zinc-100">{decision.score.toFixed(1)}</span></div>}
        {decision.entry_price != null && <div>Entry: <span className="text-zinc-100">${decision.entry_price.toFixed(2)}</span></div>}
        {decision.stop_price != null && <div>Stop: <span className="text-red-400">${decision.stop_price.toFixed(2)}</span></div>}
        {decision.target_price != null && <div>Target: <span className="text-emerald-400">${decision.target_price.toFixed(2)}</span></div>}
        {decision.notional_usd != null && <div>Size: <span className="text-zinc-100">{formatUsd(decision.notional_usd)}</span></div>}
      </div>
    </div>
  );
}
