"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";

interface Config {
  key: string;
  value: any;
  category: string;
  description: string | null;
  updated_at: string | null;
}

export default function ConfigPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [configs, setConfigs] = useState<Config[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [msg, setMsg] = useState<string>("");
  const [busy, setBusy] = useState(false);

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

  async function startEdit(c: Config) {
    setEditing(c.key);
    setEditValue(JSON.stringify(c.value, null, 2));
    setMsg("");
  }

  async function saveEdit(key: string) {
    let parsed: any;
    try {
      parsed = JSON.parse(editValue);
    } catch (e: any) {
      setMsg(`JSON inválido: ${e.message}`);
      return;
    }
    if (!window.confirm(`Confirmás guardar el nuevo valor para ${key}?`)) return;
    setBusy(true);
    const { error } = await supabase.from("config").update({ value: parsed }).eq("key", key);
    setBusy(false);
    if (error) { setMsg(`Error: ${error.message}`); return; }
    setMsg(`${key} actualizado. Engine lo va a leer en el próximo refresh de config.`);
    setEditing(null);
    await load();
    setTimeout(() => setMsg(""), 5000);
  }

  function cancelEdit() {
    setEditing(null);
    setEditValue("");
    setMsg("");
  }

  const byCategory = configs.reduce((acc: Record<string, Config[]>, c) => {
    if (!acc[c.category]) acc[c.category] = [];
    acc[c.category].push(c);
    return acc;
  }, {});

  return (
    <Shell current="config">
      <div className="space-y-6">
        <div className="border border-amber-900 bg-amber-950/10 p-3 text-[11px] text-amber-300">
          ⚠️ Cambios acá afectan directamente el comportamiento del engine. Los parámetros de riesgo son críticos — no los subas sin análisis.
        </div>

        {msg && (
          <div className="border border-lime-700 bg-lime-950/30 px-4 py-2 text-xs text-lime-300">{msg}</div>
        )}

        {Object.entries(byCategory).map(([cat, items]) => (
          <section key={cat}>
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-zinc-500 mb-2">// {cat}</h2>
            <div className="space-y-2">
              {items.map((c) => (
                <div key={c.key} className="border border-zinc-800 bg-zinc-950 p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="text-sm text-zinc-100 font-medium">{c.key}</div>
                      {c.description && <div className="text-[11px] text-zinc-500 mt-0.5">{c.description}</div>}
                    </div>
                    {editing !== c.key && (
                      <button onClick={() => startEdit(c)}
                        className="text-[10px] uppercase tracking-wider border border-zinc-700 px-2 py-1 hover:border-lime-500 hover:text-lime-400">
                        editar
                      </button>
                    )}
                  </div>

                  {editing === c.key ? (
                    <div className="space-y-2">
                      <textarea value={editValue} onChange={(e) => setEditValue(e.target.value)}
                        rows={Math.max(3, editValue.split("\n").length)}
                        className="w-full bg-black border border-zinc-800 p-2 text-xs text-lime-300 font-mono focus:border-lime-500 outline-none" />
                      <div className="flex gap-2">
                        <button onClick={() => saveEdit(c.key)} disabled={busy}
                          className="border border-lime-700 hover:border-lime-500 text-lime-300 hover:bg-lime-950/50 px-3 py-1 text-[11px] uppercase tracking-wider disabled:opacity-50">
                          guardar
                        </button>
                        <button onClick={cancelEdit}
                          className="border border-zinc-700 text-zinc-400 px-3 py-1 text-[11px] uppercase tracking-wider hover:border-zinc-500">
                          cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <pre className="text-[11px] text-zinc-400 font-mono bg-black p-2 border border-zinc-900 overflow-x-auto">{JSON.stringify(c.value, null, 2)}</pre>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Shell>
  );
}
