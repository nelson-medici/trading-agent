"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { formatUsd, formatPct } from "@/lib/utils";
import { Wallet, Layers, Gauge, Activity } from "lucide-react";

interface Summary {
  current_equity: number | null;
  hwm: number | null;
  current_dd: number | null;
  open_positions: number | null;
  candidates: number | null;
  watchlist_count: number | null;
  kill_active: boolean | null;
  unacked_alerts: number | null;
  engine_status: string | null;
  engine_last_heartbeat: string | null;
}

export default function OverviewView() {
  const supabase = createClient();
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from("v_dashboard_summary").select("*").single();
      setSummary(data as Summary);
    }
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [supabase]);

  if (!summary) {
    return <div className="text-zinc-500 text-xs">cargando...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="Equity" value={summary.current_equity != null ? formatUsd(summary.current_equity) : "—"} icon={Wallet} tone="accent" />
        <Stat label="HWM" value={summary.hwm != null ? formatUsd(summary.hwm) : "—"} />
        <Stat label="DD desde HWM" value={summary.current_dd != null ? formatPct(summary.current_dd) : "—"} tone={summary.current_dd && summary.current_dd > 0.08 ? "warn" : "neutral"} icon={Gauge} />
        <Stat label="Posiciones" value={summary.open_positions ?? 0} sub={`${summary.candidates ?? 0} candidatos`} icon={Layers} />
        <Stat label="Engine" value={summary.engine_status ?? "unknown"} sub={summary.engine_last_heartbeat ? new Date(summary.engine_last_heartbeat).toLocaleTimeString() : "sin heartbeat"} tone={summary.engine_status === "healthy" ? "success" : "warn"} icon={Activity} />
      </div>

      {summary.kill_active && (
        <div className="border border-red-800 bg-red-950/20 p-4 text-xs">
          <div className="text-red-300 uppercase tracking-wider text-[10px] mb-1">Kill switch ACTIVO</div>
          <div className="text-zinc-400">Sistema pausado. Ir a Control para revisar y reanudar.</div>
        </div>
      )}

      <div className="border border-zinc-800 bg-zinc-950 p-8 text-center text-xs text-zinc-500">
        <div className="mb-2 uppercase tracking-wider text-[10px]">Sistema en modo dev</div>
        <div>El engine debe estar corriendo en la VM para poblar estos datos.</div>
        <div className="mt-1">Ver <code className="text-lime-400">journalctl -u trading-engine -f</code></div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, icon: Icon, tone = "neutral" }: { label: string; value: any; sub?: string; icon?: any; tone?: string }) {
  const color = { neutral: "text-zinc-100", accent: "text-lime-400", success: "text-emerald-400", warn: "text-amber-400", danger: "text-red-400" }[tone] || "text-zinc-100";
  return (
    <div className="border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-start justify-between">
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
        {Icon && <Icon className="w-3.5 h-3.5 text-zinc-600" />}
      </div>
      <div className={`mt-2 text-2xl font-light ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-zinc-500 mt-1">{sub}</div>}
    </div>
  );
}
