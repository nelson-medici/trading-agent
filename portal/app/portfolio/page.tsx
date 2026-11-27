"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";

export default function PortfolioPage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) router.push("/login");
      else setLoading(false);
    });
  }, [router, supabase]);

  if (loading) return null;

  return (
    <Shell current="portfolio">
      <div className="border border-zinc-800 bg-zinc-950 p-8 text-center text-xs text-zinc-500">
        Vista <code className="text-lime-400">portfolio</code> — implementación completa en el portal.jsx entregado antes.
      </div>
    </Shell>
  );
}
