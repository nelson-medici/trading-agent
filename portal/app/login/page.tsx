"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { Terminal } from "lucide-react";

export default function LoginPage() {
  const supabase = createClient();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      router.push("/");
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-8 h-8 border border-lime-500 flex items-center justify-center">
            <Terminal className="w-4 h-4 text-lime-400" />
          </div>
          <div>
            <div className="text-lg text-zinc-100" style={{ fontFamily: "Fraunces, serif" }}>
              Quant<span className="text-lime-400">.</span>Agent
            </div>
            <div className="text-[9px] uppercase tracking-[0.2em] text-zinc-600 -mt-1">login</div>
          </div>
        </div>
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono block mb-1">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-lime-500 outline-none font-mono" required />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono block mb-1">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-lime-500 outline-none font-mono" required />
          </div>
          {error && <div className="text-xs text-red-400 font-mono">{error}</div>}
          <button type="submit" disabled={loading}
            className="w-full border border-lime-700 hover:border-lime-500 text-lime-300 hover:bg-lime-950/50 py-2 text-xs font-mono uppercase tracking-wider transition-colors disabled:opacity-50">
            {loading ? "..." : "entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
