"use client";
import { useEffect, useMemo, useState } from "react";
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
  pool: string;
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
  pool: string;
  strategy_name: string | null;
}

interface Equity {
  pool: string;
  ts: string;
  total_equity_usd: number;
  cash_usd: number;
  positions_value_usd: number;
  unrealized_pnl_usd: number | null;
  daily_pnl_pct: number | null;
  drawdown_from_hwm_pct: number | null;
  high_water_mark: number | null;
}

type PoolFilter = "all" | string;

export default function PortfolioPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [positions, setPositions] = useState<Position[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [equity, setEquity] = useState<Equity[]>([]);
  const [selectedPool, setSelectedPool] = useState<PoolFilter>("all");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      setLoading(false);
    });
  }, [router, supabase]);

  useEffect(() => {
    if (loading) return;
    async function load() {
      const [posRes, tradesRes, eqRes] = await Promise.all([
        supabase.from("positions").select("*"),
        supabase.from("trades").select("*").order("exit_at", { ascending: false }).limit(200),
        // Pedir muchos para capturar snapshots de todos los pools recientes
        supabase.from("equity_snapshots").select("*").order("ts", { ascending: false }).limit(500),
      ]);
      if (posRes.data) setPositions(posRes.data as Position[]);
      if (tradesRes.data) setTrades(tradesRes.data as Trade[]);
      if (eqRes.data) setEquity(eqRes.data as Equity[]);
    }
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [supabase, loading]);

  // Último snapshot POR POOL (no por pool y ts; una fila por pool)
  const latestByPool = useMemo(() => {
    const map = new Map<string, Equity>();
    for (const e of equity) {
      if (!map.has(e.pool)) map.set(e.pool, e); // primera aparición = más reciente (orden desc)
    }
    return Array.from(map.values()).sort((a, b) => a.pool.localeCompare(b.pool));
  }, [equity]);

  const pools = useMemo(() => latestByPool.map((e) => e.pool), [latestByPool]);

  // Agregado para el pool seleccionado (o todos)
  const aggregate = useMemo(() => {
    const pool_snapshots = selectedPool === "all" ? latestByPool : latestByPool.filter((e) => e.pool === selectedPool);
    const total_equity = pool_snapshots.reduce((s, e) => s + e.total_equity_usd, 0);
    const cash = pool_snapshots.reduce((s, e) => s + e.cash_usd, 0);
    const positions_value = pool_snapshots.reduce((s, e) => s + e.positions_value_usd, 0);
    const unrealized = pool_snapshots.reduce((s, e) => s + (e.unrealized_pnl_usd ?? 0), 0);
    // DD: cuando es "all" mostramos el peor; cuando es un pool específico el de ese pool
    const dd = selectedPool === "all"
      ? Math.max(0, ...pool_snapshots.map((e) => e.drawdown_from_hwm_pct ?? 0))
      : pool_snapshots[0]?.drawdown_from_hwm_pct ?? 0;
    return { total_equity, cash, positions_value, unrealized, dd };
  }, [latestByPool, selectedPool]);

  // Filtros por pool para posiciones y trades
  const filteredPositions = useMemo(() =>
    selectedPool === "all" ? positions : positions.filter((p) => p.pool === selectedPool)
  , [positions, selectedPool]);

  const filteredTrades = useMemo(() =>
    selectedPool === "all" ? trades : trades.filter((t) => t.pool === selectedPool)
  , [trades, selectedPool]);

  // Performance por pool (30d) desde los trades filtrados
  const perf = useMemo(() => {
    const since = Date.now() - 30 * 24 * 3600_000;
    const last30 = filteredTrades.filter((t) => new Date(t.exit_at).getTime() >= since);
    const n = last30.length;
    const wins = last30.filter((t) => t.pnl_usd > 0);
    const losses = last30.filter((t) => t.pnl_usd < 0);
    const totalPnl = last30.reduce((s, t) => s + t.pnl_usd, 0);
    const winRate = n > 0 ? wins.length / n : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl_usd, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl_usd, 0) / losses.length : 0;
    const pf = Math.abs(avgLoss * losses.length) > 0 ? (avgWin * wins.length) / Math.abs(avgLoss * losses.length) : 0;
    return { n, wins: wins.length, losses: losses.length, totalPnl, winRate, avgWin, avgLoss, pf };
  }, [filteredTrades]);

  if (loading) return null;

  return (
    <Shell current="portfolio">
      <div className="space-y-6">

        {/* Selector de pool */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 mr-2">Pool:</span>
          <PoolButton active={selectedPool === "all"} onClick={() => setSelectedPool("all")}>Todos</PoolButton>
          {pools.map((p) => (
            <PoolButton key={p} active={selectedPool === p} onClick={() => setSelectedPool(p)}>{p}</PoolButton>
          ))}
        </div>

        {/* Breakdown por pool — SIEMPRE visible */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Equity por pool</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {latestByPool.map((e) => (
              <PoolCard key={e.pool} snapshot={e}
                active={selectedPool === e.pool}
                onClick={() => setSelectedPool(selectedPool === e.pool ? "all" : e.pool)} />
            ))}
            {/* Card de total */}
            <div className={`border p-3 cursor-pointer transition-colors ${selectedPool === "all" ? "border-lime-500 bg-lime-950/20" : "border-zinc-700 bg-zinc-900/40 hover:border-zinc-500"}`}
              onClick={() => setSelectedPool("all")}>
              <div className="text-[10px] uppercase tracking-wider text-zinc-400">Σ TODOS</div>
              <div className="mt-1 text-xl font-light tabular-nums text-lime-400">{formatUsd(latestByPool.reduce((s, e) => s + e.total_equity_usd, 0))}</div>
              <div className="text-[10px] text-zinc-500 mt-1">{latestByPool.length} pools</div>
            </div>
          </div>
        </section>

        {/* Métricas globales (del pool seleccionado) */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
              // {selectedPool === "all" ? "Agregado de todos los pools" : `Pool: ${selectedPool}`}
            </h2>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Metric label="Equity" value={formatUsd(aggregate.total_equity)} tone="accent" />
            <Metric label="Cash disponible" value={formatUsd(aggregate.cash)} />
            <Metric label="En posiciones" value={formatUsd(aggregate.positions_value)}
              sub={`${aggregate.total_equity > 0 ? ((aggregate.positions_value / aggregate.total_equity) * 100).toFixed(1) : 0}% del equity`} />
            <Metric label="PnL no realizado" value={formatUsd(aggregate.unrealized)} tone={aggregate.unrealized >= 0 ? "success" : "danger"} />
          </div>
          <div className="mt-2 text-[10px] text-zinc-600">
            Drawdown desde HWM: <span className={(aggregate.dd ?? 0) > 0.08 ? "text-amber-400" : "text-zinc-400"}>{formatPct(aggregate.dd ?? 0)}</span>
          </div>
        </section>

        {/* Performance 30d */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Performance (30 días{selectedPool !== "all" ? ` · ${selectedPool}` : ""})</h2>
          {perf.n > 0 ? (
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
              <Metric label="Trades" value={perf.n} />
              <Metric label="Win rate" value={formatPct(perf.winRate)} tone={perf.winRate >= 0.5 ? "success" : "warn"} />
              <Metric label="PnL total" value={formatUsd(perf.totalPnl)} tone={perf.totalPnl >= 0 ? "success" : "danger"} />
              <Metric label="Avg win" value={formatUsd(perf.avgWin)} tone="success" />
              <Metric label="Avg loss" value={formatUsd(perf.avgLoss)} tone="danger" />
              <Metric label="Profit factor" value={perf.pf.toFixed(2)} tone={perf.pf >= 1.5 ? "success" : perf.pf >= 1 ? "warn" : "danger"} />
            </div>
          ) : (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin trades cerrados en los últimos 30 días para este pool.</div>
          )}
        </section>

        {/* Posiciones */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Posiciones abiertas ({filteredPositions.length})</h2>
          {filteredPositions.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">No hay posiciones abiertas en este pool.</div>
          ) : (
            <Table headers={["Symbol", "Pool", "Side", "Size", "Entry", "Current", "Stop", "Target", "PnL $", "PnL %", "Score", "Opened"]}>
              {filteredPositions.map((p) => {
                const pnlPos = (p.unrealized_pnl_usd ?? 0) >= 0;
                return (
                  <tr key={p.id} className="border-b border-zinc-900">
                    <td className="px-3 py-2 text-zinc-100 font-medium">{p.symbol}</td>
                    <td className="px-3 py-2 text-[10px] uppercase text-zinc-500">{p.pool}</td>
                    <td className="px-3 py-2 text-zinc-400">{p.side}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.size_units.toFixed(6)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">${p.entry_price.toFixed(4)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">${(p.current_price ?? p.entry_price).toFixed(4)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-400">${p.stop_price.toFixed(4)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-400">${p.target_price.toFixed(4)}</td>
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
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Historial de trades ({filteredTrades.length})</h2>
          {filteredTrades.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin trades cerrados en este pool.</div>
          ) : (
            <Table headers={["Symbol", "Pool", "Strategy", "Entry", "Exit", "PnL $", "PnL %", "Reason", "Hold (h)", "Closed"]}>
              {filteredTrades.slice(0, 50).map((t) => {
                const pnlPos = t.pnl_usd >= 0;
                return (
                  <tr key={t.id} className="border-b border-zinc-900">
                    <td className="px-3 py-2 text-zinc-100 font-medium">{t.symbol}</td>
                    <td className="px-3 py-2 text-[10px] uppercase text-zinc-500">{t.pool}</td>
                    <td className="px-3 py-2 text-[10px] text-zinc-400">{t.strategy_name || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">${t.entry_price.toFixed(4)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">${t.exit_price.toFixed(4)}</td>
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
          {filteredTrades.length > 50 && (
            <div className="mt-2 text-[10px] text-zinc-600">Mostrando 50 de {filteredTrades.length} · ver todos en /history</div>
          )}
        </section>

      </div>
    </Shell>
  );
}

function PoolButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`text-[11px] uppercase tracking-wider px-3 py-1.5 border transition-colors ${active ? "border-lime-500 text-lime-400 bg-lime-950/30" : "border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:border-zinc-600"}`}>
      {children}
    </button>
  );
}

function PoolCard({ snapshot, active, onClick }: { snapshot: Equity; active: boolean; onClick: () => void }) {
  const unreal = snapshot.unrealized_pnl_usd ?? 0;
  const unrealColor = unreal > 0 ? "text-emerald-400" : unreal < 0 ? "text-red-400" : "text-zinc-500";
  return (
    <div onClick={onClick}
      className={`border p-3 cursor-pointer transition-colors ${active ? "border-lime-500 bg-lime-950/20" : "border-zinc-800 bg-zinc-950 hover:border-zinc-600"}`}>
      <div className="flex items-start justify-between">
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-400">{snapshot.pool}</div>
        <div className="text-[9px] text-zinc-600">{new Date(snapshot.ts).toLocaleTimeString()}</div>
      </div>
      <div className="mt-1 text-xl font-light tabular-nums text-zinc-100">{formatUsd(snapshot.total_equity_usd)}</div>
      <div className="mt-1 flex items-center justify-between text-[10px]">
        <span className="text-zinc-500">cash {formatUsd(snapshot.cash_usd)}</span>
        <span className={unrealColor}>unr {formatUsd(unreal)}</span>
      </div>
    </div>
  );
}

function Metric({ label, value, tone = "neutral", sub }: { label: string; value: any; tone?: string; sub?: string }) {
  const color = { neutral: "text-zinc-100", accent: "text-lime-400", success: "text-emerald-400", warn: "text-amber-400", danger: "text-red-400" }[tone] || "text-zinc-100";
  return (
    <div className="border border-zinc-800 bg-zinc-950 p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      <div className={`mt-2 text-xl font-light tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-zinc-600 mt-1">{sub}</div>}
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
