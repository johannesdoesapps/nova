"use client";
import { useState } from "react";
import { ArrowUpRight, Eye, Lock, PenLine, RefreshCw, Search } from "lucide-react";
import { Dialog } from "@/components/studio/ui";
import { oauthRedirectTo } from "@/lib/auth-flow";
import { AI_MODES, type AiMode, type CatalogEntry, type ConnectionStatus, type ConnectorItem } from "@/lib/connectors/catalog";
import { browserSupabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { BrandIcon } from "./brand-icon";
import { api, StatusPill } from "./shared";

export function statusOf(c: CatalogEntry): ConnectionStatus {
  return c.connection?.status ?? "not_connected";
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");

const HOW: Record<CatalogEntry["auth"], (name: string, vendor: string) => string> = {
  oauth2: (name, vendor) => `You'll go to ${vendor}'s own sign-in page, see exactly what Orbis is asking for, and choose whether to allow it. Orbis never sees your ${vendor} password. You come back here when it's done.`,
  github_app: () => "First connect your GitHub account, then choose which repositories Orbis may read on GitHub. You can change that choice on GitHub at any time.",
  none: () => "There's no account to connect: this uses public data only. Turning it on lets Orbis use it in your chats.",
};

export function ConnectorDialog({
  entry: c,
  admin,
  setup,
  signedIn,
  onClose,
  onChanged,
}: {
  entry: CatalogEntry;
  admin: boolean;
  setup: { redirectUri: string; keyConfigured: boolean } | null;
  signedIn: boolean;
  onClose: () => void;
  onChanged: (notice?: { tone: "ok" | "error"; text: string }) => void;
}) {
  const status = statusOf(c);
  const connected = status === "connected" || status === "reauth_required" || status === "error";
  const [write, setWrite] = useState(c.connection?.writeEnabled ?? false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ items: ConnectorItem[]; note: string | null } | null>(null);

  const wrap = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const connect = () => {
    if (c.auth === "oauth2") {
      setBusy("connect");
      // A full-page navigation to an API route that redirects to the service's own sign-in page (not a Next.js page).
      window.location.href = new URL(`/api/connectors/${c.id}/connect${write && c.writeScopes.length ? "?write=1" : ""}`, window.location.origin).toString();
      return;
    }
    if (c.auth === "none") return void wrap("connect", async () => {
      await api(`/api/connectors/${c.id}/enable`, { method: "POST" });
      onChanged({ tone: "ok", text: `${c.name} is on.` });
    });
    // GitHub: link the account, install the app, then confirm.
    void wrap("connect", async () => {
      const s = await api<{ configured: boolean; linked: boolean; installed: boolean; installUrl: string | null }>("/api/github/status");
      if (!s.configured) throw new Error("GitHub isn't set up on this site yet.");
      if (!s.linked) {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        if (!url || !key) throw new Error("Accounts aren't set up on this site.");
        const { error } = await browserSupabase(url, key).auth.linkIdentity({ provider: "github", options: { redirectTo: oauthRedirectTo(location.origin, "/connectors?connector=github", "github-link"), scopes: "read:user user:email" } });
        if (error) throw new Error(/manual linking/i.test(error.message) ? "Connecting GitHub to an existing account isn't switched on for this site yet." : "GitHub couldn't be connected. Please try again.");
        return;
      }
      if (!s.installed) {
        if (s.installUrl) window.open(s.installUrl, "_blank", "noopener");
        throw new Error("On GitHub, choose the repositories Orbis may read, then press Connect again.");
      }
      await api(`/api/connectors/${c.id}/enable`, { method: "POST" });
      onChanged({ tone: "ok", text: "GitHub connected." });
    });
  };

  const check = () =>
    wrap("check", async () => {
      const r = await api<{ ok: boolean; message?: string }>(`/api/connectors/${c.id}/check`, { method: "POST" });
      setMessage(r.ok ? { tone: "ok", text: "The connection works." } : { tone: "error", text: r.message ?? "The connection didn't work." });
      onChanged();
    });

  const setMode = (aiMode: AiMode) =>
    wrap("mode", async () => {
      await api(`/api/connectors/${c.id}`, { method: "PATCH", body: JSON.stringify({ aiMode }) });
      onChanged();
    });

  const writeOff = () =>
    wrap("write", async () => {
      await api(`/api/connectors/${c.id}`, { method: "PATCH", body: JSON.stringify({ writeEnabled: false }) });
      onChanged();
    });

  const disconnect = () =>
    wrap("disconnect", async () => {
      const r = await api<{ ok: boolean; revoked: boolean; note: string | null }>(`/api/connectors/${c.id}`, { method: "DELETE" });
      onChanged({ tone: "ok", text: `${c.name} disconnected.${r.revoked ? ` Access was also revoked at ${c.vendor}.` : ""}${r.note ? ` ${r.note}` : ""}` });
      onClose();
    });

  const tryIt = () =>
    wrap("search", async () => {
      const r = await api<{ items: ConnectorItem[]; runs: { ok: boolean; error: string | null; summary: string | null }[] }>("/api/connectors/search", { method: "POST", body: JSON.stringify({ query: q, connectors: [c.id] }) });
      setFound({ items: r.items, note: r.runs[0] ? (r.runs[0].ok ? r.runs[0].summary : r.runs[0].error) : `${c.name} has no search; ask about a file link in chat.` });
    });

  const reads = c.capabilities.filter((x) => x.access === "read");
  const writes = c.capabilities.filter((x) => x.access === "write");
  const granted = new Set(c.connection?.scopes ?? []);

  return (
    <Dialog open onClose={onClose} title={c.name} width={640}>
      <div className="s-scroll max-h-[min(78vh,760px)] space-y-6 overflow-y-auto pr-1 text-[13.5px]">
        <div className="flex items-start gap-3">
          <BrandIcon id={c.id} size={48} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-s-ink-3">{c.vendor}</span>
              <StatusPill status={status} />
            </div>
            <p className="mt-1 leading-relaxed text-s-ink-2">{c.description}</p>
          </div>
        </div>

        {message && <p className={cn("rounded-xl border px-3 py-2", message.tone === "ok" ? "border-emerald-500/30" : "border-red-500/30 text-s-danger")}>{message.text}</p>}
        {c.connection?.lastError && status !== "connected" && <p className="rounded-xl border border-amber-500/40 px-3 py-2">{c.connection.lastError}</p>}

        <section>
          <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">What Orbis can do</h3>
          <ul className="mt-2 space-y-1.5">
            {reads.map((x) => (
              <li key={x.label} className="flex items-center gap-2">
                <Eye className="h-3.5 w-3.5 shrink-0 text-s-ink-3" /> {x.label}
                <span className="ml-auto text-[11px] text-s-ink-3">Read</span>
              </li>
            ))}
            {writes.map((x) => (
              <li key={x.label} className="flex items-center gap-2">
                <PenLine className="h-3.5 w-3.5 shrink-0 text-s-ink-3" /> {x.label}
                <span className="ml-auto text-[11px] text-amber-600">Changes data · you confirm each time</span>
              </li>
            ))}
          </ul>
        </section>

        {(c.readScopes.length > 0 || c.writeScopes.length > 0) && (
          <section>
            <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Permissions {connected ? "granted" : "requested"}</h3>
            <ul className="mt-2 divide-y divide-s-line rounded-xl border border-s-line">
              {[...c.readScopes, ...c.writeScopes].map((p) => {
                const isGranted = granted.has(p.scope);
                const optional = p.access === "write";
                return (
                  <li key={p.scope} className="flex items-start gap-2 px-3 py-2">
                    {p.access === "write" ? <PenLine className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-s-ink-3" />}
                    <div className="min-w-0 flex-1">
                      <div>{p.label}</div>
                      <code className="break-all font-mono text-[11px] text-s-ink-3">{p.scope}</code>
                    </div>
                    <span className="shrink-0 text-[11px] text-s-ink-3">{connected ? (isGranted ? "Granted" : "Not granted") : optional ? "Only if you allow writing" : "Required"}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section>
          <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">How your data is used</h3>
          <p className="mt-2 leading-relaxed text-s-ink-2">{c.dataUse}</p>
        </section>

        {connected ? (
          <section className="space-y-4 rounded-2xl border border-s-line p-4">
            <h3 className="text-[14px] font-medium">Manage</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
              <dt className="text-s-ink-3">Account</dt>
              <dd className="truncate">{c.connection?.accountLabel ?? "—"}</dd>
              <dt className="text-s-ink-3">Access</dt>
              <dd>{c.connection?.writeEnabled ? "Read and write (each change needs your confirmation)" : "Read-only"}</dd>
              <dt className="text-s-ink-3">Connected</dt>
              <dd>{when(c.connection?.connectedAt ?? null)}</dd>
              <dt className="text-s-ink-3">Last checked</dt>
              <dd>{when(c.connection?.lastCheckedAt ?? null)}</dd>
              <dt className="text-s-ink-3">Last used</dt>
              <dd>{when(c.connection?.lastUsedAt ?? null)}</dd>
              <dt className="text-s-ink-3">Sync</dt>
              <dd>Live: Orbis reads when needed; nothing is copied or synced.</dd>
            </dl>
            <label className="block">
              <span className="text-[12.5px] text-s-ink-3">Use in chat</span>
              <select value={c.connection?.aiMode ?? "auto"} onChange={(e) => void setMode(e.target.value as AiMode)} disabled={busy === "mode"} className="mt-1 block h-9 w-full rounded-lg border border-s-line bg-s-bg px-2 text-[13px]">
                {AI_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void check()} disabled={!!busy} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] hover:border-s-line-strong disabled:opacity-50">
                <RefreshCw className={cn("h-3.5 w-3.5", busy === "check" && "animate-spin")} /> Check connection
              </button>
              {c.auth === "oauth2" && (
                <button type="button" onClick={connect} disabled={!!busy || !c.available} className="h-8 rounded-full border border-s-line px-3 text-[12.5px] hover:border-s-line-strong disabled:opacity-50">
                  Reconnect{write && !c.connection?.writeEnabled ? " with write access" : ""}
                </button>
              )}
              {c.connection?.writeEnabled && (
                <button type="button" onClick={() => void writeOff()} disabled={!!busy} className="h-8 rounded-full border border-s-line px-3 text-[12.5px] hover:border-s-line-strong disabled:opacity-50">
                  Make read-only
                </button>
              )}
              {!confirmOff ? (
                <button type="button" onClick={() => setConfirmOff(true)} className="ml-auto h-8 rounded-full px-3 text-[12.5px] text-s-danger hover:bg-s-hover">
                  Disconnect
                </button>
              ) : (
                <span className="ml-auto flex items-center gap-2 text-[12.5px]">
                  Disconnect {c.name}?
                  <button type="button" onClick={() => void disconnect()} disabled={!!busy} className="h-8 rounded-full bg-red-600 px-3 text-white disabled:opacity-50">
                    Yes, disconnect
                  </button>
                  <button type="button" onClick={() => setConfirmOff(false)} className="h-8 rounded-full px-2 text-s-ink-3">
                    Cancel
                  </button>
                </span>
              )}
            </div>
            {c.writeScopes.length > 0 && !c.connection?.writeEnabled && c.auth === "oauth2" && (
              <label className="flex items-start gap-2 text-[12.5px] text-s-ink-2">
                <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} className="mt-0.5" />
                Reconnect with permission to {writes.map((w) => w.label.toLowerCase()).join(" and ")}. You&apos;ll still confirm every change.
              </label>
            )}

            {status === "connected" && c.available && (
              <form
                className="border-t border-s-line pt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (q.trim()) void tryIt();
                }}
              >
                <span className="text-[12.5px] text-s-ink-3">Try it: search {c.name}</span>
                <div className="mt-1 flex gap-2">
                  <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} aria-label={`Search ${c.name}`} className="h-9 min-w-0 flex-1 rounded-full border border-s-line bg-transparent px-3 text-[13px] outline-none focus:border-s-line-strong" />
                  <button type="submit" disabled={!q.trim() || !!busy} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] disabled:opacity-40">
                    <Search className="h-3.5 w-3.5" /> {busy === "search" ? "Searching…" : "Search"}
                  </button>
                </div>
                {found && (
                  <div className="mt-2">
                    {found.note && <p className="text-[12px] text-s-ink-3">{found.note}</p>}
                    <ul className="mt-1 space-y-1.5">
                      {found.items.map((it, i) => (
                        <li key={i} className="text-[12.5px]">
                          {it.url ? (
                            <a href={it.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                              {it.title} <ArrowUpRight className="inline h-3 w-3" />
                            </a>
                          ) : (
                            <span className="font-medium">{it.title}</span>
                          )}
                          <span className="block truncate text-s-ink-3">{it.snippet}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </form>
            )}
          </section>
        ) : (
          <section className="space-y-3 rounded-2xl border border-s-line p-4">
            <h3 className="text-[14px] font-medium">{c.auth === "none" ? "Turn on" : "Connect"}</h3>
            <p className="leading-relaxed text-s-ink-2">{HOW[c.auth](c.name, c.vendor)}</p>
            {c.available && c.writeScopes.length > 0 && c.auth === "oauth2" && (
              <label className="flex items-start gap-2 text-[13px]">
                <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} className="mt-0.5" />
                <span>
                  Also allow Orbis to {writes.map((w) => w.label.toLowerCase()).join(" and ")}.
                  <span className="block text-[12px] text-s-ink-3">Off by default. Even when on, Orbis shows you every change first and does nothing until you confirm.</span>
                </span>
              </label>
            )}
            {!signedIn ? (
              <a href="/login?next=/connectors" className="inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[13.5px] font-medium text-s-accent-ink">
                Sign in to connect
              </a>
            ) : c.available ? (
              <button type="button" onClick={connect} disabled={!!busy} className="h-10 rounded-full bg-s-accent px-5 text-[13.5px] font-medium text-s-accent-ink disabled:opacity-50">
                {busy === "connect" ? "Connecting…" : c.auth === "none" ? `Turn on ${c.name}` : `Connect ${c.name}`}
              </button>
            ) : (
              <p className="rounded-xl border border-dashed border-s-line px-3 py-2 text-s-ink-3">
                {c.name} isn&apos;t set up on this site yet{admin ? "" : ", so it can't be connected. The site's owner has to register Orbis with " + c.vendor + " first"}.
              </p>
            )}
          </section>
        )}

        {admin && c.missing && c.missing.length > 0 && (
          <section className="space-y-2 rounded-2xl border border-amber-500/40 p-4">
            <h3 className="text-[14px] font-medium">Setup (administrators)</h3>
            <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-s-ink-2">
              <li>
                Create the app in{" "}
                <a href={c.setup.console.url} target="_blank" rel="noreferrer" className="underline">
                  {c.setup.console.label}
                </a>
                .
              </li>
              {c.auth === "oauth2" && setup && (
                <li>
                  Use this redirect URL: <code className="break-all font-mono text-[12px]">{setup.redirectUri}</code>
                </li>
              )}
              {c.setup.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              <li>
                In Vercel → Settings → Environment Variables, add (as Sensitive): {c.missing.map((m, i) => (
                  <span key={m}>
                    {i > 0 && ", "}
                    <code className="font-mono text-[12px]">{m}</code>
                  </span>
                ))}
                . Then redeploy.
              </li>
            </ol>
          </section>
        )}
      </div>
    </Dialog>
  );
}
