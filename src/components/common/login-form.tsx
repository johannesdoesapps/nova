"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { browserSupabase } from "@/lib/supabase/client";
import { Button, Input, Notice } from "@/components/ui/primitives";

export function LoginForm({ url, supabaseKey, next, siteUrl }: { url: string; supabaseKey: string; next: string; siteUrl: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    const supabase = browserSupabase(url, supabaseKey);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(next);
        router.refresh();
      } else {
        const origin = typeof window !== "undefined" ? window.location.origin : siteUrl;
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: name.trim() || undefined },
            emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (error) throw error;
        if (data.session) {
          router.replace(next);
          router.refresh();
        } else setInfo("Check your inbox to confirm your email, then sign in.");
      }
    } catch (e) {
      setError((e as Error).message || "Authentication failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="mt-5 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {mode === "signup" && (
        <label className="block">
          <span className="mb-1 block text-xs text-faint">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />
        </label>
      )}
      <label className="block">
        <span className="mb-1 block text-xs text-faint">Email</span>
        <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-faint">Password</span>
        <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
      </label>
      {error && <Notice tone="danger">{error}</Notice>}
      {info && <Notice tone="success">{info}</Notice>}
      <Button type="submit" className="w-full" loading={busy}>{mode === "signin" ? "Sign in" : "Create account"}</Button>
      <p className="text-center text-xs text-faint">
        {mode === "signin" ? "New to NOVA?" : "Already have an account?"}{" "}
        <button type="button" className="text-accent hover:underline" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
          {mode === "signin" ? "Create an account" : "Sign in"}
        </button>
      </p>
    </form>
  );
}
