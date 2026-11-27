"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Activity, Wallet, Brain, Settings as SettingsIcon, Shield, Terminal, Wifi, Server, LogOut, User } from "lucide-react";

type View = "overview" | "portfolio" | "decisions" | "config" | "control";

const NAV: { id: View; label: string; icon: any; href: string }[] = [
  { id: "overview", label: "Overview", icon: Activity, href: "/" },
  { id: "portfolio", label: "Portafolio", icon: Wallet, href: "/portfolio" },
  { id: "decisions", label: "Decisiones", icon: Brain, href: "/decisions" },
  { id: "config", label: "Configuración", icon: SettingsIcon, href: "/config" },
  { id: "control", label: "Control", icon: Shield, href: "/control" },
];

export default function Shell({ current, children }: { current: View; children: React.ReactNode }) {
  const [now, setNow] = useState(new Date());
  const [email, setEmail] = useState<string>("");
  const [menuOpen, setMenuOpen] = useState(false);
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

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  const currentView = NAV.find((v) => v.id === current)!;

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
          <div className="flex items-center gap-4 text-[11px]">
            <div className="hidden md:flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse" />
              <span className="text-zinc-400">dev · paper broker</span>
            </div>
            <div className="text-zinc-500">{now.toISOString().slice(0, 19).replace("T", " ")} <span className="text-zinc-700">UTC</span></div>

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
                  <div className="absolute right-0 top-full mt-1 bg-zinc-950 border border-zinc-800 py-1 min-w-[180px] z-50">
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
          <div className="ml-auto flex items-center gap-2 text-[10px] text-zinc-500 pr-2">
            <Server className="w-3 h-3" />
            <span>oracle.cloud</span>
            <span className="text-zinc-700">·</span>
            <Wifi className="w-3 h-3 text-lime-400" />
          </div>
        </nav>
      </header>

      <div className="px-4 pt-6 pb-4">
        <div className="text-[10px] uppercase tracking-[0.25em] text-zinc-600">// {currentView.id}.view</div>
        <h1 className="text-3xl text-zinc-100 mt-1" style={{ fontFamily: "Fraunces, serif", fontWeight: 300 }}>{currentView.label}</h1>
      </div>

      <main className="px-4 pb-12">{children}</main>

      <footer className="border-t border-zinc-900 px-4 py-3 text-[10px] text-zinc-600 flex items-center justify-between">
        <span>quant.agent · disciplined quantitative system</span>
        <span>v0.1.0</span>
      </footer>
    </div>
  );
}
