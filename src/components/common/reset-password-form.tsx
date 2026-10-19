"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { browserSupabase } from "@/lib/supabase/client";
import { DEFAULT_AFTER_SIGN_IN, friendlyAuthError } from "@/lib/auth-flow";
import { Button, Input, Notice } from "@/components/ui/primitives";

/** Sets a new password for the recovery session a reset link signed in. */
export function ResetPasswordForm({ url, supabaseKey, email }: { url: string; supabaseKey: string; email: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  const submit = async () => {
    setError(null);
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirm) return setError("The passwords don’t match.");
    setBusy(true);
    try {
      const supabase = browserSupabase(url, supabaseKey);
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setExpired(true);
        return;
      }
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      router.replace(DEFAULT_AFTER_SIGN_IN);
      router.refresh();
    } catch (e) {
      const m = String((e as Error)?.message ?? "");
      setError(/session|jwt|expired/i.test(m) ? "Your reset link has expired. Request a new one from the sign-in page." : friendlyAuthError(m, "reset"));
    } finally {
      setBusy(false);
    }
  };

  if (expired) {
    return (
      <Notice tone="warning" title="Reset link expired">
        Your reset session has ended. <Link href="/login" className="text-accent hover:underline">Go to sign in</Link> and choose “Forgot password?” to get a new link.
      </Notice>
    );
  }

  return (
    <div>
      <h1 className="font-serif text-[34px] leading-[1.05] tracking-[-0.01em]">Choose a new password</h1>
      <p className="mt-1 text-sm text-muted">{email ? `For ${email}.` : "For your NOVA account."} You’ll stay signed in afterwards.</p>
      <form
        className="mt-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs text-muted">New password</span>
          <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Confirm new password</span>
          <Input type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" className="w-full" loading={busy}>Update password</Button>
      </form>
    </div>
  );
}
