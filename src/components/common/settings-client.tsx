"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { LogOut, Moon, Sun } from "lucide-react";
import { Button, Input } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
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
    </>
  );
}
