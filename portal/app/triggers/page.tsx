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

          {triggers.map((t) => {
            // Explicación "para humanos" del trigger
            const humanExplain = (() => {
              const sym = t.symbol.replace("/USDT", "");
              const priceStr = t.trigger_price != null ? `$${Number(t.trigger_price).toLocaleString("en", { maximumFractionDigits: 2 })}` : "";

              if (t.trigger_type === "breakout_above" && t.bias === "bullish") {
                return `Si ${sym} sube a ${priceStr}, comprar — se espera que siga subiendo`;
              }
              if (t.trigger_type === "breakout_below" && t.bias === "bearish") {
                return `Si ${sym} baja de ${priceStr}, salir o alertar — se espera más caída`;
              }
              if (t.trigger_type === "rsi_cross_above" && t.bias === "bullish") {
                return `${sym} está sobrevendido — si rebota, comprar para aprovechar la recuperación`;
              }
              if (t.trigger_type === "rsi_cross_below" && t.bias === "bearish") {
                return `${sym} está sobrecomprado — si cae, alertar para evitar pérdidas`;
              }
              if (t.trigger_type === "breakout_above") {
                return `Esperando que ${sym} rompa ${priceStr} al alza para confirmar el patrón`;
              }
              if (t.trigger_type === "breakout_below") {
                return `Esperando que ${sym} pierda ${priceStr} para confirmar la señal`;
              }
              return `Vigilando ${sym} — ${t.confirmation_rule}`;
            })();

            // Progress bar: tiempo restante hasta expiración
            const progressPct = (() => {
              if (!t.expires_at || t.status !== "watching") return 0;
              const created = new Date(t.created_at).getTime();
              const expires = new Date(t.expires_at).getTime();
              const now = Date.now();
              const total = expires - created;
              const elapsed = now - created;
              return Math.max(0, Math.min(100, (1 - elapsed / total) * 100));
            })();

            return (
            <div key={t.id} className={`border ${statusBg(t.status)} overflow-hidden`}>
              {/* Progress bar for watching triggers */}
              {t.status === "watching" && (
                <div className="h-0.5 bg-zinc-900">
                  <div className="h-full bg-amber-500/60 transition-all" style={{ width: `${progressPct}%` }} />
                </div>
              )}

              <div className="p-3">
                {/* Row 1: Symbol + Pattern + Status badge */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Link href={`/charts?symbol=${encodeURIComponent(t.symbol)}`}
                      className="text-[14px] font-bold text-zinc-100 hover:text-white font-mono tracking-tight">
                      {t.symbol.replace("/USDT", "")}
                    </Link>
                    <span className={`text-[11px] px-2 py-0.5 font-medium ${
                      t.bias === "bullish" ? "bg-emerald-950/40 text-emerald-300" : "bg-red-950/40 text-red-300"
                    }`}>{t.pattern_name}</span>
                    {t.created_by === "auto_analyzer" && (
                      <span className="text-[8px] px-1 py-0.5 bg-violet-900/30 text-violet-400 uppercase tracking-wider">auto</span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {t.status === "watching" && t.expires_at && (
                      <span className="text-[10px] text-zinc-500 tabular-nums">
                        {timeUntil(t.expires_at)}
                      </span>
                    )}
                    <span className={`text-[9px] uppercase tracking-wider px-2 py-0.5 font-medium ${
                      t.status === "watching" ? "bg-amber-900/40 text-amber-300" :
                      t.status === "triggered" ? "bg-emerald-900/40 text-emerald-300" :
                      "bg-zinc-800 text-zinc-500"
                    }`}>{t.status === "watching" ? "vigilando" : t.status === "triggered" ? "ejecutado" : "expirado"}</span>
                  </div>
                </div>

                {/* Row 2: Human explanation — the key part */}
                <div className={`text-[12px] leading-relaxed mb-2 ${
                  t.status === "triggered" ? "text-emerald-300" : "text-zinc-300"
                }`}>
                  {t.status === "triggered" && t.trigger_detail
                    ? `✓ ${t.trigger_detail}`
                    : humanExplain}
                </div>

                {/* Row 3: Compact metadata */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-[10px] text-zinc-600">
                    <span>{t.timeframe}</span>
                    <span>{t.action === "BUY" ? "🟢 Compra" : "🔔 Alerta"}</span>
                    <span>${Number(t.max_capital_usd).toFixed(0)}</span>
                    <span>{timeAgo(t.created_at)}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {t.decision_id && (
                      <Link href="/decisions"
                        className="text-[9px] text-violet-400 hover:text-violet-300 flex items-center gap-0.5">
                        decisión <ExternalLink className="w-2.5 h-2.5" />
                      </Link>
                    )}
                    <Link href={`/charts?symbol=${encodeURIComponent(t.symbol)}`}
                      className="text-[9px] text-zinc-500 hover:text-zinc-300 flex items-center gap-0.5">
                      chart <ExternalLink className="w-2.5 h-2.5" />
                    </Link>
                    {t.status === "watching" && (
                      <button onClick={() => cancelTrigger(t.id)}
                        className="text-[9px] text-zinc-600 hover:text-red-400 flex items-center gap-0.5 transition-colors">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </Shell>
  );
}
