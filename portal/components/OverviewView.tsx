"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase";
import { formatUsd, formatPct } from "@/lib/utils";
import {
  Wallet, Gauge, TrendingUp, DollarSign,
  Layers, Brain, Timer, Bell, History,
  CandlestickChart, ArrowRight, AlertOctagon,
  AlertTriangle, ChevronRight, Target, Info, X,
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

interface Effectiveness {
  total_trades: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  total_pnl: number;
  avg_pnl: number;
  avg_win: number;
  avg_loss: number;
  reward_risk_ratio: number | null;
  profit_factor: number | null;
  expected_value: number;
  avg_hold_h: number;
  max_loss_streak: number;
}

interface ExitBreakdown {
  exit_reason: string;
  trades: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  total_pnl: number;
  avg_pnl: number;
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
  const [effectiveness, setEffectiveness] = useState<Effectiveness | null>(null);
  const [exitBreakdown, setExitBreakdown] = useState<ExitBreakdown[]>([]);
  const [diagOpen, setDiagOpen] = useState(false);

  useEffect(() => {
    async function load() {
      const [summaryRes, scoresRes, posRes, tradesRes, scalperRes, alertsRes, effRes, exitRes] = await Promise.all([
        supabase.from("v_dashboard_summary").select("*").single(),
        supabase.from("scores").select("symbol, score_total, state, passes_high_confidence, ts").order("ts", { ascending: false }).limit(30),
        supabase.from("positions").select("symbol, size_units, entry_price, current_price, unrealized_pnl_usd, unrealized_pnl_pct, pool"),
        supabase.from("trades").select("symbol, pnl_usd, exit_reason, exit_at, pool").order("exit_at", { ascending: false }).limit(5),
        supabase.from("scalper_sessions").select("*").in("status", ["active", "requested"]).order("requested_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("alerts").select("id, level, acknowledged").eq("acknowledged", false),
        supabase.from("v_effectiveness_summary").select("*").maybeSingle(),
        supabase.from("v_effectiveness_by_exit_reason").select("*"),
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
      if (effRes.data) setEffectiveness(effRes.data as Effectiveness);
      if (exitRes.data) setExitBreakdown(exitRes.data as ExitBreakdown[]);
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

      {/* EFECTIVIDAD — debajo de equity */}
      <div className="border border-zinc-800 bg-zinc-950 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <Target className="w-4 h-4 text-zinc-500 flex-shrink-0" />
            <span className="text-[11px] uppercase tracking-[0.15em] text-zinc-300 flex-shrink-0">Efectividad · 30d</span>
            {/* CTA diagnóstico */}
            {effectiveness && effectiveness.total_trades > 0 && (
              <div className="relative flex-shrink-0">
                <button onClick={() => setDiagOpen(!diagOpen)}
                  className="flex items-center gap-1 border border-sky-800 bg-sky-950/20 px-2 py-0.5 text-[9px] uppercase tracking-wider text-sky-300 hover:bg-sky-950/40 transition-colors">
                  <Info className="w-3 h-3" /> diagnóstico
                </button>
                {diagOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setDiagOpen(false)} />
                    <div className="absolute left-0 top-full mt-1 bg-zinc-950 border border-sky-800/50 w-[min(420px,calc(100vw-2rem))] z-50 shadow-2xl">
                      <div className="px-3 py-2 border-b border-sky-900/30 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-sky-300">
                          <Info className="w-3 h-3" /> diagnóstico automático
                        </div>
                        <button onClick={() => setDiagOpen(false)} className="text-zinc-500 hover:text-zinc-300">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="p-3">
                        <EffectivenessDiagnosis eff={effectiveness} exits={exitBreakdown} />
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            {/* Salidas inline */}
            {exitBreakdown.length > 0 && (
              <div className="flex items-center gap-1.5 ml-2 overflow-x-auto flex-shrink min-w-0">
                <span className="text-[9px] uppercase tracking-wider text-zinc-600 flex-shrink-0">salidas</span>
                {exitBreakdown.map((e) => (
                  <span key={e.exit_reason}
                    className="flex items-center gap-1 text-[10px] border border-zinc-800 px-1.5 py-0.5 whitespace-nowrap flex-shrink-0">
                    <span className="text-zinc-400 uppercase">{humanizeExit(e.exit_reason)}</span>
                    <span className="text-zinc-500 tabular-nums">{e.trades}</span>
                    <span className={`tabular-nums ${e.total_pnl >= 0 ? "text-emerald-400/70" : "text-red-400/70"}`}>
                      {e.total_pnl >= 0 ? "+" : ""}{e.total_pnl.toFixed(2)}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
          <Link href="/history" className="text-[10px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1 flex-shrink-0 ml-2">
            trades <ChevronRight className="w-3 h-3" />
          </Link>
        </div>

        {!effectiveness || effectiveness.total_trades === 0 ? (
          <div className="text-[11px] text-zinc-600">Sin trades cerrados en los últimos 30 días.</div>
        ) : (
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
            <MiniKpi label="Win Rate" value={`${effectiveness.win_rate_pct}%`}
              tone={effectiveness.win_rate_pct >= 50 ? "success" : effectiveness.win_rate_pct >= 35 ? "warn" : "danger"} />
            <MiniKpi label="Trades" value={`${effectiveness.wins}W / ${effectiveness.losses}L`} />
            <MiniKpi label="Profit Factor"
              value={effectiveness.profit_factor != null ? effectiveness.profit_factor.toFixed(2) : "—"}
              tone={effectiveness.profit_factor != null ? (effectiveness.profit_factor >= 1.5 ? "success" : effectiveness.profit_factor >= 1 ? "warn" : "danger") : "neutral"} />
            <MiniKpi label="R:R Real"
              value={effectiveness.reward_risk_ratio != null ? effectiveness.reward_risk_ratio.toFixed(2) : "—"}
              tone={effectiveness.reward_risk_ratio != null && effectiveness.reward_risk_ratio >= 1.5 ? "success" : "neutral"} />
            <MiniKpi label="EV / Trade"
              value={formatUsd(effectiveness.expected_value)}
              tone={effectiveness.expected_value > 0 ? "success" : effectiveness.expected_value < 0 ? "danger" : "neutral"} />
            <MiniKpi label="Racha pérdidas" value={`${effectiveness.max_loss_streak}`}
              tone={effectiveness.max_loss_streak >= 4 ? "danger" : effectiveness.max_loss_streak >= 3 ? "warn" : "neutral"} />
          </div>
        )}
      </div>

      {/* Tarjetas navegables — fila 1: Portfolio, Scalper, Alertas */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

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

      </div>

      {/* Tarjetas navegables — fila 2: Decisiones, Histórico, Charts */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

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

function MiniKpi({ label, value, tone = "neutral" }: { label: string; value: any; tone?: string }) {
  const color = {
    neutral: "text-zinc-200", success: "text-emerald-400", warn: "text-amber-400", danger: "text-red-400",
  }[tone] || "text-zinc-200";
  return (
    <div className="bg-zinc-900/50 px-2.5 py-2 border border-zinc-900">
      <div className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</div>
      <div className={`text-sm tabular-nums font-mono mt-0.5 ${color}`}>{value}</div>
    </div>
  );
}

function humanizeExit(reason: string): string {
  const map: Record<string, string> = {
    stop: "Stop", target: "Target", score_broken: "Score roto", rotation: "Rotación",
    manual: "Manual", time_stop: "Time stop", trailing_stop: "Trailing",
    breakeven_stop: "Breakeven", session_end: "Fin sesión",
  };
  return map[reason] || reason;
}

function EffectivenessDiagnosis({ eff, exits }: { eff: Effectiveness; exits: ExitBreakdown[] }) {
  const issues: string[] = [];

  // Diagnósticos automáticos basados en las métricas
  if (eff.win_rate_pct < 35) {
    issues.push("Win rate muy bajo (<35%): las señales de entrada no están alineadas con el movimiento real del precio. Considerá subir el threshold de candidato o agregar filtros.");
  } else if (eff.win_rate_pct < 50 && (eff.reward_risk_ratio == null || eff.reward_risk_ratio < 2)) {
    issues.push("Win rate bajo con R:R insuficiente: necesitás que las ganadoras compensen más, o mejorar la selección de entrada.");
  }

  const stopTrades = exits.find((e) => e.exit_reason === "stop");
  const targetTrades = exits.find((e) => e.exit_reason === "target");
  if (stopTrades && targetTrades && stopTrades.trades > targetTrades.trades * 2) {
    issues.push(`Stops duplican targets (${stopTrades.trades} vs ${targetTrades.trades}): el stop puede estar demasiado apretado o la entrada se da en zonas de alta reversión.`);
  }

  if (eff.max_loss_streak >= 4) {
    issues.push(`Racha de ${eff.max_loss_streak} pérdidas seguidas: puede indicar que el sistema operó en un régimen desfavorable sin detenerse a tiempo.`);
  }

  if (eff.profit_factor != null && eff.profit_factor < 1) {
    issues.push(`Profit factor ${eff.profit_factor} (<1): las pérdidas superan las ganancias en volumen. El sistema no tiene ventaja estadística en este período.`);
  }

  if (eff.expected_value < 0) {
    issues.push(`Expected value negativo (${formatUsd(eff.expected_value)} / trade): en promedio cada trade pierde plata. Revisar señales o pausar hasta recalibrar.`);
  }

  if (issues.length === 0) return null;

  return (
    <div className="border border-amber-900/40 bg-amber-950/10 p-3">
      <div className="text-[10px] uppercase tracking-wider text-amber-400/80 mb-1.5">Diagnóstico</div>
      <div className="space-y-1.5">
        {issues.map((issue, i) => (
          <div key={i} className="text-[11px] text-amber-200/70 leading-snug flex gap-2">
            <span className="text-amber-400 mt-0.5 flex-shrink-0">▸</span>
            <span>{issue}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
