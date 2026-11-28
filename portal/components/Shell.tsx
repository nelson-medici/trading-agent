"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Activity, Wallet, Brain, Settings as SettingsIcon, Shield, Terminal, LogOut, User, Zap, CandlestickChart, History, Bell, Timer, AlertTriangle, AlertOctagon, Info, Menu, X, Eye } from "lucide-react";

type View = "overview" | "portfolio" | "decisions" | "charts" | "triggers" | "strategies" | "scalper" | "history" | "alerts" | "config" | "control";

// Configuración y Control no están en la nav: Config es un CTA del header,
// Control vive en el menú de usuario (operación sensible, no navegación diaria)
const NAV: { id: View; label: string; icon: any; href: string }[] = [
  { id: "overview", label: "Overview", icon: Activity, href: "/" },
  { id: "portfolio", label: "Portafolio", icon: Wallet, href: "/portfolio" },
  { id: "decisions", label: "Decisiones", icon: Brain, href: "/decisions" },
  { id: "charts", label: "Charts", icon: CandlestickChart, href: "/charts" },
  { id: "triggers", label: "Triggers", icon: Eye, href: "/triggers" },
  { id: "scalper", label: "Scalper", icon: Timer, href: "/scalper" },
  { id: "history", label: "Histórico", icon: History, href: "/history" },
];

const VIEW_META: Record<View, { label: string }> = {
  overview: { label: "Overview" },
  portfolio: { label: "Portafolio" },
  decisions: { label: "Decisiones" },
  charts: { label: "Charts" },
  triggers: { label: "Triggers" },
  strategies: { label: "Strategies" },
  scalper: { label: "Scalper manual" },
  history: { label: "Histórico de trades" },
  alerts: { label: "Alertas" },
  config: { label: "Configuración" },
  control: { label: "Control" },
};

interface HeaderKPIs {
  current_equity: number | null;
  total_invested: number | null;
  total_gain: number | null;
  total_gain_pct: number | null;
  open_positions: number | null;
  engine_status: string | null;
  engine_last_heartbeat: string | null;
  engine_seconds_since_heartbeat: number | null;
}

interface Alert {
  id: string;
  severity: string;   // columna `level` en la DB
  category: string;
  title: string;
  detail: string | null;  // columna `message` en la DB
  href: string | null;    // metadata.href (alertas accionables, ej. oportunidad de scalper)
  acknowledged: boolean;
  created_at: string;
}

export default function Shell({ current, children }: { current: View; children: React.ReactNode }) {
  const [now, setNow] = useState(new Date());
  const [email, setEmail] = useState<string>("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [kpis, setKpis] = useState<HeaderKPIs | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [brokerMode, setBrokerMode] = useState<string>("paper");
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user?.email) setEmail(user.email);
    });
  }, [supabase]);

  useEffect(() => {
    async function loadKpis() {
      const [kpiRes, brokerRes] = await Promise.all([
        supabase.from("v_dashboard_summary").select(
          "current_equity, total_invested, total_gain, total_gain_pct, open_positions, engine_status, engine_last_heartbeat, engine_seconds_since_heartbeat"
        ).single(),
        supabase.from("config").select("value").eq("key", "execution.broker").single(),
      ]);
      if (kpiRes.data) setKpis(kpiRes.data as HeaderKPIs);
      if (brokerRes.data) {
        const val = brokerRes.data.value;
        setBrokerMode(typeof val === "object" && val?.broker ? val.broker : "paper");
      }
    }
    loadKpis();
    const iv = setInterval(loadKpis, 15000);
    return () => clearInterval(iv);
  }, [supabase]);

  // Carga de alertas (unread + últimas por si no hay)
  async function loadAlerts() {
    const { data } = await supabase
      .from("alerts")
      .select("id, level, category, title, message, metadata, acknowledged, created_at")
      .order("created_at", { ascending: false })
      .limit(20);
    if (data) setAlerts(data.map((a: any) => ({
      id: a.id, severity: a.level, category: a.category, title: a.title, detail: a.message,
      href: a.metadata?.href ?? null, acknowledged: a.acknowledged, created_at: a.created_at,
    })));
  }
  useEffect(() => {
    loadAlerts();
    const iv = setInterval(loadAlerts, 15000);
    return () => clearInterval(iv);
  }, [supabase]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  async function ackAlert(id: string) {
    await supabase.from("alerts").update({ acknowledged: true }).eq("id", id);
    setAlerts((prev) => prev.map((a) => a.id === id ? { ...a, acknowledged: true } : a));
  }

  async function ackAll() {
    const unreadIds = alerts.filter((a) => !a.acknowledged).map((a) => a.id);
    if (unreadIds.length === 0) return;
    await supabase.from("alerts").update({ acknowledged: true }).in("id", unreadIds);
    setAlerts((prev) => prev.map((a) => unreadIds.includes(a.id) ? { ...a, acknowledged: true } : a));
  }

  const unreadAlerts = alerts.filter((a) => !a.acknowledged);
  const unreadCount = unreadAlerts.length;
  const highestSeverity = unreadAlerts.reduce((max, a) => {
    const rank = { critical: 3, warn: 2, info: 1 }[a.severity] || 0;
    const maxRank = { critical: 3, warn: 2, info: 1 }[max] || 0;
    return rank > maxRank ? a.severity : max;
  }, "info");

  const currentMeta = VIEW_META[current];

  return (
    <div className="min-h-screen bg-black text-zinc-200 font-mono">
      <header className="border-b border-zinc-800 bg-zinc-950/90 backdrop-blur sticky top-0 z-40">
        <div className="px-3 md:px-4 py-2 md:py-2.5 flex items-center justify-between gap-2 md:gap-6">
          <div className="flex items-center gap-2 md:gap-3 min-w-0">
            {/* Hamburger (solo mobile) */}
            <button onClick={() => setMobileNavOpen(!mobileNavOpen)}
              className="md:hidden border border-zinc-800 p-1.5 text-zinc-400"
              aria-label="Menú">
              {mobileNavOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>

            <div className="w-6 h-6 md:w-7 md:h-7 border border-lime-500 flex items-center justify-center flex-shrink-0">
              <Terminal className="w-3 h-3 md:w-3.5 md:h-3.5 text-lime-400" />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] md:text-[15px] text-zinc-100 truncate" style={{ fontFamily: "Fraunces, serif" }}>
                Quant<span className="text-lime-400">.</span>Agent
              </div>
              <div className="text-[9px] uppercase tracking-[0.2em] text-zinc-600 -mt-1 hidden md:flex items-center gap-2">
                <span>portfolio · risk · execution</span>
                <span className={`px-1.5 py-0.5 text-[8px] border ${
                  brokerMode === "binance" ? "border-red-500 text-red-400 bg-red-950/30 animate-pulse" :
                  brokerMode === "binance_testnet" ? "border-amber-600 text-amber-400 bg-amber-950/30" :
                  "border-zinc-700 text-zinc-500"
                }`}>
                  {brokerMode === "binance" ? "LIVE" : brokerMode === "binance_testnet" ? "TESTNET" : "PAPER"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 md:gap-3 text-[11px] flex-shrink-0">
            {/* orden visual en desktop: KPIs · usuario (order-1) · campana (order-2) · config (order-3) */}

            {/* KPI compacto en mobile: solo equity + gain (sin dot acá; va al lado del reloj) */}
            {kpis && (
              <div className="flex md:hidden items-center gap-1.5 border border-zinc-800 bg-zinc-950 px-2 py-1">
                <span className="text-[10px] text-lime-400 tabular-nums">${kpis.current_equity?.toFixed(0) ?? "—"}</span>
                <span className={`text-[10px] tabular-nums ${(kpis.total_gain ?? 0) > 0 ? "text-emerald-400" : (kpis.total_gain ?? 0) < 0 ? "text-red-400" : "text-zinc-400"}`}>
                  {kpis.total_gain != null ? `${kpis.total_gain >= 0 ? "+" : ""}$${kpis.total_gain.toFixed(2)}` : "—"}
                </span>
              </div>
            )}

            {/* En mobile muy chico (<sm), si no hay reloj visible, el dot se muestra al lado del KPI */}
            {kpis && (
              <div className="sm:hidden" title={engineStatusTitle(kpis)}>
                <EngineDot status={kpis.engine_status} />
              </div>
            )}

            {/* KPIs permanentes — completos solo en desktop (ya no incluyen el dot) */}
            {kpis && (
              <div className="hidden md:flex items-center gap-4 border border-zinc-800 bg-zinc-950 px-3 py-1">
                <KpiItem label="Equity" value={kpis.current_equity != null ? `$${kpis.current_equity.toFixed(2)}` : "—"} tone="accent" />
                <KpiItem label="Inv" value={kpis.total_invested != null ? `$${kpis.total_invested.toFixed(0)}` : "—"} />
                <KpiItem
                  label="Gain"
                  value={kpis.total_gain != null ? `${kpis.total_gain >= 0 ? "+" : ""}$${kpis.total_gain.toFixed(2)}` : "—"}
                  sub={kpis.total_gain_pct != null ? `${(kpis.total_gain_pct * 100).toFixed(1)}%` : undefined}
                  tone={(kpis.total_gain ?? 0) > 0 ? "success" : (kpis.total_gain ?? 0) < 0 ? "danger" : "neutral"}
                />
                <KpiItem label="Pos" value={kpis.open_positions ?? 0} />
              </div>
            )}

            {/* Campanita de notificaciones (a la derecha de config) */}
            <div className="relative order-3">
              <button onClick={() => { if (!notifOpen) loadAlerts(); setNotifOpen(!notifOpen); }}
                title={unreadCount > 0 ? `${unreadCount} alerta${unreadCount === 1 ? "" : "s"} sin leer` : "Sin alertas nuevas"}
                className={`relative flex items-center justify-center border p-1.5 transition-colors ${
                  unreadCount > 0
                    ? "border-violet-500 text-violet-300 bg-violet-950/30"
                    : "border-zinc-800 text-violet-400/70 hover:text-violet-300 hover:border-violet-800"
                }`}>
                <Bell className="w-3.5 h-3.5" />
                {unreadCount > 0 && (
                  <span className={`absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 text-[9px] font-medium tabular-nums flex items-center justify-center rounded-full bg-violet-500 text-white border border-violet-300 ${
                    highestSeverity === "critical" ? "animate-pulse" : ""
                  }`}>{unreadCount > 99 ? "99+" : unreadCount}</span>
                )}
              </button>

              {notifOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 bg-zinc-950 border border-zinc-800 w-[calc(100vw-1.5rem)] md:w-[380px] max-w-[380px] max-h-[520px] overflow-hidden flex flex-col z-50 shadow-2xl">
                    <div className="px-3 py-2 border-b border-zinc-900 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Bell className="w-3 h-3 text-violet-400" />
                        <span className="text-[11px] uppercase tracking-wider text-zinc-400">Alertas</span>
                        {unreadCount > 0 && <span className="text-[10px] text-zinc-600">({unreadCount} sin leer)</span>}
                      </div>
                      {unreadCount > 0 && (
                        <button onClick={ackAll} className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-violet-300">
                          Marcar todas
                        </button>
                      )}
                    </div>
                    <div className="overflow-y-auto">
                      {alerts.length === 0 ? (
                        <div className="p-6 text-center text-[11px] text-zinc-600">Sin alertas aún.</div>
                      ) : (
                        alerts.map((a) => <AlertRow key={a.id} alert={a} onAck={() => ackAlert(a.id)} />)
                      )}
                    </div>
                    <div className="px-3 py-2 border-t border-zinc-900 flex items-center justify-between text-[10px]">
                      <Link href="/alerts" onClick={() => setNotifOpen(false)} className="text-violet-300 hover:underline">
                        Ver todas las alertas →
                      </Link>
                      <span className="text-zinc-600">refresh cada 15s</span>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* CTA Configuración (solo ícono) — oculto en mobile, está en el drawer */}
            <Link href="/config" prefetch={false}
              title="Configuración del sistema"
              className={`hidden md:flex order-2 items-center justify-center border p-1.5 transition-colors ${
                current === "config"
                  ? "border-lime-500 text-lime-400 bg-lime-950/30"
                  : "border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
              }`}>
              <SettingsIcon className="w-3.5 h-3.5" />
            </Link>

            {/* User menu — oculto en mobile, logout está en el drawer */}
            <div className="relative hidden md:block order-1">
              <button onClick={() => setMenuOpen(!menuOpen)}
                className="flex items-center gap-2 border border-zinc-800 hover:border-zinc-600 px-2 py-1 text-zinc-400 hover:text-zinc-200">
                <User className="w-3 h-3" />
                <span className="hidden md:inline max-w-[160px] truncate">{email || "..."}</span>
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 bg-zinc-950 border border-zinc-800 py-1 min-w-[200px] z-50">
                    <div className="px-3 py-2 text-[10px] text-zinc-500 border-b border-zinc-900">
                      <div className="truncate">{email}</div>
                    </div>
                    <Link href="/control" onClick={() => setMenuOpen(false)}
                      className={`px-3 py-2 text-xs flex items-center gap-2 border-b border-zinc-900 ${current === "control" ? "text-lime-400 bg-lime-950/20" : "text-zinc-300 hover:bg-zinc-900"}`}>
                      <Shield className="w-3 h-3" />
                      Control
                    </Link>
                    <Link href="/strategies" onClick={() => setMenuOpen(false)}
                      className={`px-3 py-2 text-xs flex items-center gap-2 border-b border-zinc-900 ${current === "strategies" ? "text-lime-400 bg-lime-950/20" : "text-zinc-300 hover:bg-zinc-900"}`}>
                      <Zap className="w-3 h-3" />
                      Strategies
                    </Link>
                    <Link href="/config" onClick={() => setMenuOpen(false)}
                      className={`px-3 py-2 text-xs flex items-center gap-2 border-b border-zinc-900 ${current === "config" ? "text-lime-400 bg-lime-950/20" : "text-zinc-300 hover:bg-zinc-900"}`}>
                      <SettingsIcon className="w-3 h-3" />
                      Configuración
                    </Link>
                    <button onClick={handleLogout}
                      className="w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-red-950/30 hover:text-red-300 flex items-center gap-2">
                      <LogOut className="w-3 h-3" />
                      Cerrar sesión
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        {/* NAV desktop: tabs horizontales */}
        <nav className="hidden md:flex border-t border-zinc-900 px-4">
          {NAV.map((v) => (
            <Link key={v.id} href={v.href}
              className={`flex items-center gap-2 px-4 py-2.5 text-[11px] uppercase tracking-[0.15em] border-r border-zinc-900 transition-colors ${current === v.id ? "text-lime-400 bg-zinc-950" : "text-zinc-500 hover:text-zinc-200"}`}>
              <v.icon className="w-3.5 h-3.5" />
              {v.label}
            </Link>
          ))}
          <div className="ml-auto flex items-center gap-2 text-[10px] text-zinc-400 pr-2">
            <span className="capitalize">
              {now.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "short" })}
            </span>
            <span className="text-zinc-700">|</span>
            <span className="tabular-nums">
              {now.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })}
            </span>
            {kpis && <EngineDot status={kpis.engine_status} title={engineStatusTitle(kpis)} />}
          </div>
        </nav>

        {/* NAV mobile: drawer que aparece debajo del header */}
        {mobileNavOpen && (
          <>
            <div className="fixed inset-0 bg-black/60 z-30 md:hidden" onClick={() => setMobileNavOpen(false)} />
            <nav className="md:hidden border-t border-zinc-900 bg-zinc-950 relative z-40">
              {NAV.map((v) => (
                <Link key={v.id} href={v.href} onClick={() => setMobileNavOpen(false)}
                  className={`flex items-center gap-3 px-4 py-3 text-xs uppercase tracking-wider border-b border-zinc-900 transition-colors ${current === v.id ? "text-lime-400 bg-lime-950/20" : "text-zinc-400"}`}>
                  <v.icon className="w-4 h-4" />
                  {v.label}
                </Link>
              ))}
              {/* Opciones extra en el drawer mobile */}
              <Link href="/control" onClick={() => setMobileNavOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 text-xs uppercase tracking-wider border-b border-zinc-900 ${current === "control" ? "text-lime-400 bg-lime-950/20" : "text-zinc-400"}`}>
                <Shield className="w-4 h-4" /> Control
              </Link>
              <Link href="/strategies" onClick={() => setMobileNavOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 text-xs uppercase tracking-wider border-b border-zinc-900 ${current === "strategies" ? "text-lime-400 bg-lime-950/20" : "text-zinc-400"}`}>
                <Zap className="w-4 h-4" /> Strategies
              </Link>
              <Link href="/alerts" onClick={() => setMobileNavOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 text-xs uppercase tracking-wider border-b border-zinc-900 ${current === "alerts" ? "text-violet-300 bg-violet-950/20" : "text-zinc-400"}`}>
                <Bell className="w-4 h-4" /> Alertas
              </Link>
              <Link href="/config" onClick={() => setMobileNavOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 text-xs uppercase tracking-wider border-b border-zinc-900 ${current === "config" ? "text-lime-400 bg-lime-950/20" : "text-zinc-400"}`}>
                <SettingsIcon className="w-4 h-4" /> Configuración
              </Link>
              {/* Logout en el drawer */}
              <button onClick={() => { handleLogout(); setMobileNavOpen(false); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-xs uppercase tracking-wider text-zinc-400 hover:text-red-300 border-b border-zinc-900">
                <LogOut className="w-4 h-4" /> Cerrar sesión
              </button>
              <div className="px-4 py-2 text-[10px] text-zinc-600 flex items-center justify-between">
                <span className="truncate">{email}</span>
                <span className="tabular-nums ml-2 flex items-center gap-1.5">
                  {now.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                  {kpis && <EngineDot status={kpis.engine_status} title={engineStatusTitle(kpis)} />}
                </span>
              </div>
            </nav>
          </>
        )}
      </header>

      <div className="px-4 pt-4 md:pt-6 pb-3 md:pb-4">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-2xl md:text-3xl text-zinc-100" style={{ fontFamily: "Fraunces, serif", fontWeight: 300 }}>{currentMeta.label}</h1>
          <span className="text-[10px] text-zinc-600 font-mono" title={`Build time: ${process.env.NEXT_PUBLIC_BUILD_TIME}`}>
            build {process.env.NEXT_PUBLIC_COMMIT_SHA || "dev"}
          </span>
        </div>
      </div>

      <main className="px-3 md:px-4 pb-12">{children}</main>

      <footer className="border-t border-zinc-900 px-4 py-3 text-[10px] text-zinc-600 flex items-center justify-between">
        <span className="hidden sm:inline">quant.agent · disciplined quantitative system</span>
        <span className="sm:hidden">quant.agent</span>
        <span>v0.1.0</span>
      </footer>
    </div>
  );
}

function AlertRow({ alert, onAck }: { alert: Alert; onAck: () => void }) {
  const severityIcon = {
    critical: <AlertOctagon className="w-3 h-3 text-red-400" />,
    warn: <AlertTriangle className="w-3 h-3 text-amber-400" />,
    info: <Info className="w-3 h-3 text-zinc-400" />,
  }[alert.severity] || <Info className="w-3 h-3 text-zinc-400" />;

  const severityColor = {
    critical: "border-l-red-500",
    warn: "border-l-amber-500",
    info: "border-l-zinc-700",
  }[alert.severity] || "border-l-zinc-700";

  const ts = new Date(alert.created_at);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - ts.getTime()) / 60000);
  const relTime = diffMin < 1 ? "ahora" : diffMin < 60 ? `${diffMin}m` : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h` : `${Math.floor(diffMin / 1440)}d`;

  return (
    <div className={`relative px-3 py-2 border-b border-zinc-900 border-l-2 ${severityColor} ${alert.acknowledged ? "opacity-50" : "bg-violet-950/10"}`}>
      {!alert.acknowledged && <span className="absolute left-1 top-3 w-1.5 h-1.5 rounded-full bg-violet-400" title="sin leer" />}
      <div className="flex items-start gap-2 pl-2">
        <div className="pt-0.5">{severityIcon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-zinc-200 font-medium truncate">{alert.title}</span>
            </div>
            <span className="text-[9px] text-zinc-600 tabular-nums whitespace-nowrap">{relTime}</span>
          </div>
          {alert.detail && (
            <div className="text-[10px] text-zinc-500 mt-0.5 leading-snug">{alert.detail}</div>
          )}
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[9px] uppercase tracking-wider text-zinc-600">{alert.category}</span>
            {alert.href && (
              <Link href={alert.href} className="text-[9px] uppercase tracking-wider text-lime-400 hover:underline">abrir →</Link>
            )}
            {!alert.acknowledged && (
              <button onClick={onAck} className="ml-auto text-[9px] uppercase tracking-wider text-violet-400/80 hover:text-violet-300">marcar leída</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EngineDot({ status, title }: { status: string | null; title?: string }) {
  // healthy = verde pulsando · stale = amber · down = rojo pulsando · unknown = gris
  const map: Record<string, string> = {
    healthy: "bg-lime-400 animate-pulse",
    stale: "bg-amber-500",
    down: "bg-red-500 animate-pulse",
  };
  const cls = map[status ?? "unknown"] || "bg-zinc-600";
  return <span className={`w-1.5 h-1.5 rounded-full ${cls}`} title={title} />;
}

function engineStatusTitle(k: HeaderKPIs): string {
  const s = k.engine_status ?? "unknown";
  const secs = k.engine_seconds_since_heartbeat;
  const age = secs != null ? ` · último heartbeat hace ${secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`}` : "";
  return `Engine: ${s.toUpperCase()}${age}`;
}

function KpiItem({ label, value, sub, tone = "neutral" }: { label: string; value: any; sub?: string; tone?: string }) {
  const color = { neutral: "text-zinc-100", accent: "text-lime-400", success: "text-emerald-400", warn: "text-amber-400", danger: "text-red-400" }[tone] || "text-zinc-100";
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={`text-[12px] tabular-nums ${color}`}>{value}</span>
      {sub && <span className={`text-[9px] tabular-nums ${color} opacity-70`}>({sub})</span>}
    </div>
  );
}
