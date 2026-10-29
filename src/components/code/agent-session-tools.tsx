"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Copy, GitMerge, History, Loader2, Plug, Plus, ShieldCheck, Trash2, Undo2 } from "lucide-react";
import { Dialog } from "@/components/studio/ui";
import type { RunView } from "@/lib/code/agent/types";
import type { ProjectSettings } from "@/lib/code/agent/settings";
import { cn } from "@/lib/utils";
import { api, CodeApiError, post } from "./api";

/**
 * Orbis Code's session tools: the project's agent settings (ORBIS.md, its commands, skills and helpers, the
 * .orbis/settings.json the user may trust, their own permission rules, MCP servers, parallel copies), rewinding a
 * session to before one of the user's messages, and the banner on a parallel copy with Merge back.
 */

export interface AgentConfig {
  instructions: { path: string; chars: number; truncated: boolean } | null;
  commands: { name: string; description: string; argHint: string | null; body: string }[];
  skills: { name: string; description: string; dir: string }[];
  agents: { name: string; description: string }[];
  projectSettings: { status: "none" | "trusted" | "untrusted" | "invalid"; hash: string | null; error: string | null; found: ProjectSettings | null };
  settings: { rules: { allow: string[]; deny: string[] }; mcp: { name: string; url: string; hasToken: boolean }[]; trustedSettings: string | null };
}

/** The project's agent configuration, read once and again on `reload`. */
export function useAgentConfig(projectId: string): { config: AgentConfig | null; reload: () => void } {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    api<AgentConfig>(`/api/code/projects/${projectId}/agent-config`)
      .then((c) => alive && setConfig(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId, n]);
  return { config, reload: useCallback(() => setN((x) => x + 1), []) };
}

const btn = "inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink disabled:opacity-40";
const primary = "inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink hover:brightness-110 disabled:opacity-40";
const input = "block w-full rounded-lg border border-s-line bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-s-line-strong";
const section = "border-t border-s-line pt-4 mt-4 first:mt-0 first:border-0 first:pt-0";
const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function AgentSettingsDialog({ projectId, open, onClose, config, onChanged }: { projectId: string; open: boolean; onClose: () => void; config: AgentConfig | null; onChanged: () => void }) {
  const router = useRouter();
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [mcp, setMcp] = useState({ name: "", url: "", token: "" });
  const [copyTask, setCopyTask] = useState("");
  const [copies, setCopies] = useState<{ id: string; name: string; task: string | null; updatedAt: string }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // The rules text follows what's saved whenever the dialog opens.
  const [shownFor, setShownFor] = useState<AgentConfig | null>(null);
  if (open && config && shownFor !== config) {
    setShownFor(config);
    setAllow(config.settings.rules.allow.join("\n"));
    setDeny(config.settings.rules.deny.join("\n"));
  }
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api<{ copies: typeof copies }>(`/api/code/projects/${projectId}/copies`)
      .then((r) => alive && setCopies(r.copies))
      .catch(() => alive && setCopies([]));
    return () => {
      alive = false;
    };
  }, [open, projectId]);

  const patch = async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    setError(null);
    setSaved(null);
    try {
      await api(`/api/code/projects/${projectId}/agent-config`, { method: "PATCH", body: JSON.stringify(body) });
      setSaved(label);
      onChanged();
      return true;
    } catch (e) {
      setError((e as CodeApiError).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const ps = config?.projectSettings;
  return (
    <Dialog open={open} onClose={onClose} title="Agent settings for this project" description="What the agent is told, what it may do without asking, and the outside tools it can use." width={640}>
      {!config ? (
        <div className="s-skeleton h-40 w-full rounded-xl" />
      ) : (
        <div className="text-[13px] leading-relaxed text-s-ink-2">
          <section className={section}>
            <h3 className="mb-1 text-[13.5px] font-semibold text-s-ink">Project instructions</h3>
            {config.instructions ? (
              <p>
                <code className="font-mono text-[12px]">{config.instructions.path}</code> ({config.instructions.chars.toLocaleString()} characters) is given to the agent at the start of every session
                {config.instructions.truncated ? " (the first 12,000 characters; it reads the rest when it needs to)" : ""}.
              </p>
            ) : (
              <p>
                No <code className="font-mono text-[12px]">ORBIS.md</code> yet. Type <code className="font-mono text-[12px]">/init</code> in the task box and the agent writes one: how to run, test and build the project, and its conventions.
              </p>
            )}
            {(config.commands.length > 0 || config.skills.length > 0 || config.agents.length > 0) && (
              <ul className="mt-2 space-y-1 text-[12.5px]">
                {config.commands.map((c) => (
                  <li key={`c-${c.name}`}>
                    <code className="font-mono text-s-ink">/{c.name}</code> — {c.description}
                  </li>
                ))}
                {config.skills.map((s) => (
                  <li key={`s-${s.name}`}>
                    Skill <span className="text-s-ink">{s.name}</span> — {s.description}
                  </li>
                ))}
                {config.agents.map((a) => (
                  <li key={`a-${a.name}`}>
                    Helper <span className="text-s-ink">{a.name}</span> — {a.description}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-[12px] text-s-ink-3">
              Add your own: <code className="font-mono">.orbis/commands/name.md</code> (a slash command; <code className="font-mono">$ARGUMENTS</code> is what you type after it),{" "}
              <code className="font-mono">.orbis/skills/name/SKILL.md</code> and <code className="font-mono">.orbis/agents/name.md</code>.
            </p>
          </section>

          <section className={section}>
            <h3 className="mb-1 flex items-center gap-1.5 text-[13.5px] font-semibold text-s-ink">
              <ShieldCheck className="h-4 w-4" aria-hidden /> Project settings file
            </h3>
            {ps?.status === "none" && (
              <p>
                No <code className="font-mono text-[12px]">.orbis/settings.json</code>. It can hold permission rules, hooks (commands run before or after the agent edits or runs something) and MCP servers for everyone working on this project.
              </p>
            )}
            {ps?.status === "invalid" && <p className="text-s-danger">{ps.error}</p>}
            {(ps?.status === "untrusted" || ps?.status === "trusted") && ps.found && (
              <>
                <p>
                  {ps.status === "trusted"
                    ? "You trust this version, so its rules, hooks and servers are in effect."
                    : "It does nothing until you trust it: a project can come from anyone's repository, and hooks run commands. Any change to the file needs trusting again."}
                </p>
                <pre className="s-scroll mt-2 max-h-48 overflow-auto rounded-lg bg-[var(--s-code,transparent)] p-2 font-mono text-[11.5px] text-s-ink-2">
                  {[
                    ...ps.found.permissions.allow.map((r) => `allow  ${r}`),
                    ...ps.found.permissions.deny.map((r) => `deny   ${r}`),
                    ...ps.found.hooks.pre.map((h) => `before ${h.matcher || "*"}: ${h.command}`),
                    ...ps.found.hooks.post.map((h) => `after  ${h.matcher || "*"}: ${h.command}`),
                    ...ps.found.mcpServers.map((m) => `mcp    ${m.name}: ${m.url}`),
                  ].join("\n") || "(nothing that takes effect)"}
                </pre>
                <div className="mt-2">
                  {ps.status === "untrusted" ? (
                    <button type="button" className={primary} disabled={!!busy} onClick={() => void patch("trust", { trust: ps.hash })}>
                      Trust this version
                    </button>
                  ) : (
                    <button type="button" className={btn} disabled={!!busy} onClick={() => void patch("trust", { trust: null })}>
                      Stop trusting it
                    </button>
                  )}
                </div>
              </>
            )}
          </section>

          <section className={section}>
            <h3 className="mb-1 text-[13.5px] font-semibold text-s-ink">Your permission rules</h3>
            <p className="text-[12.5px]">
              One per line. <code className="font-mono">bash(npm run lint*)</code> commands, <code className="font-mono">edit(src/**)</code> files the agent changes, <code className="font-mono">read(secrets/**)</code> files kept from
              the AI, <code className="font-mono">mcp(github/*)</code> MCP tools. Allowed things run without asking; a deny rule always wins. Orbis&apos;s never-run list and Bastion still apply.
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[12px] text-s-ink-3">Allow without asking</span>
                <textarea value={allow} onChange={(e) => setAllow(e.target.value)} rows={5} spellCheck={false} className={cn(input, "font-mono text-[12px]")} placeholder={"bash(npm test*)\nedit(src/**)"} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] text-s-ink-3">Never allow</span>
                <textarea value={deny} onChange={(e) => setDeny(e.target.value)} rows={5} spellCheck={false} className={cn(input, "font-mono text-[12px]")} placeholder={"edit(migrations/**)\nread(.secrets/**)"} />
              </label>
            </div>
            <button type="button" className={cn(primary, "mt-2")} disabled={!!busy} onClick={() => void patch("rules", { rules: { allow: lines(allow), deny: lines(deny) } })}>
              {busy === "rules" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Save rules
            </button>
          </section>

          <section className={section}>
            <h3 className="mb-1 flex items-center gap-1.5 text-[13.5px] font-semibold text-s-ink">
              <Plug className="h-4 w-4" aria-hidden /> MCP servers
            </h3>
            <p className="text-[12.5px]">
              Remote MCP servers (HTTPS) give the agent their tools, named <code className="font-mono">mcp__server__tool</code>. It asks before each call unless the server marks the tool read-only, you allow it, or the
              mode is Full auto. Tokens are encrypted and never shown again.
            </p>
            <ul className="mt-2 space-y-1">
              {config.settings.mcp.map((m) => (
                <li key={m.name} className="flex items-center gap-2 rounded-lg border border-s-line px-2.5 py-1.5">
                  <span className="font-medium text-s-ink">{m.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-s-ink-3">{m.url}</span>
                  {m.hasToken && <span className="text-[11px] text-s-ink-3">token</span>}
                  <button type="button" aria-label={`Remove ${m.name}`} className="text-s-ink-3 hover:text-s-danger" disabled={!!busy} onClick={() => void patch("mcp", { removeMcp: m.name })}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-2 grid gap-2 sm:grid-cols-[120px_1fr]">
              <input aria-label="Server name" value={mcp.name} onChange={(e) => setMcp({ ...mcp, name: e.target.value.toLowerCase() })} placeholder="name" className={input} />
              <input aria-label="Server address" value={mcp.url} onChange={(e) => setMcp({ ...mcp, url: e.target.value })} placeholder="https://example.com/mcp" className={input} />
              <input aria-label="Token (optional)" type="password" value={mcp.token} onChange={(e) => setMcp({ ...mcp, token: e.target.value })} placeholder="token (optional)" autoComplete="off" className={cn(input, "sm:col-span-2")} />
            </div>
            <button
              type="button"
              className={cn(btn, "mt-2")}
              disabled={!!busy || !mcp.name || !mcp.url}
              onClick={async () => {
                if (await patch("mcp", { addMcp: { name: mcp.name.trim(), url: mcp.url.trim(), token: mcp.token || null } })) setMcp({ name: "", url: "", token: "" });
              }}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add server
            </button>
          </section>

          <section className={section}>
            <h3 className="mb-1 flex items-center gap-1.5 text-[13.5px] font-semibold text-s-ink">
              <Copy className="h-4 w-4" aria-hidden /> Parallel copies
            </h3>
            <p className="text-[12.5px]">Run another task at the same time in a copy of this project, then merge it back. Each copy counts as a project on your plan.</p>
            {copies && copies.length > 0 && (
              <ul className="mt-2 space-y-1">
                {copies.map((c) => (
                  <li key={c.id}>
                    <Link href={`/code/${c.id}`} className="flex items-center gap-2 rounded-lg border border-s-line px-2.5 py-1.5 hover:border-s-line-strong">
                      <span className="min-w-0 flex-1 truncate text-s-ink">{c.task ?? c.name}</span>
                      <span className="text-[11.5px] text-s-ink-3">{new Date(c.updatedAt).toLocaleDateString()}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex gap-2">
              <input aria-label="Task for the copy" value={copyTask} onChange={(e) => setCopyTask(e.target.value)} placeholder="What the copy is for" className={input} />
              <button
                type="button"
                className={btn}
                disabled={!!busy || !copyTask.trim()}
                onClick={async () => {
                  setBusy("copy");
                  setError(null);
                  try {
                    const r = await post<{ project: { id: string } }>(`/api/code/projects/${projectId}/copies`, { task: copyTask.trim() });
                    router.push(`/code/${r.project.id}`);
                  } catch (e) {
                    setError((e as CodeApiError).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === "copy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />} Make a copy
              </button>
            </div>
          </section>

          {error && (
            <p role="alert" className="mt-3 text-[12.5px] text-s-danger">
              {error}
            </p>
          )}
          {saved && !error && (
            <p role="status" className="mt-3 text-[12.5px] text-s-ink-3">
              Saved.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

interface RewindPoint {
  id: string;
  message: string;
  createdAt: string;
  conversation: boolean;
}

/** Pick a point before one of your messages: rewind the session there (files too), or fork a new session from it. */
export function RewindDialog({
  run,
  open,
  onClose,
  onRewound,
  onForked,
}: {
  run: RunView | null;
  open: boolean;
  onClose: () => void;
  onRewound: (message: string) => void;
  onForked: (run: RunView) => void;
}) {
  const [points, setPoints] = useState<RewindPoint[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !run) return;
    let alive = true;
    api<{ points: RewindPoint[] }>(`/api/code/agent/${run.id}/rewind`)
      .then((r) => alive && setPoints(r.points))
      .catch((e: CodeApiError) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [open, run]);

  const rewind = async (p: RewindPoint) => {
    if (!run) return;
    setBusy(p.id);
    setError(null);
    try {
      let r = await post<{ ok: boolean; conflicts: string[]; message: string }>(`/api/code/agent/${run.id}/rewind`, { pointId: p.id });
      if (!r.ok && r.conflicts.length) {
        if (!confirm(`These files changed since (by you or another session):\n\n${r.conflicts.join("\n")}\n\nRewind them too? Those later changes will be lost.`)) return;
        r = await post(`/api/code/agent/${run.id}/rewind`, { pointId: p.id, force: true });
      }
      onRewound(r.message);
      onClose();
    } catch (e) {
      setError((e as CodeApiError).message);
    } finally {
      setBusy(null);
    }
  };
  const fork = async (p: RewindPoint) => {
    if (!run) return;
    setBusy(`f${p.id}`);
    setError(null);
    try {
      const r = await post<{ run: RunView }>(`/api/code/agent/${run.id}/fork`, { pointId: p.id, text: p.message });
      onForked(r.run);
      onClose();
    } catch (e) {
      setError((e as CodeApiError).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Rewind" description="Go back to before one of your messages. The conversation is cut there and the files this session changed since are put back; the message comes back to the box so you can change it." width={560}>
      {!points && !error && <div className="s-skeleton h-24 w-full rounded-xl" />}
      {points?.length === 0 && <p className="text-[13px] text-s-ink-3">No points to rewind to yet.</p>}
      <ol className="space-y-1.5">
        {[...(points ?? [])].reverse().map((p) => (
          <li key={p.id} className="rounded-xl border border-s-line px-3 py-2">
            <p className="line-clamp-2 text-[13px] text-s-ink">{p.message}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="text-[11.5px] text-s-ink-3">
                {new Date(p.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                {!p.conversation && " · conversation summarised since: files only"}
              </span>
              <span className="ml-auto flex gap-1.5">
                <button type="button" className={btn} disabled={!!busy} onClick={() => void rewind(p)}>
                  {busy === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Undo2 className="h-3.5 w-3.5" aria-hidden />} Rewind here
                </button>
                <button type="button" className={btn} disabled={!!busy || !p.conversation} onClick={() => void fork(p)} title="Start a new session from this point, with this message">
                  {busy === `f${p.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <History className="h-3.5 w-3.5" aria-hidden />} Fork from here
                </button>
              </span>
            </div>
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="mt-3 text-[12.5px] text-s-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** On a parallel copy: what it's for, and Merge back into the original. */
export function CopyBanner({ project, onMerged }: { project: { id: string; parentProjectId?: string | null; copyTask?: string | null }; onMerged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!project.parentProjectId) return null;
  const merge = async () => {
    setBusy(true);
    setNote(null);
    try {
      let r = await post<{ ok: boolean; applied: string[]; conflicts: string[] }>(`/api/code/projects/${project.id}/merge`, {});
      if (!r.ok && r.conflicts.length) {
        if (!confirm(`These files also changed in the original since the copy was made:\n\n${r.conflicts.join("\n")}\n\nUse this copy's version for them too? The original's changes to those files will be replaced.`)) {
          setNote("Nothing was merged.");
          return;
        }
        r = await post(`/api/code/projects/${project.id}/merge`, { force: true });
      }
      setNote(r.applied.length ? `Merged ${r.applied.length} file${r.applied.length === 1 ? "" : "s"} into the original.` : "Nothing to merge: the original already has these changes.");
      onMerged?.();
    } catch (e) {
      setNote((e as CodeApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-s-line bg-s-hover/40 px-4 py-1.5 text-[12.5px] text-s-ink-2" role="status">
      <Copy className="h-3.5 w-3.5 shrink-0 text-s-ink-3" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        Parallel copy{project.copyTask ? ` for: ${project.copyTask}` : ""}. Work here doesn&apos;t touch the original until you merge it back.
      </span>
      {note && <span className="text-s-ink-3">{note}</span>}
      <Link href={`/code/${project.parentProjectId}`} className="rounded-full px-2 py-0.5 hover:bg-s-hover hover:text-s-ink">
        Open the original
      </Link>
      <button type="button" onClick={() => void merge()} disabled={busy} className="inline-flex items-center gap-1 rounded-full border border-s-line px-2.5 py-0.5 hover:border-s-line-strong hover:text-s-ink disabled:opacity-50">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <GitMerge className="h-3.5 w-3.5" aria-hidden />} Merge back
      </button>
    </div>
  );
}
