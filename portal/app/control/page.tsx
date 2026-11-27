"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import { formatUsd } from "@/lib/utils";
import Link from "next/link";
import { Shield, AlertCircle, Activity, DollarSign } from "lucide-react";

interface KillSwitch {
  active: boolean;
  activated_at: string | null;
  activated_reason: string | null;
  deactivated_at: string | null;
}

interface Alert {
  id: string;
  level: string;
  category: string;
  title: string;
  message: string | null;
  acknowledged: boolean;
  created_at: string;
}

interface Heartbeat {
  service: string;
  status: string;
  reported_at: string;
}

interface CapitalEvent {
  id: string;
  event_type: string;
  amount_usd: number;
  balance_after_usd: number;
  notes: string | null;
  performed_at: string;
}

export default function ControlPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [kill, setKill] = useState<KillSwitch | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [heartbeat, setHeartbeat] = useState<Heartbeat | null>(null);
  const [capEvents, setCapEvents] = useState<CapitalEvent[]>([]);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositNotes, setDepositNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      setLoading(false);
    });
  }, [router, supabase]);

  async function load() {
    const [ksRes, aRes, hbRes, ceRes] = await Promise.all([
      supabase.from("kill_switch").select("*").eq("id", 1).single(),
      supabase.from("alerts").select("*").order("created_at", { ascending: false }).limit(30),
      supabase.from("heartbeats").select("*").eq("service", "engine").order("reported_at", { ascending: false }).limit(1).single(),
      supabase.from("capital_events").select("*").order("performed_at", { ascending: false }).limit(20),
    ]);
    if (ksRes.data) setKill(ksRes.data as KillSwitch);
    if (aRes.data) setAlerts(aRes.data as Alert[]);
    if (hbRes.data) setHeartbeat(hbRes.data as Heartbeat);
    if (ceRes.data) setCapEvents(ceRes.data as CapitalEvent[]);
  }

  useEffect(() => {
    if (loading) return;
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [loading]);

  if (loading) return null;

  async function toggleKill() {
    if (!kill) return;
    const confirmMsg = kill.active
      ? "¿Confirmás REANUDAR el sistema? Se podrán abrir nuevas posiciones."
      : "¿Confirmás ACTIVAR el kill switch? El sistema no abrirá más posiciones.";
    if (!window.confirm(confirmMsg)) return;
    setBusy(true);
    const reason = kill.active ? null : window.prompt("Razón del kill (opcional):") || "Manual kill from portal";
    const now = new Date().toISOString();
    const payload = kill.active
      ? { active: false, deactivated_at: now }
      : { active: true, activated_at: now, activated_reason: reason };
    const { error } = await supabase.from("kill_switch").update(payload).eq("id", 1);
    setBusy(false);
    if (error) { setMsg(`Error: ${error.message}`); return; }
    setMsg(kill.active ? "Sistema reanudado." : "Kill switch ACTIVADO.");
    await load();
    setTimeout(() => setMsg(""), 5000);
  }

  async function addDeposit() {
    const amt = parseFloat(depositAmount);
    if (!amt || amt <= 0) { setMsg("Monto inválido"); return; }
    if (!window.confirm(`¿Confirmás agregar ${formatUsd(amt)} de capital?`)) return;
    setBusy(true);
    // Última balance
    const { data: lastEvent } = await supabase.from("capital_events")
      .select("balance_after_usd").order("performed_at", { ascending: false }).limit(1).single();
    const prevBalance = lastEvent?.balance_after_usd ?? 0;
    const { error } = await supabase.from("capital_events").insert({
      event_type: "deposit",
      amount_usd: amt,
      balance_after_usd: prevBalance + amt,
      notes: depositNotes || null,
    });
    setBusy(false);
    if (error) { setMsg(`Error: ${error.message}`); return; }
    setMsg(`Deposit de ${formatUsd(amt)} registrado.`);
    setDepositAmount("");
    setDepositNotes("");
    await load();
    setTimeout(() => setMsg(""), 5000);
  }

  const heartbeatAge = heartbeat
    ? Math.floor((Date.now() - new Date(heartbeat.reported_at).getTime()) / 1000)
    : null;
  const engineHealthy = heartbeatAge != null && heartbeatAge < 120;

  return (
    <Shell current="control">
      <div className="space-y-6">
        {msg && (
          <div className="border border-lime-700 bg-lime-950/30 px-4 py-2 text-xs text-lime-300">{msg}</div>
        )}

        {/* Estado general */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className={`border p-4 ${kill?.active ? "border-red-800 bg-red-950/20" : "border-emerald-900 bg-emerald-950/10"}`}>
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Kill switch</div>
                <div className={`text-xl ${kill?.active ? "text-red-400" : "text-emerald-400"}`}>
                  {kill?.active ? "ACTIVO" : "INACTIVO"}
                </div>
                {kill?.active && kill.activated_reason && (
                  <div className="text-[11px] text-zinc-400 mt-1">{kill.activated_reason}</div>
                )}
              </div>
              <Shield className={`w-5 h-5 ${kill?.active ? "text-red-500" : "text-emerald-500"}`} />
            </div>
            <button onClick={toggleKill} disabled={busy}
              className={`mt-3 w-full border py-2 text-[11px] uppercase tracking-wider transition-colors disabled:opacity-50 ${
                kill?.active
                  ? "border-emerald-700 hover:border-emerald-500 text-emerald-300 hover:bg-emerald-950/50"
                  : "border-red-700 hover:border-red-500 text-red-300 hover:bg-red-950/50"
              }`}>
              {kill?.active ? "Reanudar sistema" : "Activar kill switch"}
            </button>
          </div>

          <div className={`border p-4 ${engineHealthy ? "border-emerald-900 bg-emerald-950/10" : "border-amber-900 bg-amber-950/10"}`}>
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Engine</div>
                <div className={`text-xl ${engineHealthy ? "text-emerald-400" : "text-amber-400"}`}>
                  {engineHealthy ? "HEALTHY" : "STALE"}
                </div>
                <div className="text-[11px] text-zinc-400 mt-1">
                  {heartbeatAge != null ? `último heartbeat hace ${heartbeatAge}s` : "sin heartbeat"}
                </div>
              </div>
              <Activity className={`w-5 h-5 ${engineHealthy ? "text-emerald-500" : "text-amber-500"}`} />
            </div>
          </div>

          <Link href="/alerts" className="border border-zinc-800 hover:border-violet-800 bg-zinc-950 p-4 block transition-colors">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Alertas sin leer</div>
                <div className={`text-xl ${alerts.filter(a => !a.acknowledged).length > 0 ? "text-violet-300" : "text-zinc-100"}`}>
                  {alerts.filter(a => !a.acknowledged).length}
                </div>
                <div className="text-[11px] text-violet-400/80 mt-1">ver módulo de alertas →</div>
              </div>
              <AlertCircle className="w-5 h-5 text-violet-400/70" />
            </div>
          </Link>
        </div>

        {/* Aporte de capital */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// Aporte de capital</h2>
          <div className="border border-zinc-800 bg-zinc-950 p-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Monto USD</label>
                <input type="number" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="50" step="0.01" min="0"
                  className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-lime-500 outline-none font-mono" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 block mb-1">Notas (opcional)</label>
                <input type="text" value={depositNotes} onChange={(e) => setDepositNotes(e.target.value)}
                  placeholder="Aporte mensual noviembre"
                  className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-lime-500 outline-none font-mono" />
              </div>
              <button onClick={addDeposit} disabled={busy || !depositAmount}
                className="border border-lime-700 hover:border-lime-500 text-lime-300 hover:bg-lime-950/50 py-2 text-xs uppercase tracking-wider transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                <DollarSign className="w-3.5 h-3.5" />
                Agregar capital
              </button>
            </div>
            <div className="text-[10px] text-zinc-600 mt-2">
              Esto registra un capital event en la DB. Tu balance virtual de paper trading se ajusta al siguiente snapshot (cada 15 min).
            </div>
          </div>

          {/* Historial capital */}
          {capEvents.length > 0 && (
            <div className="mt-3 border border-zinc-800 bg-zinc-950 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="text-left px-3 py-2">Tipo</th>
                    <th className="text-right px-3 py-2">Monto</th>
                    <th className="text-right px-3 py-2">Balance después</th>
                    <th className="text-left px-3 py-2">Notas</th>
                    <th className="text-right px-3 py-2">Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {capEvents.map((e) => (
                    <tr key={e.id} className="border-b border-zinc-900">
                      <td className="px-3 py-2 uppercase text-[10px]">{e.event_type === "deposit" ? <span className="text-emerald-400">deposit</span> : <span className="text-red-400">withdrawal</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatUsd(e.amount_usd)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{formatUsd(e.balance_after_usd)}</td>
                      <td className="px-3 py-2 text-zinc-400 text-[11px]">{e.notes}</td>
                      <td className="px-3 py-2 text-right text-zinc-500 text-[10px]">{new Date(e.performed_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </div>
    </Shell>
  );
}
