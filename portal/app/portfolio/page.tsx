"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import { formatUsd, formatPct } from "@/lib/utils";

interface Position {
  id: string;
  symbol: string;
  side: string;
  size_units: number;
  entry_price: number;
  current_price: number | null;
  stop_price: number;
  target_price: number;
  unrealized_pnl_usd: number | null;
  unrealized_pnl_pct: number | null;
  allocation_pct: number | null;
  score_at_entry: number | null;
  current_score: number | null;
  opened_at: string;
}

interface Trade {
  id: string;
  symbol: string;
  side: string;
  size_units: number;
  entry_price: number;
  exit_price: number;
  pnl_usd: number;
  pnl_pct: number;
  commission_usd: number | null;
  exit_reason: string | null;
  hold_hours: number | null;
  entry_at: string;
  exit_at: string;
}

interface Equity {
  ts: string;
  total_equity_usd: number;
  cash_usd: number;
  positions_value_usd: number;
  unrealized_pnl_usd: number | null;
  daily_pnl_pct: number | null;
  drawdown_from_hwm_pct: number | null;
  high_water_mark: number | null;
}

interface Perf {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  total_pnl_usd: number;
  avg_win_usd: number;
  avg_loss_usd: number;
  profit_factor: number;
  avg_hold_hours: number;
}

export default function PortfolioPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [positions, setPositions] = useState<Position[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [equity, setEquity] = useState<Equity[]>([]);
  const [perf, setPerf] = useState<Perf | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      setLoading(false);
    });
  }, [router, supabase]);

  useEffect(() => {
    if (loading) return;
    async function load() {
      const [posRes, tradesRes, eqRes, perfRes] = await Promise.all([
        supabase.from("positions").select("*"),
        supabase.from("trades").select("*").order("exit_at", { ascending: false }).limit(50),
        supabase.from("equity_snapshots").select("*").order("ts", { ascending: false }).limit(100),
        supabase.from("v_performance_30d").select("*").single(),
      ]);
      if (posRes.data) setPositions(posRes.data as Position[]);
      if (tradesRes.data) setTrades(tradesRes.data as Trade[]);
      if (eqRes.data) setEquity((eqRes.data as Equity[]).reverse());
      if (perfRes.data) setPerf(perfRes.data as Perf);
    }
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [supabase, loading]);

  if (loading) return null;

  const latest = equity[equity.length - 1];
  const first = equity[0];
  const totalReturn = latest && first
    ? (latest.total_equity_usd - first.total_equity_usd) / first.total_equity_usd
    : 0;

  return (
    <Shell current="portfolio">
      <div className="space-y-6">
        {/* Métricas globales */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Metric label="Equity actual" value={latest ? formatUsd(latest.total_equity_usd) : "—"} tone="accent" />
          <Metric label="Cash disponible" value={latest ? formatUsd(latest.cash_usd) : "—"} />
          <Metric label="PnL no realizado" value={latest ? formatUsd(latest.unrealized_pnl_usd ?? 0) : "—"} tone={(latest?.unrealized_pnl_usd ?? 0) >= 0 ? "success" : "danger"} />
          <Metric label="DD desde HWM" value={latest ? formatPct(latest.drawdown_from_hwm_pct ?? 0) : "—"} tone={(latest?.drawdown_from_hwm_pct ?? 0) > 0.08 ? "warn" : "neutral"} />
        </div>

        {/* Performance 30d */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Performance (30 días)</h2>
          {perf && perf.total_trades > 0 ? (
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
              <Metric label="Trades" value={perf.total_trades} />
              <Metric label="Win rate" value={formatPct(perf.win_rate)} tone={perf.win_rate >= 0.5 ? "success" : "warn"} />
              <Metric label="PnL total" value={formatUsd(perf.total_pnl_usd)} tone={perf.total_pnl_usd >= 0 ? "success" : "danger"} />
              <Metric label="Avg win" value={formatUsd(perf.avg_win_usd)} tone="success" />
              <Metric label="Avg loss" value={formatUsd(perf.avg_loss_usd)} tone="danger" />
              <Metric label="Profit factor" value={perf.profit_factor.toFixed(2)} tone={perf.profit_factor >= 1.5 ? "success" : "warn"} />
            </div>
          ) : (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">
              Sin trades cerrados en los últimos 30 días.
            </div>
          )}
        </section>

        {/* Posiciones */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Posiciones abiertas ({positions.length})</h2>
          {positions.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">No hay posiciones abiertas.</div>
          ) : (
            <Table headers={["Symbol", "Side", "Size", "Entry", "Current", "Stop", "Target", "PnL $", "PnL %", "Score", "Opened"]}>
              {positions.map((p) => {
                const pnlPos = (p.unrealized_pnl_usd ?? 0) >= 0;
                return (
                  <tr key={p.id} className="border-b border-zinc-900">
                    <td className="px-3 py-2 text-zinc-100 font-medium">{p.symbol}</td>
                    <td className="px-3 py-2 text-zinc-400">{p.side}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.size_units.toFixed(6)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">${p.entry_price.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">${(p.current_price ?? p.entry_price).toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-400">${p.stop_price.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-400">${p.target_price.toFixed(2)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pnlPos ? "text-emerald-400" : "text-red-400"}`}>{formatUsd(p.unrealized_pnl_usd ?? 0)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pnlPos ? "text-emerald-400" : "text-red-400"}`}>{((p.unrealized_pnl_pct ?? 0) * 100).toFixed(2)}%</td>
                    <td className="px-3 py-2 text-right tabular-nums">{(p.current_score ?? 0).toFixed(1)}</td>
                    <td className="px-3 py-2 text-right text-zinc-500 text-[10px]">{new Date(p.opened_at).toLocaleString()}</td>
                  </tr>
                );
              })}
            </Table>
          )}
        </section>

        {/* Historial trades */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Historial de trades ({trades.length})</h2>
          {trades.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin trades cerrados aún.</div>
          ) : (
            <Table headers={["Symbol", "Entry", "Exit", "PnL $", "PnL %", "Reason", "Hold (h)", "Closed"]}>
              {trades.map((t) => {
                const pnlPos = t.pnl_usd >= 0;
                return (
                  <tr key={t.id} className="border-b border-zinc-900">
                    <td className="px-3 py-2 text-zinc-100 font-medium">{t.symbol}</td>
                    <td className="px-3 py-2 text-right tabular-nums">${t.entry_price.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">${t.exit_price.toFixed(2)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pnlPos ? "text-emerald-400" : "text-red-400"}`}>{formatUsd(t.pnl_usd)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${pnlPos ? "text-emerald-400" : "text-red-400"}`}>{(t.pnl_pct * 100).toFixed(2)}%</td>
                    <td className="px-3 py-2 text-zinc-400 uppercase text-[10px]">{t.exit_reason}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{(t.hold_hours ?? 0).toFixed(1)}</td>
                    <td className="px-3 py-2 text-right text-zinc-500 text-[10px]">{new Date(t.exit_at).toLocaleString()}</td>
                  </tr>
                );
              })}
            </Table>
          )}
        </section>

        <div className="text-[10px] text-zinc-600">Retorno acumulado (snapshot más antiguo → actual): {(totalReturn * 100).toFixed(2)}%</div>
      </div>
    </Shell>
  );
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: any; tone?: string }) {
  const color = { neutral: "text-zinc-100", accent: "text-lime-400", success: "text-emerald-400", warn: "text-amber-400", danger: "text-red-400" }[tone] || "text-zinc-100";
  return (
    <div className="border border-zinc-800 bg-zinc-950 p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      <div className={`mt-2 text-xl font-light tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
          <tr>{headers.map((h) => <th key={h} className={h.includes("$") || h.includes("%") || ["Size", "Entry", "Current", "Stop", "Target", "Score", "Hold (h)", "Trades"].includes(h) ? "text-right px-3 py-2" : "text-left px-3 py-2"}>{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
