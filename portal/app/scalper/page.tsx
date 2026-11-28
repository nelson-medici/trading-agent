"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase";
import Shell from "@/components/Shell";
import { formatUsd } from "@/lib/utils";
import { Play, Square, AlertTriangle, Radar, ChevronDown, ChevronRight } from "lucide-react";

interface Session {
  id: string;
  symbol: string;
  strategy: string;
  duration_min: number;
  max_capital_usd: number;
  max_trades: number;
  status: string;
  auto: boolean;
  stop_reason: string | null;
  stop_detail: string | null;
  stop_requested: boolean;
  requested_at: string;
  started_at: string | null;
  ends_at: string | null;
  ended_at: string | null;
  capital_usd: number | null;
  trades_count: number;
  wins: number;
  losses: number;
  realized_pnl_usd: number;
  peak_pnl_usd: number;
  last_score: number | null;
  last_note: string | null;
  last_tick_at: string | null;
}

interface STrade {
  id: string;
  session_id: string;
  symbol: string;
  status: string;
  size_units: number;
  entry_price: number;
  initial_stop: number;
  stop_price: number;
  target_price: number;
  last_price: number | null;
  opened_at: string;
  closed_at: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  entry_reason: string | null;
}

interface Scan {
  symbol: string;
  score: number;
  components: any;
  price: number | null;
  note: string | null;
  updated_at: string;
}

interface Opp { id: string; symbol: string; score: number; detected_at: string }

const STOP_LABEL: Record<string, string> = {
  time_expired: "Tiempo cumplido",
  max_trades: "Máx. de trades",
  loss_limit: "Límite de pérdida",
  consecutive_losses: "Pérdidas seguidas",
  profit_lock: "Ganancia protegida",
  regime_deteriorated: "Mercado dejó de servir",
  flash_crash: "Caída brusca",
  kill_switch: "Kill switch",
  manual: "Detenida a mano",
  engine_offline: "Engine apagado",
  insufficient_cash: "Sin cash",
};

const DEFAULT_WATCHLIST = ["BTC/USDT", "ETH/USDT", "SOL/USDT"];

export default function ScalperPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [trades, setTrades] = useState<STrade[]>([]);
  const [scan, setScan] = useState<Scan[]>([]);
  const [opps, setOpps] = useState<Opp[]>([]);
  const [cfg, setCfg] = useState<any>({});
  const [engine, setEngine] = useState<string>("unknown");
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState<string | null>(null);

  // Form
  const [symbol, setSymbol] = useState("BTC/USDT");
  const [duration, setDuration] = useState(30);
  const [capital, setCapital] = useState(25);
  const [maxTrades, setMaxTrades] = useState(5);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      setLoading(false);
    });
    const q = new URLSearchParams(window.location.search).get("symbol");
    if (q) setSymbol(q);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [router, supabase]);

  async function load() {
    const since2h = new Date(Date.now() - 2 * 3600_000).toISOString();
    const [sRes, scRes, oRes, cRes, eRes] = await Promise.all([
      supabase.from("scalper_sessions").select("*").order("requested_at", { ascending: false }).limit(30),
      supabase.from("scalper_scan").select("*").order("score", { ascending: false }),
      supabase.from("scalper_opportunities").select("id, symbol, score, detected_at").gte("detected_at", since2h).order("detected_at", { ascending: false }).limit(20),
      supabase.from("config").select("value").eq("key", "scalper.config").single(),
      supabase.from("v_dashboard_summary").select("engine_status").single(),
    ]);
    const ss = (sRes.data as Session[]) || [];
    setSessions(ss);
    if (scRes.data) setScan(scRes.data as Scan[]);
    if (oRes.data) setOpps(oRes.data as Opp[]);
    if (cRes.data?.value) setCfg(cRes.data.value);
    if (eRes.data) setEngine((eRes.data as any).engine_status || "unknown");
    const ids = ss.slice(0, 10).map((s) => s.id);
    if (ids.length) {
      const { data } = await supabase.from("scalper_trades").select("*").in("session_id", ids).order("opened_at", { ascending: false });
      if (data) setTrades(data as STrade[]);
    }
  }

  useEffect(() => {
    if (loading) return;
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const live = useMemo(() => sessions.find((s) => s.status === "requested" || s.status === "active") || null, [sessions]);
  const past = useMemo(() => sessions.filter((s) => s !== live), [sessions, live]);
  const openTrade = useMemo(() => (live ? trades.find((t) => t.session_id === live.id && t.status === "open") || null : null), [trades, live]);
  const watchlist: string[] = cfg.watchlist?.length ? cfg.watchlist : DEFAULT_WATCHLIST;
  const threshold = Number(cfg.alert_threshold ?? 75);
  const engineUp = engine === "healthy" || engine === "stale";

  async function start() {
    setBusy(true); setMsg("");
    const { error } = await supabase.from("scalper_sessions").insert({
      symbol, duration_min: duration, max_capital_usd: capital, max_trades: maxTrades, status: "requested",
    });
    setBusy(false);
    if (error) { setMsg(error.code === "23505" ? "Ya hay una sesión en curso." : `Error: ${error.message}`); return; }
    await load();
  }

  async function stop() {
    if (!live) return;
    setBusy(true);
    if (live.status === "requested") {
      await supabase.from("scalper_sessions").update({
        status: "rejected", stop_reason: "manual", stop_detail: "Cancelada antes de que el engine la tomara.", ended_at: new Date().toISOString(),
      }).eq("id", live.id);
    } else {
      await supabase.from("scalper_sessions").update({ stop_requested: true }).eq("id", live.id);
    }
    setBusy(false);
    await load();
  }

  async function toggleAuto() {
    const next = { ...cfg, auto_start: { ...(cfg.auto_start || {}), enabled: !cfg.auto_start?.enabled } };
    setCfg(next);
    const { error } = await supabase.from("config").update({ value: next }).eq("key", "scalper.config");
    if (error) setMsg(`Error: ${error.message}`);
    await load();
  }

  if (loading) return null;

  const auto = cfg.auto_start || {};
  const secsLeft = live?.ends_at ? Math.max(0, Math.floor((new Date(live.ends_at).getTime() - now) / 1000)) : null;
  const unreal = openTrade && openTrade.last_price != null ? (openTrade.last_price - openTrade.entry_price) * openTrade.size_units : 0;
  const tickAge = live?.last_tick_at ? Math.floor((now - new Date(live.last_tick_at).getTime()) / 1000) : null;

  return (
    <Shell current="scalper">
      <div className="space-y-6">

{!engineUp && (
          <div className="border border-red-800 bg-red-950/20 px-3 py-2 text-[11px] text-red-300">
            El engine está <span className="uppercase">{engine}</span>. Una sesión solo arranca con el engine prendido; si el pedido queda más de 5 min sin atender se descarta.
          </div>
        )}

        {/* AUTO-INICIO */}
        <div className={`border px-3 py-2 flex items-center gap-3 flex-wrap text-[11px] ${auto.enabled ? "border-violet-700 bg-violet-950/15" : "border-zinc-800 bg-zinc-950"}`}>
          <button onClick={toggleAuto} role="switch" aria-checked={!!auto.enabled}
            className={`relative w-9 h-5 border transition-colors flex-shrink-0 ${auto.enabled ? "border-violet-500 bg-violet-600/40" : "border-zinc-700 bg-black"}`}>
            <span className={`absolute top-0.5 w-3.5 h-3.5 transition-all ${auto.enabled ? "left-[18px] bg-violet-300" : "left-0.5 bg-zinc-600"}`} />
          </button>
          <span className={`uppercase tracking-wider text-[10px] ${auto.enabled ? "text-violet-300" : "text-zinc-500"}`}>
            Auto-inicio {auto.enabled ? "activado" : "apagado"}
          </span>
          <span className="text-zinc-500">
            Cuando el radar marca score ≥ {threshold}, lanza sola una sesión de {auto.duration_min ?? 30} min con ${auto.capital_usd ?? 25} sobre el mejor símbolo.
            Frenos: máx. {auto.max_sessions_24h ?? 4} sesiones/24h · {auto.min_gap_min ?? 30} min entre sesiones · se apaga si pierde ${Number(auto.loss_limit_24h_usd ?? 1).toFixed(2)} en 24h.
          </span>
        </div>

        {/* SESIÓN EN CURSO o FORM */}
        {live ? (
          <section className="border border-lime-700 bg-lime-950/10 p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-lime-400 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse" />
                  {live.status === "requested" ? "Esperando al engine…" : "Sesión en curso"}
                  {live.auto && <span className="border border-violet-600 text-violet-300 px-1.5 py-0.5 tracking-wider">auto</span>}
                </div>
                <div className="text-2xl text-zinc-100 mt-1">{live.symbol}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">
                  {live.duration_min} min · capital {formatUsd(Number(live.capital_usd ?? live.max_capital_usd))} · máx {live.max_trades} trades
                </div>
              </div>
              <button onClick={stop} disabled={busy || live.stop_requested}
                className="border border-red-700 text-red-300 hover:bg-red-950/40 px-4 py-2 text-xs uppercase tracking-wider flex items-center gap-2 disabled:opacity-50">
                <Square className="w-3 h-3" /> {live.stop_requested ? "Deteniendo…" : "Detener ahora"}
              </button>
            </div>

            {live.status === "active" && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4">
                  <Stat label="Tiempo restante" value={secsLeft != null ? `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, "0")}` : "—"} tone="accent" />
                  <Stat label="PnL realizado" value={formatUsd(Number(live.realized_pnl_usd))} tone={Number(live.realized_pnl_usd) > 0 ? "success" : Number(live.realized_pnl_usd) < 0 ? "danger" : "neutral"} />
                  <Stat label="PnL latente" value={openTrade ? formatUsd(unreal) : "—"} tone={unreal > 0 ? "success" : unreal < 0 ? "danger" : "neutral"} />
                  <Stat label="Trades" value={`${live.trades_count} / ${live.max_trades}`} sub={`${live.wins}W · ${live.losses}L`} />
                  <Stat label="Scalp score" value={live.last_score != null ? Number(live.last_score).toFixed(0) : "—"} tone={Number(live.last_score ?? 100) < Number(cfg.min_regime_score ?? 40) ? "warn" : "neutral"} />
                </div>

                {openTrade && (
                  <div className="mt-3 border border-zinc-800 bg-black/40 p-3 text-[11px] font-mono flex flex-wrap gap-x-4 gap-y-1">
                    <span className="text-lime-400 uppercase tracking-wider text-[10px]">En posición</span>
                    <span className="text-zinc-500">entry <span className="text-zinc-200">${fmtPx(openTrade.entry_price)}</span></span>
                    <span className="text-zinc-500">ahora <span className="text-zinc-200">${fmtPx(openTrade.last_price ?? openTrade.entry_price)}</span></span>
                    <span className="text-zinc-500">stop <span className="text-red-400">${fmtPx(openTrade.stop_price)}</span>{openTrade.stop_price > openTrade.initial_stop && <span className="text-emerald-500/80"> (subido)</span>}</span>
                    <span className="text-zinc-500">target <span className="text-emerald-400">${fmtPx(openTrade.target_price)}</span></span>
                    <span className="text-zinc-500">{openTrade.entry_reason}</span>
                  </div>
                )}

                <div className="mt-3 text-[11px] text-zinc-400">
                  <span className="text-[9px] uppercase tracking-wider text-zinc-600 mr-2">estado</span>{live.last_note || "—"}
                  {tickAge != null && <span className={`ml-2 text-[10px] ${tickAge > 60 ? "text-red-400" : "text-zinc-600"}`}>· último tick hace {tickAge}s</span>}
                </div>
              </>
            )}
          </section>
        ) : (
          <section className="border border-zinc-800 bg-zinc-950 p-4 space-y-3">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">// Iniciar sesión de scalping</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Field label="Símbolo">
                <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className={inputCls}>
                  {Array.from(new Set([...watchlist, symbol])).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Duración"><Choice value={duration} onChange={setDuration} options={[15, 30, 60]} suffix="m" /></Field>
              <Field label="Capital máx."><Choice value={capital} onChange={setCapital} options={[10, 25, 50]} prefix="$" /></Field>
              <Field label="Máx. trades"><Choice value={maxTrades} onChange={setMaxTrades} options={[3, 5, 10]} /></Field>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={start} disabled={busy}
                className="border border-lime-600 text-lime-300 hover:bg-lime-950/50 px-4 py-2 text-xs uppercase tracking-wider flex items-center gap-2 disabled:opacity-50">
                <Play className="w-3 h-3" /> Iniciar sesión
              </button>
              <span className="text-[10px] text-zinc-600">El capital sale del cash del pool {cfg.capital_pool || "tactical"}. Una sesión a la vez.</span>
              {msg && <span className="text-xs text-red-400">{msg}</span>}
            </div>
            <details className="text-[11px] text-zinc-500">
              <summary className="cursor-pointer hover:text-zinc-300">Reglas de entrada, gestión y corte</summary>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px] leading-relaxed">
                <RuleBox title="Entra solo si">
                  <li>La última vela 1m cerrada rompe el máximo de {cfg.breakout_lookback ?? 15} velas</li>
                  <li>Con volumen ≥ {cfg.volume_mult ?? 1.5}× el promedio</li>
                  <li>EMA9 &gt; EMA21 y precio sobre el VWAP de 2h</li>
                  <li>Spread ≤ {((cfg.max_spread_pct ?? 0.0005) * 100).toFixed(2)}%, sin perseguir ni velas exhaustas</li>
                  <li>ATR suficiente para que el target cubra comisiones</li>
                </RuleBox>
                <RuleBox title="Gestiona cada trade">
                  <li>Stop {((cfg.min_risk_pct ?? 0.003) * 100).toFixed(1)}–{((cfg.max_risk_pct ?? 0.006) * 100).toFixed(1)}% según ATR · target {cfg.target_rr ?? 2}R</li>
                  <li>A +1R sube el stop a breakeven (cubre comisión)</li>
                  <li>A +1.5R el stop persigue al precio</li>
                  <li>Sale si en {cfg.time_stop_min ?? 10} min no avanzó</li>
                  <li>Pausa {cfg.cooldown_after_loss_min ?? 3} min tras una pérdida</li>
                </RuleBox>
                <RuleBox title="Corta la sesión si">
                  <li>{cfg.max_consecutive_losses ?? 2} pérdidas seguidas</li>
                  <li>Pérdida ≥ {((cfg.max_session_loss_pct ?? 0.02) * 100).toFixed(1)}% del capital (incluye latente)</li>
                  <li>Devuelve {((cfg.profit_lock_giveback ?? 0.5) * 100).toFixed(0)}% de la ganancia pico</li>
                  <li>Scalp score &lt; {cfg.min_regime_score ?? 40} por {cfg.regime_streak_to_stop ?? 3} min</li>
                  <li>Caída ≥ {((cfg.flash_crash_pct ?? 0.015) * 100).toFixed(1)}% en 5 min, kill switch, o tiempo cumplido</li>
                </RuleBox>
              </div>
            </details>
          </section>
        )}

        {/* RADAR */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 flex items-center gap-2"><Radar className="w-3.5 h-3.5" /> // Radar de oportunidades</h2>
            <span className="text-[10px] text-zinc-600">umbral {threshold} · cada 3 min</span>
          </div>
          {scan.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Sin lecturas todavía. El detector corre con el engine prendido.</div>
          ) : (
            <div className="space-y-1.5">
              {[...scan].sort((a, b) => Number(b.score) - Number(a.score)).filter((r) => Number(r.score) >= threshold * 0.5).map((r) => {
                const score = Number(r.score);
                const stale = now - new Date(r.updated_at).getTime() > 10 * 60_000;
                const c = r.components || {};
                const pct = Math.min(100, (score / threshold) * 100);
                const isHot = score >= threshold;
                const isWarm = score >= threshold * 0.8 && !isHot;
                const barColor = isHot ? "bg-lime-500" : isWarm ? "bg-amber-500" : "bg-zinc-700";
                const textColor = isHot ? "text-lime-400" : isWarm ? "text-amber-400" : "text-zinc-500";
                const label = isHot ? "APTO" : isWarm ? "CERCA" : score >= threshold * 0.5 ? "TIBIO" : "FRÍO";
                const labelColor = isHot ? "text-lime-900 bg-lime-400" : isWarm ? "text-amber-900 bg-amber-400" : "text-zinc-400 bg-zinc-800";

                return (
                  <div key={r.symbol} className={`border border-zinc-800 bg-zinc-950 px-3 py-2.5 ${stale ? "opacity-40" : ""} ${isHot ? "border-lime-900/50 bg-lime-950/10" : isWarm ? "border-amber-900/30" : ""}`}>
                    <div className="flex items-center gap-3">
                      {/* Symbol + label */}
                      <div className="w-24 flex-shrink-0">
                        <div className="text-sm text-zinc-100 font-medium">{r.symbol.replace("/USDT", "")}</div>
                        <span className={`text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 ${labelColor}`}>{label}</span>
                      </div>

                      {/* Score + bar */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 mb-1">
                          <span className={`text-lg font-light tabular-nums ${textColor}`}>{score.toFixed(0)}</span>
                          <span className="text-[10px] text-zinc-600">/ {threshold}</span>
                          {isHot && <span className="text-[9px] text-lime-500 animate-pulse">● listo para operar</span>}
                          {isWarm && <span className="text-[9px] text-amber-500">a {(threshold - score).toFixed(0)} pts</span>}
                        </div>
                        <div className="h-1.5 bg-zinc-900 w-full overflow-hidden">
                          <div className={`h-full ${barColor} transition-all duration-500`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>

                      {/* Key metrics */}
                      <div className="hidden md:flex items-center gap-3 text-[10px] text-zinc-500 flex-shrink-0">
                        <span title="Volumen relativo">Vol {c.vol_ratio ?? "—"}×</span>
                        <span title="ATR %">ATR {c.atr_pct ?? "—"}%</span>
                        <span title="Tendencia">{c.up_bias ? "↑" : "↓"} {num(c.trend)}</span>
                        <span className="text-zinc-700">{ago(r.updated_at, now)}</span>
                      </div>

                      {/* Action */}
                      <div className="flex-shrink-0">
                        {!live && (
                          <button onClick={() => { setSymbol(r.symbol); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                            className={`text-[10px] uppercase tracking-wider px-2 py-1 border ${isHot ? "border-lime-700 text-lime-400 hover:bg-lime-950/40" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}>
                            {isHot ? "operar" : "ver"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {opps.length > 0 && (
            <div className="mt-2 text-[10px] text-zinc-500 flex flex-wrap gap-2">
              <span className="uppercase tracking-wider text-zinc-600">avisos últimas 2h:</span>
              {opps.map((o) => <span key={o.id} className={`border px-1.5 py-0.5 ${Number(o.score) >= threshold ? "border-lime-800 text-lime-400" : "border-zinc-800"}`}>{o.symbol} · {Number(o.score).toFixed(0)} · {ago(o.detected_at, now)}</span>)}
            </div>
          )}
        </section>

        {/* HISTORIAL */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Sesiones anteriores ({past.length})</h2>
          {past.length === 0 ? (
            <div className="border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-600">Todavía no corriste ninguna sesión.</div>
          ) : (
            <div className="border border-zinc-800 bg-zinc-950 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="w-6"></th>
                    <th className="text-left px-3 py-2">Inicio</th>
                    <th className="text-left px-3 py-2">Símbolo</th>
                    <th className="text-left px-3 py-2">Fin por</th>
                    <th className="text-right px-2 py-2">Trades</th>
                    <th className="text-right px-2 py-2">W / L</th>
                    <th className="text-right px-2 py-2">PnL</th>
                    <th className="text-right px-2 py-2">Duró</th>
                  </tr>
                </thead>
                <tbody>
                  {past.map((s) => {
                    const pnl = Number(s.realized_pnl_usd);
                    const st = trades.filter((t) => t.session_id === s.id);
                    const mins = s.started_at && s.ended_at ? (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60000 : null;
                    const open = expanded === s.id;
                    return (
                      <Fragment key={s.id}>
                        <tr onClick={() => setExpanded(open ? null : s.id)} className="border-b border-zinc-900 hover:bg-zinc-900/40 cursor-pointer">
                          <td className="px-2 text-zinc-600">{open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}</td>
                          <td className="px-3 py-2 text-[10px] text-zinc-500 whitespace-nowrap">{new Date(s.started_at || s.requested_at).toLocaleString()}</td>
                          <td className="px-3 py-2 text-zinc-100 font-medium">{s.symbol}{s.auto && <span className="ml-2 text-[9px] uppercase tracking-wider border border-violet-700 text-violet-300 px-1 py-0.5">auto</span>}</td>
                          <td className="px-3 py-2">
                            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 border ${stopBadge(s)}`}>{STOP_LABEL[s.stop_reason || ""] || s.stop_reason || s.status}</span>
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">{s.trades_count}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-zinc-400">{s.wins} / {s.losses}</td>
                          <td className={`px-2 py-2 text-right tabular-nums ${pnl > 0 ? "text-emerald-400" : pnl < 0 ? "text-red-400" : "text-zinc-500"}`}>{formatUsd(pnl)}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-zinc-500">{mins != null ? `${mins.toFixed(0)}m` : "—"}</td>
                        </tr>
                        {open && (
                          <tr className="border-b border-zinc-900 bg-black/30">
                            <td colSpan={8} className="px-5 py-3 text-[11px] font-mono space-y-1">
                              {s.stop_detail && <div className="text-zinc-400"><span className="text-[9px] uppercase tracking-wider text-zinc-600 mr-2">motivo</span>{s.stop_detail}</div>}
                              {st.length === 0 ? <div className="text-zinc-600">Sin trades en esta sesión.</div> : st.map((t) => (
                                <div key={t.id} className="flex flex-wrap gap-x-3 text-zinc-500">
                                  <span className="tabular-nums">{new Date(t.opened_at).toLocaleTimeString()}</span>
                                  <span>${fmtPx(t.entry_price)} → ${fmtPx(t.exit_price ?? t.last_price ?? t.entry_price)}</span>
                                  <span className="uppercase text-[10px]">{t.exit_reason || t.status}</span>
                                  <span className={`tabular-nums ${Number(t.pnl_usd) > 0 ? "text-emerald-400" : "text-red-400"}`}>{t.pnl_usd != null ? formatUsd(Number(t.pnl_usd)) : "—"}</span>
                                  <span className="text-zinc-600">{t.entry_reason}</span>
                                </div>
                              ))}
                              <Link href={`/charts?symbol=${encodeURIComponent(s.symbol)}`} className="text-[10px] text-lime-400 hover:underline">→ chart</Link>
                            </td>
                          </tr>
                        )}
                      </Fragment>
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

const inputCls = "w-full bg-black border border-zinc-800 px-2 py-1.5 text-xs text-zinc-100 focus:border-lime-500 outline-none font-mono";

function fmtPx(v: number): string {
  const n = Number(v);
  return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(5);
}

function num(v: any): string {
  return v == null ? "—" : Number(v).toFixed(0);
}

function ago(iso: string, now: number): string {
  const m = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function stopBadge(s: Session): string {
  if (s.status === "rejected") return "border-zinc-700 text-zinc-500";
  if (["loss_limit", "consecutive_losses", "regime_deteriorated", "flash_crash", "kill_switch"].includes(s.stop_reason || "")) return "border-amber-700 text-amber-400 bg-amber-950/30";
  if (s.stop_reason === "profit_lock") return "border-emerald-700 text-emerald-400 bg-emerald-950/30";
  return "border-zinc-700 text-zinc-300";
}

function Stat({ label, value, sub, tone = "neutral" }: { label: string; value: any; sub?: string; tone?: string }) {
  const color = { neutral: "text-zinc-100", accent: "text-lime-400", success: "text-emerald-400", warn: "text-amber-400", danger: "text-red-400" }[tone] || "text-zinc-100";
  return (
    <div className="border border-zinc-800 bg-black/40 p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      <div className={`mt-1 text-lg font-light tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-zinc-600">{sub}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">{label}</label>
      {children}
    </div>
  );
}

function Choice({ value, onChange, options, prefix = "", suffix = "" }: { value: number; onChange: (v: number) => void; options: number[]; prefix?: string; suffix?: string }) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)}
          className={`flex-1 text-[11px] tabular-nums px-2 py-1.5 border ${value === o ? "border-lime-500 text-lime-400 bg-lime-950/30" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}>
          {prefix}{o}{suffix}
        </button>
      ))}
    </div>
  );
}

function RuleBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-zinc-900 p-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1">{title}</div>
      <ul className="list-disc list-inside space-y-0.5 text-zinc-500">{children}</ul>
    </div>
  );
}
