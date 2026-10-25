"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, FileUp, FolderUp, GitBranch, GitPullRequest, Globe, Loader2, Plus, ShieldCheck, Trash2, Upload } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { cn } from "@/lib/utils";
import { Segmented, Switch } from "@/components/studio/ui";

export interface Target {
  id: string;
  hostname: string;
  token: string;
  verified_at: string | null;
  verified_method: string | null;
}

export const VERIFY_PATH = "/.well-known/orbis-security-verification.txt";
const MAX_TOTAL = 3_000_000;
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|out|vendor|coverage|__pycache__|\.venv|venv)\//;
const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|php|rb|go|java|cs|json|ya?ml|toml|env|ini|cfg|conf|properties|sh|tf|xml|html?|sql|txt|lock)$|(^|\/)\.env(\.|$)|Dockerfile$/i;

export const inputCls =
  "h-10 w-full rounded-xl border border-s-line bg-transparent px-3 text-[14px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong";
export const labelCls = "mb-1.5 block text-[12.5px] font-medium text-s-ink-2";

async function readFiles(list: FileList | null, accept: (path: string) => boolean): Promise<{ files: { path: string; content: string }[]; skipped: number }> {
  const files: { path: string; content: string }[] = [];
  let skipped = 0;
  for (const f of Array.from(list ?? [])) {
    const path = (f.webkitRelativePath || f.name).replace(/^\/+/, "");
    if (!accept(path) || f.size > 1_000_000) {
      skipped++;
      continue;
    }
    files.push({ path, content: await f.text() });
  }
  return { files, skipped };
}
export const totalSize = (files: { content: string }[]) => files.reduce((n, f) => n + f.content.length, 0);

/* --------------------------------------------------------------- Sentinel */

export interface SentinelValue {
  targetId: string;
  scope: "passive" | "active";
  authorized: boolean;
}

export function SentinelForm({
  value,
  onChange,
  targets,
  onTargetsChanged,
  audit,
}: {
  value: SentinelValue;
  onChange: (v: SentinelValue) => void;
  targets: Target[];
  onTargetsChanged: () => Promise<void>;
  /** In an audit, the site is mapped within this budget; the scope texts describe that instead of a single-page scan. */
  audit?: { pages: number; scripts: number; endpointChecks: number };
}) {
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const selected = targets.find((t) => t.id === value.targetId);

  const add = async () => {
    setBusy("add");
    setMsg(null);
    try {
      const r = await jsonFetch<{ target: Target }>("/api/security/targets", { method: "POST", body: JSON.stringify({ host }) });
      await onTargetsChanged();
      onChange({ ...value, targetId: r.target.id });
      setHost("");
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const verify = async (t: Target) => {
    setBusy("verify");
    setMsg(null);
    try {
      const r = await jsonFetch<{ verified: boolean; method?: string; reason?: string }>(`/api/security/targets/${t.id}/verify`, { method: "POST" });
      setMsg(r.verified ? { ok: true, text: `Ownership confirmed (${r.method?.replace("_", " ")}).` } : { ok: false, text: r.reason ?? "Not verified yet." });
      await onTargetsChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const remove = async (t: Target) => {
    setBusy("remove");
    try {
      await jsonFetch(`/api/security/targets/${t.id}`, { method: "DELETE" });
      if (value.targetId === t.id) onChange({ ...value, targetId: "" });
      await onTargetsChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <span className={labelCls}>Website</span>
        {targets.length > 0 && (
          <div className="mb-2 space-y-1.5" role="radiogroup" aria-label="Website to scan">
            {targets.map((t) => (
              <div key={t.id} className={cn("flex items-center gap-2 rounded-xl border px-3 py-2 transition", value.targetId === t.id ? "border-s-line-strong bg-s-hover" : "border-s-line")}>
                <button type="button" role="radio" aria-checked={value.targetId === t.id} onClick={() => onChange({ ...value, targetId: t.id })} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[14px]">
                  <Globe className="h-4 w-4 shrink-0 text-s-ink-3" />
                  <span className="truncate">{t.hostname}</span>
                  {t.verified_at ? (
                    <span className="inline-flex items-center gap-1 text-[11.5px] text-emerald-600 dark:text-emerald-400">
                      <ShieldCheck className="h-3.5 w-3.5" /> verified
                    </span>
                  ) : (
                    <span className="text-[11.5px] text-s-ink-3">not verified</span>
                  )}
                </button>
                <button type="button" onClick={() => void remove(t)} disabled={!!busy} aria-label={`Remove ${t.hostname}`} className="rounded-lg p-1 text-s-ink-3 transition hover:bg-s-hover hover:text-s-ink">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="yourdomain.com" aria-label="Add a website you own" className={inputCls} onKeyDown={(e) => e.key === "Enter" && host.trim() && (e.preventDefault(), void add())} />
          <button type="button" onClick={() => void add()} disabled={!host.trim() || !!busy} className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-s-line-strong px-3.5 text-[13.5px] font-medium transition hover:bg-s-hover disabled:opacity-40">
            {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
          </button>
        </div>
      </div>

      {selected && !selected.verified_at && (
        <div className="rounded-2xl border border-s-line bg-s-hover/60 p-4 text-[13px] text-s-ink-2">
          <p className="font-medium text-s-ink">Prove you control {selected.hostname}</p>
          <p className="mt-1">Do one of these, then press Check. (Administrators can scan this Orbis site’s own domain without this step.)</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>
              Publish a file at <code className="rounded bg-s-hover px-1">https://{selected.hostname}{VERIFY_PATH}</code> containing the token, or
            </li>
            <li>
              Add a DNS TXT record on <code className="rounded bg-s-hover px-1">_orbis-verify.{selected.hostname}</code> with the token.
            </li>
          </ol>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-s-line bg-s-bg px-2.5 py-1.5 text-[12px]">{selected.token}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(selected.token);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-s-line px-2.5 text-[12px] hover:bg-s-hover"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button type="button" onClick={() => void verify(selected)} disabled={!!busy} className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-xl bg-s-ink px-3.5 text-[13px] font-medium text-s-bg transition hover:opacity-90 disabled:opacity-50">
            {busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Check ownership
          </button>
        </div>
      )}
      {msg && <p className={cn("text-[13px]", msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-s-danger")} role="status">{msg.text}</p>}

      <div>
        <span className={labelCls}>{audit ? "Testing permission" : "Scope"}</span>
        <Segmented
          label={audit ? "Testing permission" : "Scan scope"}
          value={value.scope}
          onChange={(scope) => onChange({ ...value, scope })}
          options={
            audit
              ? [
                  { value: "passive", label: "Passive" },
                  { value: "active", label: "Active (read-only)" },
                ]
              : [
                  { value: "passive", label: "Read-only" },
                  { value: "active", label: "Read-only + exposed files" },
                ]
          }
        />
        <p className="mt-1.5 text-[12.5px] text-s-ink-3">
          {audit
            ? value.scope === "passive"
              ? `Ordinary visitor requests only: up to ${audit.pages} same-site page(s) and ${audit.scripts} script(s), respecting robots.txt, skipping links that look like actions (log out, delete…).`
              : `Also, one at a time: 8 sensitive paths such as /.env, signed-out GET requests to up to ${audit.endpointChecks} API endpoints the site itself references, and a not-found page to check for leaked error details. No forms are submitted, no sign-in is attempted, no attack payloads are sent, nothing is modified.`
            : value.scope === "passive"
              ? "Loads the home page over HTTPS and HTTP and reads headers, cookies and security.txt — like a normal visitor (about 4 requests)."
              : "Also requests 8 sensitive paths such as /.env and /.git/HEAD, one at a time, and confirms exposure by content. Nothing is modified."}
        </p>
      </div>
      <label className="flex cursor-pointer items-start gap-2.5 text-[13.5px]">
        <input type="checkbox" checked={value.authorized} onChange={(e) => onChange({ ...value, authorized: e.target.checked })} className="mt-0.5 h-4 w-4 accent-[var(--s-accent)]" />
        <span>I own this website or have written permission to test it. Ownership is re-checked by the server before every scan.</span>
      </label>
    </div>
  );
}

/* ----------------------------------------------------------- Threat Hunter */

export interface HunterValue {
  files: { name: string; content: string }[];
  pasted: string;
  indicators: string;
  asset: string;
}

export function HunterForm({ value, onChange }: { value: HunterValue; onChange: (v: HunterValue) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div>
        <span className={labelCls}>Log files</span>
        <input
          ref={ref}
          type="file"
          multiple
          accept=".log,.txt,.json,.jsonl,.ndjson,text/plain,application/json"
          className="sr-only"
          onChange={async (e) => {
            const { files, skipped } = await readFiles(e.target.files, () => true);
            onChange({ ...value, files: [...value.files, ...files.map((f) => ({ name: f.path, content: f.content }))].slice(0, 10) });
            setNote(skipped ? `${skipped} file(s) over 1 MB were skipped.` : null);
            e.target.value = "";
          }}
        />
        <button type="button" onClick={() => ref.current?.click()} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-s-line-strong px-4 py-5 text-[13.5px] text-s-ink-2 transition hover:bg-s-hover">
          <FileUp className="h-4 w-4" /> Choose log files (web, SSH/Linux auth, CloudTrail, Okta, Windows, DNS)
        </button>
        {value.files.length > 0 && (
          <ul className="mt-2 space-y-1">
            {value.files.map((f, i) => (
              <li key={i} className="flex items-center gap-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-s-ink-3">{(f.content.length / 1024).toFixed(0)} KB</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => onChange({ ...value, files: value.files.filter((_, j) => j !== i) })} className="rounded p-1 text-s-ink-3 hover:text-s-ink">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {note && <p className="mt-1 text-[12.5px] text-s-ink-3">{note}</p>}
      </div>
      <div>
        <label htmlFor="hunter-paste" className={labelCls}>
          Or paste log lines
        </label>
        <textarea id="hunter-paste" rows={4} value={value.pasted} onChange={(e) => onChange({ ...value, pasted: e.target.value })} placeholder='203.0.113.9 - - [18/Oct/2026:10:00:00 +0000] "GET /login HTTP/1.1" 401 …' className={cn(inputCls, "h-auto py-2 font-mono text-[12.5px]")} />
      </div>
      <div>
        <label htmlFor="hunter-iocs" className={labelCls}>
          Indicators to check (optional)
        </label>
        <textarea id="hunter-iocs" rows={2} value={value.indicators} onChange={(e) => onChange({ ...value, indicators: e.target.value })} placeholder="IP addresses, domains or URLs, separated by spaces or commas" className={cn(inputCls, "h-auto py-2 text-[13px]")} />
      </div>
      <div>
        <label htmlFor="hunter-asset" className={labelCls}>
          System name (optional)
        </label>
        <input id="hunter-asset" value={value.asset} onChange={(e) => onChange({ ...value, asset: e.target.value })} placeholder="e.g. web-server-1" className={inputCls} />
      </div>
      <p className="text-[12.5px] text-s-ink-3">Logs are analysed in this request and only findings, investigations and short, redacted evidence excerpts are saved. Orbis isn&apos;t connected to your SIEM, EDR or cloud accounts and doesn&apos;t monitor your systems continuously.</p>
    </div>
  );
}

export function hunterBody(v: HunterValue) {
  const logs = [...v.files, ...(v.pasted.trim() ? [{ name: "pasted-lines.log", content: v.pasted }] : [])];
  return { logs, indicators: v.indicators, asset: v.asset.trim() };
}

/* ----------------------------------------------------------- Code Guardian */

export interface GuardianValue {
  mode: "upload" | "github" | "pr";
  files: { path: string; content: string }[];
  repo: string;
  /** The pull request to audit (mode "pr"). */
  prNumber: string;
  asset: string;
  aiReview: boolean;
  proposeFixes: boolean;
}

export function GuardianForm({ value, onChange }: { value: GuardianValue; onChange: (v: GuardianValue) => void }) {
  const filesRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const pick = async (list: FileList | null) => {
    const { files, skipped } = await readFiles(list, (p) => !SKIP.test(p) && CODE_EXT.test(p));
    const merged = [...value.files.filter((f) => !files.some((n) => n.path === f.path)), ...files].slice(0, 800);
    onChange({ ...value, files: merged, asset: value.asset || (files[0]?.path.includes("/") ? files[0].path.split("/")[0]! : value.asset) });
    setNote(`${files.length} file(s) added${skipped ? `, ${skipped} skipped (unsupported, vendored or over 1 MB)` : ""}.`);
  };
  const size = totalSize(value.files);
  return (
    <div className="space-y-4">
      <Segmented
        label="Code source"
        value={value.mode}
        onChange={(mode) => onChange({ ...value, mode })}
        options={[
          { value: "upload", label: "Upload files", icon: <Upload /> },
          { value: "github", label: "GitHub repository", icon: <GitBranch /> },
          { value: "pr", label: "Pull request", icon: <GitPullRequest /> },
        ]}
      />
      {value.mode === "upload" ? (
        <div>
          <input ref={filesRef} type="file" multiple aria-label="Choose code files" className="sr-only" onChange={(e) => void pick(e.target.files).then(() => (e.target.value = ""))} />
          <input ref={dirRef} type="file" multiple aria-label="Choose a code folder" className="sr-only" {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(e) => void pick(e.target.files).then(() => (e.target.value = ""))} />
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => dirRef.current?.click()} className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-s-line-strong px-4 py-5 text-[13.5px] text-s-ink-2 transition hover:bg-s-hover">
              <FolderUp className="h-4 w-4" /> Choose a project folder
            </button>
            <button type="button" onClick={() => filesRef.current?.click()} className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-s-line-strong px-4 py-5 text-[13.5px] text-s-ink-2 transition hover:bg-s-hover">
              <FileUp className="h-4 w-4" /> Choose files
            </button>
          </div>
          {value.files.length > 0 && (
            <p className={cn("mt-2 text-[13px]", size > MAX_TOTAL ? "text-s-danger" : "text-s-ink-2")}>
              {value.files.length} files · {(size / 1024 / 1024).toFixed(2)} MB {size > MAX_TOTAL && "— over the 3 MB limit; remove some files"}{" "}
              <button type="button" onClick={() => onChange({ ...value, files: [] })} className="ml-1 underline underline-offset-2">
                Clear
              </button>
            </p>
          )}
          {note && <p className="mt-1 text-[12.5px] text-s-ink-3">{note} Include package-lock.json to check dependencies.</p>}
        </div>
      ) : (
        <GitHubSource value={value} onChange={onChange} />
      )}
      {value.mode === "upload" && (
        <div>
          <label htmlFor="guardian-asset" className={labelCls}>
            Project name
          </label>
          <input id="guardian-asset" value={value.asset} onChange={(e) => onChange({ ...value, asset: e.target.value })} placeholder="e.g. orbis-ai" className={inputCls} />
          <p className="mt-1.5 text-[12.5px] text-s-ink-3">Use the same name for later audits so Orbis can tell which findings were fixed.</p>
        </div>
      )}
      <div className="space-y-2.5">
        <label className="flex items-center justify-between gap-3 text-[13.5px]">
          <span>
            AI code review
            <span className="block text-[12.5px] text-s-ink-3">Kept only when the quoted code exists in your files; marked tentative.</span>
          </span>
          <Switch checked={value.aiReview} onChange={(aiReview) => onChange({ ...value, aiReview })} label="AI code review" />
        </label>
        <label className="flex items-center justify-between gap-3 text-[13.5px]">
          <span>
            Propose fixes
            <span className="block text-[12.5px] text-s-ink-3">Patches and regression tests for up to 3 findings, for your review. Never applied.</span>
          </span>
          <Switch checked={value.proposeFixes} onChange={(proposeFixes) => onChange({ ...value, proposeFixes })} label="Propose fixes" />
        </label>
      </div>
    </div>
  );
}

interface GitHubState {
  connection: { available: boolean; status: string; account: string | null; lastError: string | null };
  repos: { fullName: string; private: boolean; defaultBranch: string }[];
}
interface PullSummary {
  number: number;
  title: string;
  draft: boolean;
  author: string | null;
  head: string;
  base: string;
}

/** Repository (and pull request) picker: the person's shared repositories when GitHub is connected, or any public repository by name. */
function GitHubSource({ value, onChange }: { value: GuardianValue; onChange: (v: GuardianValue) => void }) {
  const [gh, setGh] = useState<GitHubState | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);
  const [pulls, setPulls] = useState<{ repo: string; list: PullSummary[]; error: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    jsonFetch<GitHubState>("/api/security/github/repos")
      .then((r) => live && setGh(r))
      .catch((e: Error) => live && setGhError(e.message));
    return () => {
      live = false;
    };
  }, []);
  const repo = normalizeRepo(value.repo);
  const shared = !!repo && !!gh?.repos.some((r) => r.fullName.toLowerCase() === repo.toLowerCase());
  useEffect(() => {
    if (value.mode !== "pr" || !shared || !repo) return;
    let live = true;
    jsonFetch<{ pulls: PullSummary[] }>(`/api/security/github/pulls?repo=${encodeURIComponent(repo)}`)
      .then((r) => live && setPulls({ repo, list: r.pulls, error: null }))
      .catch((e: Error) => live && setPulls({ repo, list: [], error: e.message }));
    return () => {
      live = false;
    };
  }, [value.mode, shared, repo]);
  const connected = gh?.connection.status === "connected";
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="guardian-repo" className={labelCls}>
          Repository
        </label>
        <input
          id="guardian-repo"
          list="guardian-repos"
          value={value.repo}
          onChange={(e) => onChange({ ...value, repo: e.target.value, prNumber: "" })}
          placeholder={connected ? "Choose or type owner/repo" : "owner/repo or https://github.com/owner/repo"}
          className={inputCls}
        />
        <datalist id="guardian-repos">
          {gh?.repos.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              {r.private ? "Private" : "Public"} · {r.defaultBranch}
            </option>
          ))}
        </datalist>
        <p className="mt-1.5 text-[12.5px] text-s-ink-3">
          {connected
            ? `GitHub connected${gh?.connection.account ? ` as ${gh.connection.account}` : ""}: ${gh?.repos.length ?? 0} repositor${gh?.repos.length === 1 ? "y" : "ies"} shared with Orbis. `
            : gh?.connection.status === "error" || gh?.connection.status === "reauth_required"
              ? `Your GitHub connection needs attention${gh.connection.lastError ? ` (${gh.connection.lastError})` : ""}. Only public repositories can be read until it's fixed on the `
              : ghError
                ? `Couldn't check your GitHub connection (${ghError}). Public repositories still work. `
                : "Public repositories work without signing in. For private ones, connect GitHub on the "}
          {!connected && (
            <a href="/connectors" className="underline underline-offset-2">
              Connectors page
            </a>
          )}
          {!connected && ". "}A read-only snapshot is downloaded; nothing is cloned, run or changed.
        </p>
      </div>
      {value.mode === "pr" && (
        <div>
          <label htmlFor="guardian-pr" className={labelCls}>
            Pull request
          </label>
          {shared && pulls?.repo === repo && pulls.list.length > 0 ? (
            <select id="guardian-pr" value={value.prNumber} onChange={(e) => onChange({ ...value, prNumber: e.target.value })} className={inputCls}>
              <option value="">Choose an open pull request</option>
              {pulls.list.map((p) => (
                <option key={p.number} value={String(p.number)}>
                  #{p.number} {p.title}
                  {p.draft ? " (draft)" : ""} — {p.head} → {p.base}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="guardian-pr"
              inputMode="numeric"
              value={value.prNumber}
              onChange={(e) => onChange({ ...value, prNumber: e.target.value.replace(/[^0-9]/g, "").slice(0, 7) })}
              placeholder="Pull request number, e.g. 42"
              className={inputCls}
            />
          )}
          <p className="mt-1.5 text-[12.5px] text-s-ink-3">
            {shared && pulls?.repo !== repo
              ? "Loading open pull requests…"
              : pulls?.error && pulls.repo === repo
                ? `Couldn't list pull requests: ${pulls.error}`
                : shared && pulls?.repo === repo && pulls.list.length === 0
                  ? "No open pull requests; type a number to audit a closed one."
                  : null}{" "}
            Orbis reads the whole repository at the pull request&apos;s latest commit for context, but reports only what touches the files it changes, and says whether each finding is new.
          </p>
        </div>
      )}
    </div>
  );
}

/** "owner/name" from a typed repository or GitHub URL, or null. */
export function normalizeRepo(input: string): string | null {
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(input.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function guardianBody(v: GuardianValue) {
  return {
    source:
      v.mode === "pr"
        ? { type: "github_pr", repo: normalizeRepo(v.repo) ?? v.repo.trim(), number: Number(v.prNumber) }
        : v.mode === "github"
          ? { type: "github", repo: v.repo.trim() }
          : { type: "upload", files: v.files },
    asset: v.asset.trim(),
    aiReview: v.aiReview,
    proposeFixes: v.proposeFixes,
  };
}

export const guardianReady = (v: GuardianValue) =>
  v.mode === "pr" ? !!normalizeRepo(v.repo) && Number(v.prNumber) > 0 : v.mode === "github" ? v.repo.trim().length > 2 : v.files.length > 0 && totalSize(v.files) <= MAX_TOTAL;
export const hunterReady = (v: HunterValue) => (v.files.length > 0 || v.pasted.trim().length > 0 || v.indicators.trim().length > 0) && totalSize(v.files) + v.pasted.length <= MAX_TOTAL;
export const sentinelReady = (v: SentinelValue) => !!v.targetId && v.authorized;

/* -------------------------------------------------------- Deployment audit */

export interface DeploymentValue {
  /** "<teamId or personal>:<projectId>" from the picker. */
  pick: string;
  gateMode: "warn" | "block";
  blockSeverities: ("critical" | "high" | "medium")[];
  siteChecks: boolean;
}
interface VercelProjects {
  connection: { available: boolean; status: string; account: string | null; lastError: string | null };
  projects: { id: string; name: string; teamId: string | null; scope: string; framework: string | null; repo: string | null }[];
  refused: string[];
}

export function DeploymentForm({ value, onChange }: { value: DeploymentValue; onChange: (v: DeploymentValue) => void }) {
  const [data, setData] = useState<VercelProjects | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    jsonFetch<VercelProjects>("/api/security/vercel/projects")
      .then((r) => live && setData(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  const connected = data?.connection.status === "connected";
  const chosen = data?.projects.find((p) => `${p.teamId ?? "personal"}:${p.id}` === value.pick);
  return (
    <div className="space-y-4">
      {!data && !error ? (
        <p className="flex items-center gap-2 text-[13.5px] text-s-ink-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking your Vercel connection…
        </p>
      ) : error ? (
        <p role="alert" className="text-[13.5px] text-s-danger">
          {error}
        </p>
      ) : !connected ? (
        <p className="rounded-xl border border-s-line p-3 text-[13.5px] text-s-ink-2">
          {data!.connection.status === "reauth_required" || data!.connection.status === "error" ? "Your Vercel connection needs attention. " : "Vercel isn't connected. "}
          Connect it on the{" "}
          <a href="/connectors" className="underline underline-offset-2">
            Connectors page
          </a>{" "}
          (read access to projects and deployments is enough), then come back.
        </p>
      ) : (
        <div>
          <label htmlFor="deploy-project" className={labelCls}>
            Vercel project
          </label>
          <select id="deploy-project" value={value.pick} onChange={(e) => onChange({ ...value, pick: e.target.value })} className={inputCls}>
            <option value="">Choose a project</option>
            {data!.projects.map((p) => (
              <option key={`${p.teamId}:${p.id}`} value={`${p.teamId ?? "personal"}:${p.id}`}>
                {p.name} · {p.scope}
                {p.framework ? ` · ${p.framework}` : ""}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[12.5px] text-s-ink-3">
            Connected as {data!.connection.account ?? "your Vercel account"}. {data!.projects.length} project(s)
            {data!.refused.length ? `; no access to ${data!.refused.join(", ")} (install Orbis's Vercel app there to include them)` : ""}.
            {chosen?.repo ? ` Linked repository: ${chosen.repo} — its open Code Guardian findings count towards the gate.` : ""}
          </p>
        </div>
      )}
      <p className="text-[12.5px] text-s-ink-3">
        Read-only. Orbis reads project settings, domains, recent deployments and the names, types and targets of environment variables — never their values — then makes one request to a preview
        deployment and passive header checks on the production domain. Nothing on Vercel is changed.
      </p>
      <div className="rounded-2xl border border-s-line p-3">
        <span className="block text-[12.5px] font-medium text-s-ink-2">Deploy gate</span>
        <div className="mt-2">
          <Segmented
            label="Gate mode"
            value={value.gateMode}
            onChange={(gateMode) => onChange({ ...value, gateMode })}
            options={[
              { value: "warn", label: "Warn only" },
              { value: "block", label: "Block" },
            ]}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-3">
          {(["critical", "high", "medium"] as const).map((sv) => (
            <label key={sv} className="flex cursor-pointer items-center gap-1.5 text-[13px] capitalize">
              <input
                type="checkbox"
                checked={value.blockSeverities.includes(sv)}
                onChange={(e) => onChange({ ...value, blockSeverities: e.target.checked ? [...value.blockSeverities, sv] : value.blockSeverities.filter((x) => x !== sv) })}
                className="h-4 w-4 accent-[var(--s-accent)]"
              />
              {sv}
            </label>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-s-ink-3">
          Only confirmed or likely findings count; findings that still need verification never block. The result is advice: Orbis doesn&apos;t stop builds on Vercel.
        </p>
      </div>
      <label className="flex items-center justify-between gap-3 text-[13.5px]">
        <span>
          Check the live production site
          <span className="block text-[12.5px] text-s-ink-3">Passive header, TLS and cookie checks on the project&apos;s verified domain.</span>
        </span>
        <Switch checked={value.siteChecks} onChange={(siteChecks) => onChange({ ...value, siteChecks })} label="Check the live production site" />
      </label>
    </div>
  );
}

export function deploymentBody(v: DeploymentValue) {
  const [team, project] = v.pick.split(":");
  return { project, teamId: team === "personal" ? null : team, gate: { mode: v.gateMode, blockSeverities: v.blockSeverities }, siteChecks: v.siteChecks };
}
export const deploymentReady = (v: DeploymentValue) => v.pick.includes(":") && v.blockSeverities.length > 0;
