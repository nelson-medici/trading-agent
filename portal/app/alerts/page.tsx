"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase";
import Shell from "@/components/Shell";
import { Bell, AlertTriangle, AlertOctagon, Info, CheckCheck, Filter as FilterIcon, Trash2 } from "lucide-react";

interface Alert {
  id: string;
  level: string;
  category: string;
  title: string;
  message: string | null;
  metadata: any;
  acknowledged: boolean;
  acknowledged_at: string | null;
  created_at: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  trade: "Trades",
  risk: "Riesgo",
  system: "Sistema",
  regime: "Régimen",
  scalper: "Scalper",
  scalper_opportunity: "Oportunidades",
  config: "Configuración",
};

export default function AlertsPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [fLevel, setFLevel] = useState<string>("all");
  const [fCategory, setFCategory] = useState<string>("all");
  const [fRead, setFRead] = useState<"all" | "unread" | "read">("all");
  const [fDays, setFDays] = useState<number>(7);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      setLoading(false);
    });
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [router, supabase]);

  async function load() {
    const since = new Date(Date.now() - fDays * 24 * 3600_000).toISOString();
    const { data } = await supabase
      .from("alerts")
      .select("*")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);
    if (data) setAlerts(data as Alert[]);
  }

  useEffect(() => {
    if (loading) return;
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, fDays]);

  const filtered = useMemo(() => alerts.filter((a) => {
    if (fLevel !== "all" && a.level !== fLevel) return false;
    if (fCategory !== "all" && a.category !== fCategory) return false;
    if (fRead === "unread" && a.acknowledged) return false;
    if (fRead === "read" && !a.acknowledged) return false;
    return true;
  }), [alerts, fLevel, fCategory, fRead]);

  const stats = useMemo(() => {
    const unread = alerts.filter((a) => !a.acknowledged);
    return {
      total: alerts.length,
      unread: unread.length,
      critical: unread.filter((a) => a.level === "critical").length,
      warn: unread.filter((a) => a.level === "warn").length,
      byCategory: alerts.reduce((acc, a) => {
        acc[a.category] = (acc[a.category] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };
  }, [alerts]);

  const categories = useMemo(() => Array.from(new Set(alerts.map((a) => a.category))).sort(), [alerts]);

  async function ack(ids: string[]) {
    if (!ids.length) return;
    setBusy(true);
    await supabase.from("alerts").update({ acknowledged: true, acknowledged_at: new Date().toISOString() }).in("id", ids);
    setAlerts((prev) => prev.map((a) => ids.includes(a.id) ? { ...a, acknowledged: true } : a));
    setBusy(false);
  }

  async function del(ids: string[]) {
    if (!ids.length) return;
    setBusy(true);
    await supabase.from("alerts").delete().in("id", ids);
    setAlerts((prev) => prev.filter((a) => !ids.includes(a.id)));
    setBusy(false);
  }

  if (loading) return null;

  const unreadVisible = filtered.filter((a) => !a.acknowledged).map((a) => a.id);

  return (
    <Shell current="alerts">
      <div className="space-y-5">

        {/* Resumen */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Sin leer" value={stats.unread} tone={stats.unread > 0 ? "violet" : "neutral"} icon={<Bell className="w-3.5 h-3.5" />} />
          <Stat label="Críticas sin leer" value={stats.critical} tone={stats.critical > 0 ? "danger" : "neutral"} icon={<AlertOctagon className="w-3.5 h-3.5" />} />
          <Stat label="Advertencias sin leer" value={stats.warn} tone={stats.warn > 0 ? "warn" : "neutral"} icon={<AlertTriangle className="w-3.5 h-3.5" />} />
          <Stat label={`Total (${fDays}d)`} value={stats.total} icon={<Info className="w-3.5 h-3.5" />} />
        </div>

        {/* Filtros */}
        <div className="border border-zinc-800 bg-zinc-950 p-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            <FilterIcon className="w-3 h-3" /> filtros
          </span>

          <div className="flex gap-1">
            {(["all", "unread", "read"] as const).map((v) => (
              <Chip key={v} active={fRead === v} onClick={() => setFRead(v)} violet={v === "unread"}>
                {v === "all" ? "Todas" : v === "unread" ? "Sin leer" : "Leídas"}
              </Chip>
            ))}
          </div>

          <div className="flex gap-1">
            {["all", "critical", "warn", "info"].map((v) => (
              <Chip key={v} active={fLevel === v} onClick={() => setFLevel(v)}>
                {v === "all" ? "Todo nivel" : v === "critical" ? "Críticas" : v === "warn" ? "Warn" : "Info"}
              </Chip>
            ))}
          </div>

          <select value={fCategory} onChange={(e) => setFCategory(e.target.value)}
            className="bg-black border border-zinc-800 px-2 py-1 text-[11px] text-zinc-100 focus:border-violet-500 outline-none font-mono">
            <option value="all">Toda categoría</option>
            {categories.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] || c}</option>)}
          </select>

          <div className="flex gap-1">
            {[1, 7, 30, 90].map((d) => (
              <Chip key={d} active={fDays === d} onClick={() => setFDays(d)}>{d}d</Chip>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-3">
            <span className="text-[11px] text-zinc-500">{filtered.length} de {alerts.length}</span>
            {unreadVisible.length > 0 && (
              <button onClick={() => ack(unreadVisible)} disabled={busy}
                className="flex items-center gap-1.5 border border-violet-700 text-violet-300 hover:bg-violet-950/40 px-2.5 py-1 text-[10px] uppercase tracking-wider disabled:opacity-50">
                <CheckCheck className="w-3 h-3" /> Marcar {unreadVisible.length} leídas
              </button>
            )}
            {filtered.length > 0 && (
              <button onClick={() => { if (confirm(`Borrar ${filtered.length} alertas visibles?`)) del(filtered.map((a) => a.id)); }} disabled={busy}
                className="flex items-center gap-1.5 border border-red-900 text-red-400 hover:bg-red-950/30 px-2.5 py-1 text-[10px] uppercase tracking-wider disabled:opacity-50">
                <Trash2 className="w-3 h-3" /> Borrar {filtered.length}
              </button>
            )}
          </div>
        </div>

        {/* Listado */}
        {filtered.length === 0 ? (
          <div className="border border-zinc-800 bg-zinc-950 p-6 text-center text-xs text-zinc-600">
            {alerts.length === 0 ? "Sin alertas en este período." : "Ninguna alerta coincide con los filtros."}
          </div>
        ) : (
          <div className="border border-zinc-800 bg-zinc-950 divide-y divide-zinc-900">
            {filtered.map((a) => <Row key={a.id} alert={a} now={now} onAck={() => ack([a.id])} onDel={() => del([a.id])} />)}
          </div>
        )}
      </div>
    </Shell>
  );
}

function Row({ alert: a, now, onAck, onDel }: { alert: Alert; now: number; onAck: () => void; onDel: () => void }) {
  const icon = {
    critical: <AlertOctagon className="w-3.5 h-3.5 text-red-400" />,
    warn: <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />,
    info: <Info className="w-3.5 h-3.5 text-zinc-500" />,
  }[a.level] || <Info className="w-3.5 h-3.5 text-zinc-500" />;

  const border = {
    critical: "border-l-red-500",
    warn: "border-l-amber-500",
    info: "border-l-zinc-700",
  }[a.level] || "border-l-zinc-700";

  const href = a.metadata?.href as string | undefined;
  const symbol = a.metadata?.symbol as string | undefined;

  return (
    <div className={`relative px-4 py-2.5 border-l-2 ${border} ${a.acknowledged ? "opacity-55" : "bg-violet-950/10"}`}>
      {!a.acknowledged && <span className="absolute left-1.5 top-4 w-1.5 h-1.5 rounded-full bg-violet-400" title="sin leer" />}
      <div className="flex items-start gap-3 pl-2">
        <div className="pt-0.5 flex-shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-zinc-100 font-medium">{a.title}</span>
            <span className="text-[10px] text-zinc-600 tabular-nums whitespace-nowrap">{rel(a.created_at, now)}</span>
          </div>
          {a.message && <div className="text-[11px] text-zinc-400 mt-0.5 leading-snug">{a.message}</div>}
          <div className="flex items-center gap-3 mt-1.5">
            <span className="text-[9px] uppercase tracking-wider text-zinc-600">{CATEGORY_LABEL[a.category] || a.category}</span>
            <span className="text-[9px] text-zinc-700 tabular-nums">{new Date(a.created_at).toLocaleString()}</span>
            {href && <Link href={href} className="text-[9px] uppercase tracking-wider text-violet-400 hover:underline">abrir →</Link>}
            {!href && symbol && <Link href={`/charts?symbol=${encodeURIComponent(symbol)}`} className="text-[9px] uppercase tracking-wider text-violet-400 hover:underline">chart →</Link>}
            <span className="ml-auto flex items-center gap-2">
              {!a.acknowledged && (
                <button onClick={onAck} className="text-[9px] uppercase tracking-wider text-violet-400/80 hover:text-violet-300">
                  marcar leída
                </button>
              )}
              <button onClick={onDel} className="text-[9px] uppercase tracking-wider text-zinc-600 hover:text-red-400" title="Borrar">
                <Trash2 className="w-3 h-3" />
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone = "neutral", icon }: { label: string; value: number; tone?: string; icon?: React.ReactNode }) {
  const color = {
    neutral: "text-zinc-100", violet: "text-violet-300", warn: "text-amber-400", danger: "text-red-400",
  }[tone] || "text-zinc-100";
  const border = tone === "violet" ? "border-violet-800" : tone === "danger" ? "border-red-900" : tone === "warn" ? "border-amber-900" : "border-zinc-800";
  return (
    <div className={`border ${border} bg-zinc-950 p-3`}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 flex items-center gap-1.5">{icon}{label}</div>
      <div className={`mt-1 text-xl font-light tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function Chip({ active, onClick, children, violet = false }: { active: boolean; onClick: () => void; children: React.ReactNode; violet?: boolean }) {
  const activeCls = violet
    ? "border-violet-500 text-violet-300 bg-violet-950/30"
    : "border-lime-500 text-lime-400 bg-lime-950/30";
  return (
    <button onClick={onClick}
      className={`text-[10px] uppercase tracking-wider px-2 py-1 border ${active ? activeCls : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}>
      {children}
    </button>
  );
}

function rel(iso: string, now: number): string {
  const m = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
