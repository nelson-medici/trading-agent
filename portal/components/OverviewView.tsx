"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase";
import { formatUsd, formatPct } from "@/lib/utils";
import {
  Wallet, Gauge, TrendingUp, DollarSign,
  Layers, Brain, Timer, Bell, History,
  CandlestickChart, ArrowRight, AlertOctagon,
  AlertTriangle, ChevronRight,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

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
  state: string;
  passes_high_confidence: boolean | null;
  ts: string;
}

interface Position {
  symbol: string;
  size_units: number;
  entry_price: number;
  current_price: number | null;
  unrealized_pnl_usd: number | null;
  unrealized_pnl_pct: number | null;
  pool: string | null;
}

interface RecentTrade {
  symbol: string;
  pnl_usd: number;
  exit_reason: string;
  exit_at: string;
  pool: string | null;
}

interface ScalperSession {
  id: string;
  symbol: string;
  status: string;
  realized_pnl_usd: number;
  trades_count: number;
  wins: number;
  losses: number;
  duration_min: number;
  started_at: string | null;
  ended_at: string | null;
  auto: boolean;
}

interface AlertSummary {
  total: number;
  critical: number;
  warn: number;
  info: number;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function OverviewView() {
  const supabase = createClient();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [scores, setScores] = useState<Score[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [recentTrades, setRecentTrades] = useState<RecentTrade[]>([]);
  const [scalperSession, setScalperSession] = useState<ScalperSession | null>(null);
  const [alertSummary, setAlertSummary] = useState<AlertSummary>({ total: 0, critical: 0, warn: 0, info: 0 });

  useEffect(() => {
    async function load() {
      const [summaryRes, scoresRes, posRes, tradesRes, scalperRes, alertsRes] = await Promise.all([
        supabase.from("v_dashboard_summary").select("*").single(),
        supabase.from("scores").select("symbol, score_total, state, passes_high_confidence, ts").order("ts", { ascending: false }).limit(30),
        supabase.from("positions").select("symbol, size_units, entry_price, current_price, unrealized_pnl_usd, unrealized_pnl_pct, pool"),
        supabase.from("trades").select("symbol, pnl_usd, exit_reason, exit_at, pool").order("exit_at", { ascending: false }).limit(5),
        supabase.from("scalper_sessions").select("*").in("status", ["active", "requested"]).order("requested_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("alerts").select("id, level, acknowledged").eq("acknowledged", false),
      ]);

      if (summaryRes.data) setSummary(summaryRes.data as Summary);

      if (scoresRes.data) {
        const seen = new Set<string>();
        const unique: Score[] = [];
        for (const s of scoresRes.data as Score[]) {
          if (!seen.has(s.symbol)) { seen.add(s.symbol); unique.push(s); }
        }
        setScores(unique);
      }

      if (posRes.data) setPositions(posRes.data as Position[]);
      if (tradesRes.data) setRecentTrades(tradesRes.data as RecentTrade[]);
      if (scalperRes.data) setScalperSession(scalperRes.data as ScalperSession);
      else setScalperSession(null);

      if (alertsRes.data) {
        const list = alertsRes.data as { id: string; level: string; acknowledged: boolean }[];
        setAlertSummary({
          total: list.length,
          critical: list.filter((a) => a.level === "critical").length,
          warn: list.filter((a) => a.level === "warn").length,
          info: list.filter((a) => a.level === "info").length,
        });
      }
    }

    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [supabase]);

  if (!summary) {
    return <div className="text-zinc-500 text-xs">cargando...</div>;
  }

  /* ---- derived ---- */
  const topScores = scores.slice(0, 5);
  const topPositions = positions.slice(0, 4);
  const totalUnrealPnl = positions.reduce((s, p) => s + (p.unrealized_pnl_usd ?? 0), 0);
  const tradeWins = recentTrades.filter((t) => t.pnl_usd > 0).length;

  return (
    <div className="space-y-5">

      {/* Kill switch banner */}
      {summary.kill_active && (
        <Link href="/control"
          className="border border-red-800 bg-red-950/20 p-3 text-xs flex items-center justify-between group hover:border-red-600 transition-colors">
          <div>
            <div className="text-red-300 uppercase tracking-wider text-[10px] mb-0.5">Kill switch ACTIVO</div>
            <div className="text-zinc-400">Sistema pausado. Revisá Control para reanudar.</div>
          </div>
          <ArrowRight className="w-4 h-4 text-red-400 group-hover:translate-x-0.5 transition-transform" />
        </Link>
      )}

      {/* KPIs principales */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Equity" value={summary.current_equity != null ? formatUsd(summary.current_equity) : "—"}
          sub={`HWM ${summary.hwm != null ? formatUsd(summary.hwm) : "—"}`} icon={Wallet} tone="accent" />
        <KpiCard label="Inversión" value={summary.total_invested != null ? formatUsd(summary.total_invested) : "—"}
          icon={DollarSign} />
        <KpiCard label="Ganancia"
          value={summary.total_gain != null ? formatUsd(summary.total_gain) : "—"}
          sub={summary.total_gain_pct != null ? `${(summary.total_gain_pct * 100).toFixed(2)}%` : undefined}
          tone={(summary.total_gain ?? 0) > 0 ? "success" : (summary.total_gain ?? 0) < 0 ? "danger" : "neutral"}
          icon={TrendingUp} />
        <KpiCard label="Drawdown" value={summary.current_dd != null ? formatPct(summary.current_dd) : "—"}
          tone={summary.current_dd && summary.current_dd > 0.08 ? "warn" : "neutral"} icon={Gauge} />
      </div>

      {/* Tarjetas navegables */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">

        {/* PORTAFOLIO */}
        <NavCard href="/portfolio" title="Portafolio" icon={Layers}
          badge={positions.length > 0 ? `${positions.length} abiertas` : undefined}>
          {positions.length === 0 ? (
            <div className="text-[11px] text-zinc-600">Sin posiciones abiertas.</div>
          ) : (
            <div className="space-y-1.5">
              {topPositions.map((p) => {
                const pnlPos = (p.unrealized_pnl_usd ?? 0) >= 0;
                return (
                  <div key={p.symbol} className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-200 font-medium">{p.symbol}</span>
                      {p.pool && <span className="text-[9px] text-zinc-600 uppercase">{p.pool}</span>}
                    </div>
                    <span className={`tabular-nums ${pnlPos ? "text-emerald-400" : "text-red-400"}`}>
                      {formatUsd(p.unrealized_pnl_usd ?? 0)}
                    </span>
                  </div>
                );
              })}
              {positions.length > 4 && (
                <div className="text-[10px] text-zinc-600">+{positions.length - 4} más</div>
              )}
              <div className="pt-1 border-t border-zinc-900 flex justify-between text-[10px]">
                <span className="text-zinc-500">PnL no realizado</span>
                <span className={`tabular-nums ${totalUnrealPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {formatUsd(totalUnrealPnl)}
                </span>
              </div>
            </div>
          )}
        </NavCard>

        {/* DECISIONES (scoring) */}
        <NavCard href="/decisions" title="Decisiones" icon={Brain}
          badge={`${summary.candidates ?? 0} candidatos`}>
          {topScores.length === 0 ? (
            <div className="text-[11px] text-zinc-600">Sin scores. Esperando ciclo del engine.</div>
          ) : (
            <div className="space-y-1.5">
              {topScores.map((s) => (
                <div key={s.symbol} className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-200 font-medium">{s.symbol}</span>
                    <StateBadge state={s.state} />
                  </div>
                  <span className={`tabular-nums font-medium ${scoreColor(s.score_total)}`}>
                    {s.score_total.toFixed(1)}
                  </span>
                </div>
              ))}
              {scores.length > 5 && (
                <div className="text-[10px] text-zinc-600">+{scores.length - 5} más</div>
              )}
            </div>
          )}
        </NavCard>

        {/* SCALPER */}
        <NavCard href="/scalper" title="Scalper" icon={Timer}
          badge={scalperSession ? (scalperSession.status === "active" ? "SESIÓN ACTIVA" : "ESPERANDO") : undefined}
          badgeTone={scalperSession?.status === "active" ? "success" : "warn"}>
          {scalperSession ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-zinc-200 font-medium">{scalperSession.symbol}</span>
                <span className={`text-[10px] uppercase tracking-wider ${scalperSession.status === "active" ? "text-lime-400" : "text-amber-400"}`}>
                  {scalperSession.status}
                </span>
              </div>
              {scalperSession.status === "active" && (
                <>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-zinc-500">PnL sesión</span>
                    <span className={`tabular-nums ${scalperSession.realized_pnl_usd >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {formatUsd(scalperSession.realized_pnl_usd)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-zinc-500">Trades</span>
                    <span className="text-zinc-300 tabular-nums">
                      {scalperSession.trades_count} ({scalperSession.wins}W/{scalperSession.losses}L)
                    </span>
                  </div>
                </>
              )}
              {scalperSession.auto && (
                <div className="text-[9px] text-violet-400 uppercase tracking-wider mt-1">auto-iniciada</div>
              )}
            </div>
          ) : (
            <div className="text-[11px] text-zinc-600">Sin sesión activa. El radar monitorea oportunidades.</div>
          )}
        </NavCard>

        {/* ALERTAS */}
        <NavCard href="/alerts" title="Alertas" icon={Bell}
          badge={alertSummary.total > 0 ? `${alertSummary.total} sin leer` : undefined}
          badgeTone={alertSummary.critical > 0 ? "danger" : alertSummary.warn > 0 ? "warn" : "violet"}>
          {alertSummary.total === 0 ? (
            <div className="text-[11px] text-zinc-600">Sin alertas pendientes.</div>
          ) : (
            <div className="flex items-center gap-4 text-[11px]">
              {alertSummary.critical > 0 && (
                <div className="flex items-center gap-1.5">
                  <AlertOctagon className="w-3 h-3 text-red-400" />
                  <span className="text-red-400 tabular-nums">{alertSummary.critical} críticas</span>
                </div>
              )}
              {alertSummary.warn > 0 && (
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3 text-amber-400" />
                  <span className="text-amber-400 tabular-nums">{alertSummary.warn} warn</span>
                </div>
              )}
              {alertSummary.info > 0 && (
                <span className="text-zinc-500 tabular-nums">{alertSummary.info} info</span>
              )}
            </div>
          )}
        </NavCard>

        {/* HISTÓRICO */}
        <NavCard href="/history" title="Histórico" icon={History}
          badge={recentTrades.length > 0 ? `últimos ${recentTrades.length}` : undefined}>
          {recentTrades.length === 0 ? (
            <div className="text-[11px] text-zinc-600">Sin trades cerrados aún.</div>
          ) : (
            <div className="space-y-1.5">
              {recentTrades.map((t, i) => (
                <div key={i} className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-200">{t.symbol}</span>
                    <span className="text-[9px] text-zinc-600 uppercase">{t.exit_reason}</span>
                  </div>
                  <span className={`tabular-nums ${t.pnl_usd >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {t.pnl_usd >= 0 ? "+" : ""}{formatUsd(t.pnl_usd)}
                  </span>
                </div>
              ))}
              {recentTrades.length > 0 && (
                <div className="pt-1 border-t border-zinc-900 flex justify-between text-[10px]">
                  <span className="text-zinc-500">Win rate (últimos {recentTrades.length})</span>
                  <span className="tabular-nums text-zinc-300">
                    {tradeWins}/{recentTrades.length} ({((tradeWins / recentTrades.length) * 100).toFixed(0)}%)
                  </span>
                </div>
              )}
            </div>
          )}
        </NavCard>

        {/* CHARTS */}
        <NavCard href="/charts" title="Charts" icon={CandlestickChart}>
          <div className="text-[11px] text-zinc-600">
            Gráficos de velas con indicadores técnicos.
          </div>
          {positions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {positions.slice(0, 3).map((p) => (
                <Link key={p.symbol} href={`/charts?symbol=${encodeURIComponent(p.symbol)}`}
                  className="text-[10px] border border-zinc-800 px-2 py-0.5 text-lime-400 hover:border-lime-700 transition-colors"
                  onClick={(e) => e.stopPropagation()}>
                  {p.symbol}
                </Link>
              ))}
            </div>
          )}
        </NavCard>

      </div>

      <div className="text-[10px] text-zinc-600">
        actualiza cada 15s
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function KpiCard({ label, value, sub, icon: Icon, tone = "neutral" }: {
  label: string; value: any; sub?: string; icon?: any; tone?: string;
}) {
  const color = {
    neutral: "text-zinc-100", accent: "text-lime-400", success: "text-emerald-400",
    warn: "text-amber-400", danger: "text-red-400",
  }[tone] || "text-zinc-100";

  return (
    <div className="border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-start justify-between">
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
        {Icon && <Icon className="w-3.5 h-3.5 text-zinc-700" />}
      </div>
      <div className={`mt-1.5 text-xl font-light tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-zinc-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function NavCard({ href, title, icon: Icon, badge, badgeTone = "neutral", children }: {
  href: string; title: string; icon: any; badge?: string; badgeTone?: string; children: React.ReactNode;
}) {
  const badgeColor = {
    neutral: "text-zinc-400 border-zinc-700",
    success: "text-lime-400 border-lime-800",
    warn: "text-amber-400 border-amber-800",
    danger: "text-red-400 border-red-800",
    violet: "text-violet-300 border-violet-800",
  }[badgeTone] || "text-zinc-400 border-zinc-700";

  return (
    <Link href={href}
      className="border border-zinc-800 bg-zinc-950 p-4 hover:border-zinc-600 transition-colors group flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
          <span className="text-[11px] uppercase tracking-[0.15em] text-zinc-300 group-hover:text-zinc-100 transition-colors">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {badge && (
            <span className={`text-[9px] uppercase tracking-wider border px-1.5 py-0.5 ${badgeColor}`}>
              {badge}
            </span>
          )}
          <ChevronRight className="w-3.5 h-3.5 text-zinc-700 group-hover:text-zinc-400 group-hover:translate-x-0.5 transition-all" />
        </div>
      </div>
      <div className="flex-1">{children}</div>
    </Link>
  );
}

function StateBadge({ state }: { state: string }) {
  const cls = {
    ENTERED: "bg-lime-950 text-lime-400 border-lime-900",
    CANDIDATE: "bg-emerald-950 text-emerald-400 border-emerald-900",
    WATCHLIST: "bg-amber-950 text-amber-400 border-amber-900",
    EXIT: "bg-red-950 text-red-400 border-red-900",
  }[state] || "bg-zinc-900 text-zinc-500 border-zinc-800";
  return <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 border ${cls}`}>{state}</span>;
}

function scoreColor(score: number): string {
  if (score >= 85) return "text-lime-400";
  if (score >= 75) return "text-emerald-400";
  if (score >= 60) return "text-amber-400";
  return "text-zinc-500";
}
