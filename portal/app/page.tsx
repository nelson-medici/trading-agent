"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Shell from "@/components/Shell";
import OverviewView from "@/components/OverviewView";

export default function HomePage() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.push("/login");
      } else {
        setLoading(false);
      }
    });
  }, [router, supabase]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-zinc-500 flex items-center justify-center font-mono text-xs">
        cargando...
      </div>
    );
  }

  return (
    <Shell current="overview">
      <OverviewView />
    </Shell>
  );
}
