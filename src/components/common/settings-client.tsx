"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LogOut, Moon, Sun, Trash2 } from "lucide-react";
import { Button, Input } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
import { LEGAL } from "@/content/legal-meta";
import { forgetAccountData } from "@/lib/sign-out";

export function SettingsClient({ email, displayName, themeOnly }: { email?: string | null; displayName?: string | null; themeOnly?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [stored, setStored] = useLocalStorage("orbis:theme", "dark");
  const theme = stored === "light" ? "light" : "dark";

  const applyTheme = (t: "dark" | "light") => {
    document.documentElement.dataset.theme = t;
    setStored(t);
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await jsonFetch("/api/profile", { method: "PATCH", body: JSON.stringify({ displayName: name.trim() }) });
      setMsg("Saved.");
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const themeRow = (
    <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
      <div>
        <div className="text-sm">Appearance</div>
        <div className="text-xs text-faint">Dark is the default Orbis theme.</div>
      </div>
      <div className="flex rounded-lg border border-border p-0.5">
        <button onClick={() => applyTheme("dark")} aria-pressed={theme === "dark"} className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs ${theme === "dark" ? "bg-accent-soft text-fg" : "text-muted"}`}><Moon className="h-3.5 w-3.5" /> Dark</button>
        <button onClick={() => applyTheme("light")} aria-pressed={theme === "light"} className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs ${theme === "light" ? "bg-accent-soft text-fg" : "text-muted"}`}><Sun className="h-3.5 w-3.5" /> Light</button>
      </div>
    </div>
  );

  if (themeOnly) return themeRow;

  return (
    <>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="block">
          <span className="mb-1 block text-xs text-faint">Display name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </label>
        <Button onClick={save} loading={saving} disabled={!name.trim()}>Save</Button>
      </div>
      <p className="mt-2 text-xs text-faint">Signed in as {email}{msg ? ` · ${msg}` : ""}</p>
      {themeRow}
      <form action="/auth/signout" method="post" onSubmit={() => forgetAccountData()} className="mt-4 border-t border-border pt-4">
        <Button variant="secondary" type="submit"><LogOut className="h-4 w-4" /> Sign out</Button>
      </form>
      {email ? <DeleteAccount email={email} /> : <p className="mt-4 border-t border-border pt-4 text-xs text-faint">To delete this account, email {LEGAL.email} from the address you signed up with.</p>}
    </>
  );
}

interface Blockers {
  canDelete: boolean;
  blockers: { kind: string; message: string }[];
}

/** Delete the account for good: shows what stands in the way first, then asks for the account's email. */
function DeleteAccount({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<Blockers | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const start = async () => {
    setOpen(true);
    setError(null);
    try {
      setState(await jsonFetch<Blockers>("/api/account"));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await jsonFetch("/api/account", { method: "DELETE", body: JSON.stringify({ confirmEmail: typed }) });
      forgetAccountData();
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const matches = typed.trim().toLowerCase() === email.trim().toLowerCase();
  const close = () => {
    setOpen(false);
    setTyped("");
    setState(null);
    setError(null);
  };

  if (done)
    return (
      <div className="mt-4 border-t border-border pt-4" role="status">
        <div className="text-sm">Your account has been deleted.</div>
        <p className="mt-1 text-xs text-faint">You&apos;ve been signed out. Thanks for trying Orbis.</p>
        {/* A full page load, so nothing of the signed-in app stays on screen. */}
        <Button variant="secondary" className="mt-3" onClick={() => window.location.replace("/")}>Go to the homepage</Button>
      </div>
    );

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="text-sm">Delete account</div>
      <p className="mt-1 text-xs text-faint">
        Deletes your account and everything in it for good: chats, projects, agents, memories, connected apps and unused credits. Sites you published are taken down. Payment records we must keep by law are kept, no longer linked to your account.
      </p>
      {!open ? (
        <Button variant="danger" className="mt-3" onClick={start}><Trash2 className="h-4 w-4" /> Delete account…</Button>
      ) : (
        <div className="mt-3 rounded-xl border border-danger/30 bg-danger/5 p-3">
          {!state && !error && <p className="text-xs text-muted">Checking…</p>}
          {state && !state.canDelete && (
            <>
              <ul className="space-y-1 text-xs text-danger">
                {state.blockers.map((b) => <li key={b.message}>{b.message}</li>)}
              </ul>
              <Button variant="ghost" className="mt-3" onClick={close}>Close</Button>
            </>
          )}
          {state?.canDelete && (
            <>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Type <strong className="text-fg">{email}</strong> to confirm. This can&apos;t be undone.</span>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Your email address, to confirm" />
              </label>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="danger" onClick={remove} loading={busy} disabled={!matches}>Delete my account</Button>
                <Button variant="ghost" onClick={close} disabled={busy}>Keep it</Button>
              </div>
            </>
          )}
          {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
          {error && !state && <Button variant="ghost" className="mt-2" onClick={close}>Close</Button>}
        </div>
      )}
    </div>
  );
}
