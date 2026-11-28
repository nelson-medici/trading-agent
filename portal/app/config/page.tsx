"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import { Code2, Edit2, Check, X, Plus, Trash2, Settings, Shield, TrendingUp, Layers, Globe, Zap } from "lucide-react";

interface Config {
  key: string;
  value: any;
  category: string;
  description: string | null;
  updated_at: string | null;
}

// Tab definitions with categories they contain
const TABS = [
  { id: "sistema", label: "Sistema", icon: Settings, categories: ["system", "execution", "llm"], description: "Entorno, broker, modelos LLM" },
  { id: "estrategia", label: "Estrategia", icon: TrendingUp, categories: ["strategy", "strategies"], description: "Pesos, umbrales, señales" },
  { id: "riesgo", label: "Riesgo", icon: Shield, categories: ["risk"], description: "Stops, sizing, drawdown" },
  { id: "pools", label: "Pools", icon: Layers, categories: ["pools"], description: "Core, tactical, equities" },
  { id: "universo", label: "Universo", icon: Globe, categories: ["universe"], description: "Activos habilitados" },
  { id: "scalper", label: "Scalper", icon: Zap, categories: ["scalper"], description: "Auto-start, detector, sesión" },
] as const;

export default function ConfigPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [configs, setConfigs] = useState<Config[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<any>(null);
  const [rawMode, setRawMode] = useState<string | null>(null);
  const [rawValue, setRawValue] = useState<string>("");
  const [msg, setMsg] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState("sistema");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) { router.push("/login"); return; }
      setLoading(false);
    });
  }, [router, supabase]);

  async function load() {
    const { data } = await supabase.from("config").select("*").order("category").order("key");
    if (data) setConfigs(data as Config[]);
  }

  useEffect(() => {
    if (loading) return;
    load();
  }, [loading]);

  if (loading) return null;

  function startEdit(c: Config) {
    setEditing(c.key);
    setDraft(JSON.parse(JSON.stringify(c.value)));
    setRawMode(null);
    setMsg("");
  }

  function cancelEdit() {
    setEditing(null);
    setDraft(null);
    setRawMode(null);
    setRawValue("");
    setMsg("");
  }

  async function saveEdit(key: string) {
    const toSave = rawMode === key ? parseRaw() : draft;
    if (toSave === null) return;
    setBusy(true);
    const { error } = await supabase.from("config").update({ value: toSave }).eq("key", key);
    setBusy(false);
    if (error) { setMsg(`Error: ${error.message}`); return; }
    setMsg(`${key} actualizado. Engine toma el cambio en el próximo refresh de config.`);
    cancelEdit();
    await load();
    setTimeout(() => setMsg(""), 4000);
  }

  function parseRaw(): any {
    try { return JSON.parse(rawValue); }
    catch (e: any) { setMsg(`JSON inválido: ${e.message}`); return null; }
  }

  function toggleRaw(c: Config) {
    if (rawMode === c.key) {
      setRawMode(null);
    } else {
      setRawValue(JSON.stringify(draft, null, 2));
      setRawMode(c.key);
    }
  }

  // Filter configs for current tab
  const currentTabDef = TABS.find((t) => t.id === activeTab)!;
  const tabConfigs = configs.filter((c) => (currentTabDef.categories as readonly string[]).includes(c.category));

  // Count items per tab for badges
  const tabCounts = TABS.map((t) => ({
    id: t.id,
    count: configs.filter((c) => (t.categories as readonly string[]).includes(c.category)).length,
  }));

  return (
    <Shell current="config">
      <div className="space-y-4">
        {/* Warning banner */}
        <div className="border border-amber-900 bg-amber-950/10 p-3 text-[11px] text-amber-300">
          ⚠️ Cambios acá afectan directamente el comportamiento del engine. Los parámetros de riesgo son críticos — no los subas sin análisis.
        </div>

        {msg && (
          <div className={`border px-4 py-2 text-xs ${msg.startsWith("Error") ? "border-red-700 bg-red-950/30 text-red-300" : "border-lime-700 bg-lime-950/30 text-lime-300"}`}>
            {msg}
          </div>
        )}

        {/* Tab navigation */}
        <div className="flex gap-1 overflow-x-auto pb-1 border-b border-zinc-800">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const count = tabCounts.find((tc) => tc.id === tab.id)?.count ?? 0;
            const isActive = activeTab === tab.id;
            return (
              <button key={tab.id} onClick={() => { setActiveTab(tab.id); cancelEdit(); }}
                className={`flex items-center gap-2 px-3 py-2 text-xs whitespace-nowrap transition-colors border-b-2 -mb-[1px] ${
                  isActive
                    ? "border-violet-500 text-violet-300 bg-violet-950/20"
                    : "border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-700"
                }`}>
                <Icon className="w-3.5 h-3.5" />
                <span className="font-medium">{tab.label}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                  isActive ? "bg-violet-900/50 text-violet-300" : "bg-zinc-900 text-zinc-600"
                }`}>{count}</span>
              </button>
            );
          })}
        </div>

        {/* Tab description */}
        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-600">
          {currentTabDef.description}
        </div>

        {/* Config items for active tab */}
        <div className="space-y-2">
          {tabConfigs.length === 0 && (
            <div className="text-zinc-600 text-xs py-8 text-center">No hay configuraciones en esta sección.</div>
          )}
          {tabConfigs.map((c) => (
            <div key={c.key} className="border border-zinc-800 bg-zinc-950 p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <div className="text-sm text-zinc-100 font-medium">{humanizeKey(c.key)}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-zinc-600 font-mono">{c.key}</span>
                    <span className="text-[9px] px-1.5 py-0.5 bg-zinc-900 text-zinc-500 uppercase tracking-wider">{c.category}</span>
                  </div>
                  {c.description && <div className="text-[11px] text-zinc-500 mt-1">{c.description}</div>}
                </div>
                {editing !== c.key ? (
                  <button onClick={() => startEdit(c)}
                    className="text-[10px] uppercase tracking-wider border border-zinc-700 px-2 py-1 hover:border-lime-500 hover:text-lime-400 flex items-center gap-1">
                    <Edit2 className="w-3 h-3" /> editar
                  </button>
                ) : (
                  <div className="flex gap-1">
                    <button onClick={() => toggleRaw(c)}
                      title={rawMode === c.key ? "Modo formulario" : "Modo JSON raw"}
                      className="text-[10px] uppercase tracking-wider border border-zinc-700 px-2 py-1 hover:border-zinc-500 flex items-center gap-1">
                      <Code2 className="w-3 h-3" /> {rawMode === c.key ? "form" : "raw"}
                    </button>
                  </div>
                )}
              </div>

              {editing === c.key ? (
                <div>
                  {rawMode === c.key ? (
                    <textarea value={rawValue} onChange={(e) => setRawValue(e.target.value)}
                      rows={Math.max(4, rawValue.split("\n").length)}
                      className="w-full bg-black border border-zinc-800 p-2 text-xs text-lime-300 font-mono focus:border-lime-500 outline-none" />
                  ) : (
                    <ValueEditor value={draft} onChange={setDraft} path="" keyName={c.key} />
                  )}

                  <div className="flex gap-2 mt-3">
                    <button onClick={() => saveEdit(c.key)} disabled={busy}
                      className="border border-lime-700 hover:border-lime-500 text-lime-300 hover:bg-lime-950/50 px-3 py-1.5 text-[11px] uppercase tracking-wider disabled:opacity-50 flex items-center gap-1">
                      <Check className="w-3 h-3" /> guardar
                    </button>
                    <button onClick={cancelEdit}
                      className="border border-zinc-700 text-zinc-400 px-3 py-1.5 text-[11px] uppercase tracking-wider hover:border-zinc-500 flex items-center gap-1">
                      <X className="w-3 h-3" /> cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <ValuePreview value={c.value} keyName={c.key} />
              )}
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}

// ============================================================
// RENDERERS
// ============================================================

function humanizeKey(key: string): string {
  const parts = key.split(".");
  const last = parts[parts.length - 1];
  return last.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeField(field: string): string {
  return field.replace(/_/g, " ").replace(/\bpct\b/gi, "%").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isPctField(field: string): boolean {
  return field.endsWith("_pct") || field.includes("_pct_");
}

function ValuePreview({ value, keyName }: { value: any; keyName: string }) {
  if (Array.isArray(value)) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 ? <span className="text-zinc-600 text-xs">(vacío)</span> : value.map((v, i) => (
          <span key={i} className="text-[11px] bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-zinc-300 font-mono">
            {typeof v === "string" ? v : JSON.stringify(v)}
          </span>
        ))}
      </div>
    );
  }
  if (typeof value === "object" && value !== null) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        {Object.entries(value).map(([k, v]) => {
          if (typeof v === "object" && v !== null && !Array.isArray(v)) {
            return (
              <div key={k} className="border border-zinc-900 p-2 md:col-span-2 lg:col-span-3">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">{humanizeField(k)}</div>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5 pl-2 border-l-2 border-zinc-800">
                  {Object.entries(v).map(([sk, sv]) => (
                    <div key={sk} className="bg-zinc-900/50 px-2 py-1.5">
                      <div className="text-[9px] uppercase tracking-wider text-zinc-600">{humanizeField(sk)}</div>
                      <div className="text-xs text-zinc-200 tabular-nums font-mono mt-0.5">
                        {formatScalar(sv, isPctField(sk))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          if (Array.isArray(v)) {
            return (
              <div key={k} className="border border-zinc-900 p-2 md:col-span-2 lg:col-span-3">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{humanizeField(k)}</div>
                <div className="flex flex-wrap gap-1">
                  {v.length === 0 ? <span className="text-zinc-600 text-[11px]">(vacío)</span> : v.map((item, i) => (
                    <span key={i} className="text-[11px] bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-zinc-300 font-mono">
                      {typeof item === "string" ? item : JSON.stringify(item)}
                    </span>
                  ))}
                </div>
              </div>
            );
          }
          return (
            <div key={k} className="border border-zinc-900 p-2">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">{humanizeField(k)}</div>
              <div className="text-sm text-zinc-200 tabular-nums font-mono mt-0.5">
                {formatScalar(v, isPctField(k))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  return <div className="text-sm text-zinc-200 font-mono">{formatScalar(value, isPctField(keyName))}</div>;
}

function formatScalar(v: any, isPct: boolean): string {
  if (typeof v === "boolean") return v ? "✓ true" : "✗ false";
  if (typeof v === "number") {
    if (isPct) return `${(v * 100).toFixed(2)}%`;
    return v.toString();
  }
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function ValueEditor({ value, onChange, path, keyName }: { value: any; onChange: (v: any) => void; path: string; keyName: string }) {
  if (Array.isArray(value)) {
    return <ArrayEditor value={value} onChange={onChange} />;
  }
  if (typeof value === "object" && value !== null) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {Object.entries(value).map(([k, v]) => (
          <FieldEditor key={k} field={k} value={v}
            onChange={(newV) => onChange({ ...value, [k]: newV })} />
        ))}
      </div>
    );
  }
  return <FieldEditor field={keyName} value={value} onChange={onChange} />;
}

function FieldEditor({ field, value, onChange }: { field: string; value: any; onChange: (v: any) => void }) {
  const isPct = isPctField(field);

  if (typeof value === "boolean") {
    return (
      <div className="border border-zinc-900 p-3 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">{humanizeField(field)}</div>
          <div className="text-[9px] text-zinc-600 font-mono">{field}</div>
        </div>
        <button onClick={() => onChange(!value)}
          className={`relative w-10 h-5 border transition-colors ${value ? "border-lime-500 bg-lime-950" : "border-zinc-700 bg-zinc-900"}`}>
          <span className={`absolute top-0.5 w-4 h-4 transition-transform ${value ? "bg-lime-400 translate-x-5" : "bg-zinc-500 translate-x-0.5"}`} />
        </button>
      </div>
    );
  }

  if (typeof value === "number") {
    const displayValue = isPct ? (value * 100).toString() : value.toString();
    return (
      <div className="border border-zinc-900 p-3">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">{humanizeField(field)}</div>
        <div className="text-[9px] text-zinc-600 font-mono mb-1">{field}</div>
        <div className="flex items-center gap-1">
          <input type="number" step={isPct ? 0.1 : "any"} value={displayValue}
            onChange={(e) => {
              const raw = parseFloat(e.target.value);
              if (isNaN(raw)) { onChange(0); return; }
              onChange(isPct ? raw / 100 : raw);
            }}
            className="flex-1 bg-black border border-zinc-800 px-2 py-1 text-sm text-zinc-100 focus:border-lime-500 outline-none font-mono tabular-nums" />
          {isPct && <span className="text-xs text-zinc-500">%</span>}
        </div>
      </div>
    );
  }

  if (typeof value === "string") {
    const enumValues = guessEnum(field);
    return (
      <div className="border border-zinc-900 p-3">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">{humanizeField(field)}</div>
        <div className="text-[9px] text-zinc-600 font-mono mb-1">{field}</div>
        {enumValues ? (
          <select value={value} onChange={(e) => onChange(e.target.value)}
            className="w-full bg-black border border-zinc-800 px-2 py-1 text-sm text-zinc-100 focus:border-lime-500 outline-none font-mono">
            {enumValues.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        ) : (
          <input type="text" value={value} onChange={(e) => onChange(e.target.value)}
            className="w-full bg-black border border-zinc-800 px-2 py-1 text-sm text-zinc-100 focus:border-lime-500 outline-none font-mono" />
        )}
      </div>
    );
  }

  if (Array.isArray(value)) {
    return (
      <div className="border border-zinc-900 p-3 md:col-span-2">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">{humanizeField(field)}</div>
        <div className="text-[9px] text-zinc-600 font-mono mb-2">{field}</div>
        <ArrayEditor value={value} onChange={onChange} />
      </div>
    );
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return (
      <div className="border border-zinc-900 p-3 md:col-span-2">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">{humanizeField(field)}</div>
        <div className="text-[9px] text-zinc-600 font-mono mb-2">{field}</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pl-2 border-l-2 border-zinc-800">
          {Object.entries(value).map(([k, v]) => (
            <FieldEditor key={k} field={k} value={v}
              onChange={(newV) => onChange({ ...value, [k]: newV })} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="border border-zinc-900 p-3 md:col-span-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{humanizeField(field)}</div>
      <div className="text-[9px] text-zinc-600 font-mono mb-1">{field}</div>
      <textarea value={JSON.stringify(value, null, 2)}
        onChange={(e) => { try { onChange(JSON.parse(e.target.value)); } catch {} }}
        rows={3}
        className="w-full bg-black border border-zinc-800 p-2 text-xs text-lime-300 font-mono focus:border-lime-500 outline-none" />
    </div>
  );
}

function ArrayEditor({ value, onChange }: { value: any[]; onChange: (v: any[]) => void }) {
  const [newItem, setNewItem] = useState("");

  function add() {
    if (!newItem.trim()) return;
    onChange([...value, newItem.trim()]);
    setNewItem("");
  }
  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {value.map((v, i) => (
          <span key={i} className="text-[11px] bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-zinc-300 font-mono flex items-center gap-1">
            {typeof v === "string" ? v : JSON.stringify(v)}
            <button onClick={() => remove(i)} className="text-zinc-500 hover:text-red-400">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <input type="text" value={newItem} onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="agregar..."
          className="flex-1 bg-black border border-zinc-800 px-2 py-1 text-xs text-zinc-100 focus:border-lime-500 outline-none font-mono" />
        <button onClick={add} className="border border-zinc-700 hover:border-lime-500 hover:text-lime-400 px-2 text-xs">
          <Plus className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

function guessEnum(field: string): string[] | null {
  const map: Record<string, string[]> = {
    env: ["dev", "paper", "live"],
    log_level: ["DEBUG", "INFO", "WARN", "ERROR"],
    broker: ["paper", "binance_testnet", "binance"],
    order_type: ["limit", "market"],
    provider: ["groq", "anthropic", "openai"],
    timezone: ["UTC", "America/Argentina/Buenos_Aires"],
  };
  return map[field] || null;
}
