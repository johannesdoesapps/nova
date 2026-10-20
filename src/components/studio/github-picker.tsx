"use client";
import { useEffect, useMemo, useState } from "react";
import { Check, Lock, Search } from "lucide-react";
import { GitHubLogo } from "@/components/common/login-form";
import { LOGIN_MESSAGES, loginMessage, oauthRedirectTo } from "@/lib/auth-flow";
import { MAX_ATTACHMENT_CHARS } from "@/lib/limits";
import { browserSupabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { attachmentBytes, MAX_ATTACHMENTS_BYTES, type ChatAttachment } from "./chat-client";
import { Dialog } from "./ui";

type Status = { configured: boolean; linked: boolean; login: string | null; installed: boolean; installUrl: string | null; manageUrl: string | null };
type Repo = { fullName: string; private: boolean };
type TreeFile = { path: string; size: number };

async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, message: body?.error?.message ?? "Something went wrong. Please try again." };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, message: "Couldn't reach Orbis. Check your connection and try again." };
  }
}

/**
 * "Add from GitHub": pick files from a repository the user let Orbis read and
 * add them to the message as attachments. Walks the user through connecting
 * GitHub and choosing repositories when that hasn't happened yet.
 */
export function GitHubPicker({
  open,
  onClose,
  attachments,
  onAttachments,
  maxFiles,
}: {
  open: boolean;
  onClose: () => void;
  attachments: ChatAttachment[];
  onAttachments: (a: ChatAttachment[]) => void;
  maxFiles: number;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  // Back from connecting GitHub: show what happened (only known message codes).
  const [error, setError] = useState<string | null>(() => (typeof location === "undefined" ? null : (loginMessage(new URLSearchParams(location.search).get("github"))?.text ?? null)));
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repo, setRepo] = useState("");
  const [tree, setTree] = useState<{ files: TreeFile[]; truncated: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const room = Math.max(0, maxFiles - attachments.length);

  async function chooseRepo(name: string) {
    setRepo(name);
    setTree(null);
    setPicked([]);
    if (!name) return;
    const t = await getJson<{ files: TreeFile[]; truncated: boolean }>(`/api/github/tree?repo=${encodeURIComponent(name)}`);
    if (!t.ok) return setError(t.message);
    setTree(t.data);
  }

  // Mounted only while open, so this runs once per opening.
  useEffect(() => {
    void (async () => {
      const s = await getJson<Status>("/api/github/status");
      if (!s.ok) {
        setNeedsSignIn(s.status === 401);
        if (s.status !== 401) setError(s.message);
        return;
      }
      setStatus(s.data);
      if (s.data.installed) {
        const r = await getJson<{ repos: Repo[] }>("/api/github/repos");
        if (!r.ok) return setError(r.message);
        setRepos(r.data.repos);
        if (r.data.repos.length === 1) void chooseRepo(r.data.repos[0]!.fullName);
      }
    })();
  }, []);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (tree?.files ?? []).filter((f) => !q || f.path.toLowerCase().includes(q)).slice(0, 300);
  }, [tree, filter]);

  async function connect() {
    setError(null);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return setError(LOGIN_MESSAGES.github_link_failed.text);
    setBusy(true);
    const { error } = await browserSupabase(url, key).auth.linkIdentity({
      provider: "github",
      options: { redirectTo: oauthRedirectTo(location.origin, location.pathname, "github-link"), scopes: "read:user user:email" },
    });
    // On success the browser is leaving for GitHub.
    if (error) {
      setBusy(false);
      setError(/manual linking/i.test(error.message) ? "Connecting GitHub to an existing account isn't switched on for this site yet." : LOGIN_MESSAGES.github_link_failed.text);
    }
  }

  async function add() {
    setBusy(true);
    setError(null);
    const next = [...attachments];
    for (const path of picked) {
      const name = `${repo}/${path}`;
      if (next.some((a) => a.name === name)) continue;
      const f = await getJson<{ content: string }>(`/api/github/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`);
      if (!f.ok) {
        setError(`${path}: ${f.message}`);
        continue;
      }
      const content = f.data.content.slice(0, MAX_ATTACHMENT_CHARS);
      if (attachmentBytes([...next, { content }]) > MAX_ATTACHMENTS_BYTES) {
        setError(`${path} wasn’t added: a message’s files can total about ${Math.round(MAX_ATTACHMENTS_BYTES / 1000)} KB of text.`);
        continue;
      }
      next.push({ name, content });
    }
    onAttachments(next);
    setBusy(false);
    if (next.length > attachments.length) onClose();
  }

  const button = "inline-flex items-center justify-center gap-2 rounded-full bg-s-ink px-4 py-2 text-[13.5px] font-medium text-s-bg transition hover:opacity-90 disabled:opacity-50";

  return (
    <Dialog open={open} onClose={onClose} title="Add files from GitHub" description="Orbis reads only the repositories you choose, and never changes them." width={560}>
      {error && <p role="alert" className="mb-3 rounded-xl border border-s-line px-3 py-2 text-[13px] text-s-danger">{error}</p>}

      {needsSignIn ? (
        <a href={`/login?next=${encodeURIComponent(typeof location === "undefined" ? "/chat" : location.pathname)}`} className={button}>Sign in to add files from GitHub</a>
      ) : !status ? (
        !error && <p className="text-[13.5px] text-s-ink-3">Checking your GitHub connection…</p>
      ) : !status.configured ? (
        <p className="text-[13.5px] text-s-ink-2">GitHub isn’t set up on this site yet.</p>
      ) : !status.linked ? (
        <div className="space-y-3">
          <p className="text-[13.5px] text-s-ink-2">Connect your GitHub account first. Orbis only sees your public profile and email at this step.</p>
          <button type="button" onClick={() => void connect()} disabled={busy} className={button}>
            <GitHubLogo className="h-4 w-4" /> Connect GitHub
          </button>
        </div>
      ) : !status.installed ? (
        <div className="space-y-3">
          <p className="text-[13.5px] text-s-ink-2">
            Connected as <b>@{status.login}</b>. Now choose which repositories Orbis may read. You can pick just one, and change it any time on GitHub.
          </p>
          {status.installUrl && (
            <a href={status.installUrl} className={button}>
              <GitHubLogo className="h-4 w-4" /> Choose repositories
            </a>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={repo}
              onChange={(e) => void chooseRepo(e.target.value)}
              aria-label="Repository"
              className="min-w-0 flex-1 rounded-xl border border-s-line bg-transparent px-3 py-2 text-[13.5px]"
            >
              <option value="">{repos === null ? "Loading repositories…" : repos.length ? "Choose a repository" : "No repositories shared with Orbis"}</option>
              {repos?.map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                  {r.private ? " (private)" : ""}
                </option>
              ))}
            </select>
            {status.manageUrl && (
              <a href={status.manageUrl} target="_blank" rel="noopener noreferrer" className="text-[12.5px] text-s-ink-3 underline underline-offset-2 hover:text-s-ink">
                Change repositories
              </a>
            )}
          </div>

          {repo && (
            <>
              <label className="flex items-center gap-2 rounded-xl border border-s-line px-3 py-2">
                <Search className="h-4 w-4 text-s-ink-3" aria-hidden />
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files, e.g. src/ or .py" aria-label="Filter files" className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none" />
              </label>
              <ul className="s-scroll max-h-[40dvh] overflow-y-auto rounded-xl border border-s-line" aria-label="Files">
                {tree === null && <li className="px-3 py-2 text-[13px] text-s-ink-3">Loading files…</li>}
                {tree && shown.length === 0 && <li className="px-3 py-2 text-[13px] text-s-ink-3">No text files match.</li>}
                {shown.map((f) => {
                  const on = picked.includes(f.path);
                  const full = !on && picked.length >= room;
                  return (
                    <li key={f.path}>
                      <button
                        type="button"
                        aria-pressed={on}
                        disabled={full}
                        onClick={() => setPicked(on ? picked.filter((p) => p !== f.path) : [...picked, f.path])}
                        className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[12.5px] hover:bg-s-code disabled:opacity-40", on && "bg-s-code")}
                      >
                        <span className={cn("grid h-4 w-4 shrink-0 place-items-center rounded border border-s-line", on && "bg-s-ink text-s-bg")}>{on && <Check className="h-3 w-3" />}</span>
                        <span className="min-w-0 flex-1 truncate">{f.path}</span>
                        <span className="shrink-0 text-s-ink-3">{(f.size / 1000).toFixed(1)} KB</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {tree?.truncated && <p className="text-[12px] text-s-ink-3">Large repository: some files aren’t listed. Use the filter to find a file.</p>}
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12.5px] text-s-ink-3">
                  {room === 0 ? "This message already has the most files it can take." : `Up to ${room} more file${room === 1 ? "" : "s"} for this message.`}
                </span>
                <button type="button" onClick={() => void add()} disabled={busy || picked.length === 0} className={button}>
                  {busy ? "Adding…" : `Add ${picked.length || ""} file${picked.length === 1 ? "" : "s"}`.replace("  ", " ")}
                </button>
              </div>
            </>
          )}
          <p className="flex items-center gap-1.5 text-[12px] text-s-ink-3">
            <Lock className="h-3.5 w-3.5" aria-hidden /> Read-only access. Files are sent with your message to the AI model you choose.
          </p>
        </div>
      )}
    </Dialog>
  );
}
