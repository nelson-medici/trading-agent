"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Shell from "@/components/Shell";
import { Eye, Zap, Clock, XCircle, CheckCircle2, AlertTriangle, Trash2, ExternalLink } from "lucide-react";

interface Trigger {
  id: string;
  symbol: string;
  timeframe: string;
  pattern_name: string;
  bias: string;
  confirmation_rule: string;
  trigger_type: string;
  trigger_price: number | null;
  trigger_rsi: number | null;
  require_volume: boolean;
  action: string;
  pool: string;
  max_capital_usd: number;
  stop_atr_mult: number;
  target_atr_mult: number;
  status: string;
  created_at: string;
  expires_at: string | null;
  triggered_at: string | null;
  trigger_detail: string | null;
  decision_id: string | null;
  created_by: string | null;
}

type TabFilter = "watching" | "triggered" | "expired" | "all";

export default function TriggersPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [tab, setTab] = useState<TabFilter>("watching");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      setLoading(false);
    });
  }, [router, supabase]);

  useEffect(() => {
    if (loading) return;
    async function load() {
      const query = supabase
        .from("pattern_triggers")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);

      if (tab !== "all") {
        query.eq("status", tab);
      }

      const { data } = await query;
      if (data) setTriggers(data as Trigger[]);
    }
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [loading, tab, supabase]);

  const counts = {
    watching: triggers.filter((t) => t.status === "watching").length,
    triggered: triggers.filter((t) => t.status === "triggered").length,
    expired: triggers.filter((t) => t.status === "expired").length,
  };

  // Para el tab "all", recalcular counts
  const [allCounts, setAllCounts] = useState({ watching: 0, triggered: 0, expired: 0 });
  useEffect(() => {
    if (loading) return;
    supabase
      .from("pattern_triggers")
      .select("status")
      .then(({ data }) => {
        if (!data) return;
        setAllCounts({
          watching: data.filter((r: any) => r.status === "watching").length,
          triggered: data.filter((r: any) => r.status === "triggered").length,
          expired: data.filter((r: any) => r.status === "expired").length,
        });
      });
  }, [loading, triggers, supabase]);

  async function cancelTrigger(id: string) {
    await supabase.from("pattern_triggers").update({ status: "expired", trigger_detail: "Cancelado manualmente" }).eq("id", id);
    setTriggers((prev) => prev.filter((t) => t.id !== id));
  }

  if (loading) return null;

  const statusIcon = (status: string) => {
    switch (status) {
      case "watching": return <Eye className="w-3.5 h-3.5 text-amber-400" />;
      case "triggered": return <Zap className="w-3.5 h-3.5 text-emerald-400" />;
      case "expired": return <Clock className="w-3.5 h-3.5 text-zinc-500" />;
      default: return <AlertTriangle className="w-3.5 h-3.5 text-zinc-500" />;
    }
  };

  const biasColor = (bias: string) =>
    bias === "bullish" ? "text-emerald-400" : bias === "bearish" ? "text-red-400" : "text-zinc-400";

  const statusBg = (status: string) =>
    status === "watching" ? "bg-amber-950/20 border-amber-900/30" :
    status === "triggered" ? "bg-emerald-950/20 border-emerald-900/30" :
    "bg-zinc-900/30 border-zinc-800";

  function timeAgo(ts: string): string {
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  function timeUntil(ts: string): string {
    const diff = new Date(ts).getTime() - Date.now();
    if (diff <= 0) return "expirado";
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h`;
  }

  return (
    <Shell current="triggers">
      <div className="space-y-4">
        {/* KPIs */}
        <div className="grid grid-cols-3 gap-3">
          <div className="border border-amber-900/30 bg-amber-950/10 p-3">
            <div className="flex items-center gap-2 mb-1">
              <Eye className="w-4 h-4 text-amber-400" />
              <span className="text-[10px] uppercase tracking-wider text-amber-400">Vigilando</span>
            </div>
            <div className="text-2xl font-bold text-amber-300 tabular-nums">{allCounts.watching}</div>
          </div>
          <div className="border border-emerald-900/30 bg-emerald-950/10 p-3">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="w-4 h-4 text-emerald-400" />
              <span className="text-[10px] uppercase tracking-wider text-emerald-400">Ejecutados</span>
            </div>
            <div className="text-2xl font-bold text-emerald-300 tabular-nums">{allCounts.triggered}</div>
          </div>
          <div className="border border-zinc-800 bg-zinc-900/30 p-3">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="w-4 h-4 text-zinc-500" />
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Expirados</span>
            </div>
            <div className="text-2xl font-bold text-zinc-400 tabular-nums">{allCounts.expired}</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1">
          {(["watching", "triggered", "expired", "all"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`text-[10px] uppercase tracking-wider px-3 py-1.5 border transition-colors ${
                tab === t
                  ? t === "watching" ? "border-amber-600 text-amber-300 bg-amber-950/30"
                  : t === "triggered" ? "border-emerald-600 text-emerald-300 bg-emerald-950/30"
                  : t === "expired" ? "border-zinc-600 text-zinc-300 bg-zinc-900"
                  : "border-violet-600 text-violet-300 bg-violet-950/30"
                  : "border-zinc-800 text-zinc-600 hover:text-zinc-300"
              }`}>
              {t === "watching" ? `👁 Vigilando` :
               t === "triggered" ? `⚡ Ejecutados` :
               t === "expired" ? `⏱ Expirados` : `Todos`}
            </button>
          ))}
        </div>

        {/* Lista de triggers */}
        <div className="space-y-2">
          {triggers.length === 0 && (
            <div className="border border-zinc-800 bg-zinc-950 p-8 text-center text-zinc-600 text-xs">
              {tab === "watching" ? "No hay triggers activos. El auto-analyzer crea triggers cada 15 min." :
               tab === "triggered" ? "No hay triggers ejecutados aún." :
               tab === "expired" ? "No hay triggers expirados." : "No hay triggers."}
            </div>
          )}

          {triggers.map((t) => (
            <div key={t.id} className={`border ${statusBg(t.status)} p-3`}>
              <div className="flex items-start justify-between gap-3">
                {/* Left: pattern info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {statusIcon(t.status)}
                    <span className="text-[13px] font-medium text-zinc-100">{t.pattern_name}</span>
                    <span className={`text-[10px] font-medium ${biasColor(t.bias)}`}>
                      {t.bias === "bullish" ? "▲" : "▼"} {t.bias}
                    </span>
                    <Link href={`/charts?symbol=${encodeURIComponent(t.symbol)}`}
                      className="text-[11px] text-zinc-400 hover:text-zinc-200 font-mono flex items-center gap-0.5">
                      {t.symbol} <ExternalLink className="w-2.5 h-2.5" />
                    </Link>
                  </div>

                  {/* Confirmation rule */}
                  <div className="text-[11px] text-zinc-400 mb-1.5">{t.confirmation_rule}</div>

                  {/* Trigger details row */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
                    <span className="text-zinc-500">
                      Tipo: <span className="text-zinc-300">{t.trigger_type.replace(/_/g, " ")}</span>
                    </span>
                    {t.trigger_price != null && (
                      <span className="text-zinc-500">
                        Precio: <span className="text-zinc-200 tabular-nums">${Number(t.trigger_price).toFixed(2)}</span>
                      </span>
                    )}
                    {t.trigger_rsi != null && (
                      <span className="text-zinc-500">
                        RSI: <span className="text-zinc-200 tabular-nums">{Number(t.trigger_rsi).toFixed(0)}</span>
                      </span>
                    )}
                    <span className="text-zinc-500">
                      Pool: <span className="text-zinc-300">{t.pool}</span>
                    </span>
                    <span className="text-zinc-500">
                      Acción: <span className={t.action === "BUY" ? "text-emerald-400" : "text-amber-400"}>{t.action}</span>
                    </span>
                    <span className="text-zinc-500">
                      Capital: <span className="text-zinc-300 tabular-nums">${Number(t.max_capital_usd).toFixed(0)}</span>
                    </span>
                    {t.require_volume && (
                      <span className="text-zinc-500">Vol ✓</span>
                    )}
                  </div>

                  {/* Triggered detail */}
                  {t.status === "triggered" && t.trigger_detail && (
                    <div className="mt-1.5 text-[10px] text-emerald-400/80 border-l-2 border-emerald-700 pl-2">
                      {t.trigger_detail}
                    </div>
                  )}
                </div>

                {/* Right: timestamps + actions */}
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 ${
                    t.status === "watching" ? "bg-amber-900/40 text-amber-300" :
                    t.status === "triggered" ? "bg-emerald-900/40 text-emerald-300" :
                    "bg-zinc-800 text-zinc-500"
                  }`}>{t.status}</span>

                  <div className="text-[9px] text-zinc-600 tabular-nums text-right space-y-0.5">
                    <div>Creado: {timeAgo(t.created_at)}</div>
                    {t.expires_at && t.status === "watching" && (
                      <div>Expira: {timeUntil(t.expires_at)}</div>
                    )}
                    {t.triggered_at && (
                      <div>Disparó: {timeAgo(t.triggered_at)}</div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 text-[9px]">
                    <span className={`px-1 py-0.5 ${
                      t.created_by === "auto_analyzer" ? "bg-violet-900/30 text-violet-400" :
                      "bg-zinc-800 text-zinc-500"
                    }`}>{t.created_by === "auto_analyzer" ? "auto" : t.created_by || "manual"}</span>
                    <span className="text-zinc-700">{t.timeframe}</span>
                  </div>

                  {t.status === "watching" && (
                    <button onClick={() => cancelTrigger(t.id)}
                      className="mt-1 flex items-center gap-1 text-[9px] text-zinc-600 hover:text-red-400 transition-colors">
                      <Trash2 className="w-3 h-3" /> cancelar
                    </button>
                  )}

                  {t.decision_id && (
                    <Link href={`/decisions`}
                      className="text-[9px] text-violet-400 hover:text-violet-300 flex items-center gap-0.5">
                      Ver decisión <ExternalLink className="w-2.5 h-2.5" />
                    </Link>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
