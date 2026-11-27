"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Activity, Wallet, Brain, Settings as SettingsIcon, Shield, Terminal, LogOut, User, Zap, CandlestickChart } from "lucide-react";

type View = "overview" | "portfolio" | "decisions" | "charts" | "strategies" | "config" | "control";

// Configuración ya NO está en la nav principal — es un CTA en el header
const NAV: { id: View; label: string; icon: any; href: string }[] = [
  { id: "overview", label: "Overview", icon: Activity, href: "/" },
  { id: "portfolio", label: "Portafolio", icon: Wallet, href: "/portfolio" },
  { id: "decisions", label: "Decisiones", icon: Brain, href: "/decisions" },
  { id: "charts", label: "Charts", icon: CandlestickChart, href: "/charts" },
  { id: "strategies", label: "Strategies", icon: Zap, href: "/strategies" },
  { id: "control", label: "Control", icon: Shield, href: "/control" },
];

const VIEW_META: Record<View, { label: string }> = {
  overview: { label: "Overview" },
  portfolio: { label: "Portafolio" },
  decisions: { label: "Decisiones" },
  charts: { label: "Charts" },
  strategies: { label: "Strategies" },
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
}

export default function Shell({ current, children }: { current: View; children: React.ReactNode }) {
  const [now, setNow] = useState(new Date());
  const [email, setEmail] = useState<string>("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [kpis, setKpis] = useState<HeaderKPIs | null>(null);
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
      const { data } = await supabase.from("v_dashboard_summary").select(
        "current_equity, total_invested, total_gain, total_gain_pct, open_positions, engine_status, engine_last_heartbeat"
      ).single();
      if (data) setKpis(data as HeaderKPIs);
    }
    loadKpis();
    const iv = setInterval(loadKpis, 15000);
    return () => clearInterval(iv);
  }, [supabase]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  const currentMeta = VIEW_META[current];

  return (
    <div className="min-h-screen bg-black text-zinc-200 font-mono">
      <header className="border-b border-zinc-800 bg-zinc-950/90 backdrop-blur sticky top-0 z-40">
        <div className="px-4 py-2.5 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 border border-lime-500 flex items-center justify-center">
              <Terminal className="w-3.5 h-3.5 text-lime-400" />
            </div>
            <div>
              <div className="text-[15px] text-zinc-100" style={{ fontFamily: "Fraunces, serif" }}>
                Quant<span className="text-lime-400">.</span>Agent
              </div>
              <div className="text-[9px] uppercase tracking-[0.2em] text-zinc-600 -mt-1">portfolio · risk · execution</div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            {/* KPIs permanentes — compactos, sin separadores */}
            {kpis && (
              <div className="hidden md:flex items-center gap-4 border border-zinc-800 bg-zinc-950 px-3 py-1"
                title={`Engine: ${kpis.engine_status ?? "unknown"} · dev mode · paper broker`}>
                <KpiItem label="Equity" value={kpis.current_equity != null ? `$${kpis.current_equity.toFixed(2)}` : "—"} tone="accent" />
                <KpiItem label="Inv" value={kpis.total_invested != null ? `$${kpis.total_invested.toFixed(0)}` : "—"} />
                <KpiItem
                  label="Gain"
                  value={kpis.total_gain != null ? `${kpis.total_gain >= 0 ? "+" : ""}$${kpis.total_gain.toFixed(2)}` : "—"}
                  sub={kpis.total_gain_pct != null ? `${(kpis.total_gain_pct * 100).toFixed(1)}%` : undefined}
                  tone={(kpis.total_gain ?? 0) > 0 ? "success" : (kpis.total_gain ?? 0) < 0 ? "danger" : "neutral"}
                />
                <KpiItem label="Pos" value={kpis.open_positions ?? 0} />
                <span className={`w-1.5 h-1.5 rounded-full ${kpis.engine_status === "healthy" ? "bg-lime-400 animate-pulse" : "bg-amber-500"}`}
                  title={kpis.engine_status === "healthy" ? "Engine healthy" : "Engine stale"} />
              </div>
            )}

            {/* CTA Configuración (solo ícono) */}
            <Link href="/config"
              title="Configuración del sistema"
              className={`flex items-center justify-center border p-1.5 transition-colors ${
                current === "config"
                  ? "border-lime-500 text-lime-400 bg-lime-950/30"
                  : "border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
              }`}>
              <SettingsIcon className="w-3.5 h-3.5" />
            </Link>

            {/* User menu */}
            <div className="relative">
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
        <nav className="border-t border-zinc-900 px-4 flex">
          {NAV.map((v) => (
            <Link key={v.id} href={v.href}
              className={`flex items-center gap-2 px-4 py-2.5 text-[11px] uppercase tracking-[0.15em] border-r border-zinc-900 transition-colors ${current === v.id ? "text-lime-400 bg-zinc-950" : "text-zinc-500 hover:text-zinc-200"}`}>
              <v.icon className="w-3.5 h-3.5" />
              {v.label}
            </Link>
          ))}
          <div className="ml-auto hidden lg:flex items-center gap-2 text-[10px] text-zinc-500 pr-2">
            <span className="tabular-nums">{now.toISOString().slice(11, 19)}</span>
            <span className="text-zinc-700">UTC</span>
          </div>
        </nav>
      </header>

      <div className="px-4 pt-6 pb-4">
        <div className="text-[10px] uppercase tracking-[0.25em] text-zinc-600">// {current}.view</div>
        <div className="flex items-baseline gap-3 mt-1">
          <h1 className="text-3xl text-zinc-100" style={{ fontFamily: "Fraunces, serif", fontWeight: 300 }}>{currentMeta.label}</h1>
          <span className="text-[10px] text-zinc-600 font-mono" title={`Build time: ${process.env.NEXT_PUBLIC_BUILD_TIME}`}>
            build {process.env.NEXT_PUBLIC_COMMIT_SHA || "dev"}
          </span>
        </div>
      </div>

      <main className="px-4 pb-12">{children}</main>

      <footer className="border-t border-zinc-900 px-4 py-3 text-[10px] text-zinc-600 flex items-center justify-between">
        <span>quant.agent · disciplined quantitative system</span>
        <span>v0.1.0</span>
      </footer>
    </div>
  );
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
