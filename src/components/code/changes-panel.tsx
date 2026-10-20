"use client";
import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, GitBranch, History, Loader2, Undo2, X } from "lucide-react";
import { STATUS_LABEL, type AgentChange, type RunView } from "@/lib/code/agent/types";
import { cn } from "@/lib/utils";
import { api, CodeApiError, post } from "./api";
import { FileDiff } from "./diff-view";

/**
 * The project's history: every agent run, the files each one changed (as
 * diffs), and reverting a run or a single file. Also pushing the project to
 * a new GitHub branch, which the user confirms.
 */

type RunWithCount = RunView & { changedFiles: number };
type RevertResult = { ok: boolean; reverted: string[]; conflicts: string[] };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function ChangesPanel({ projectId, sourceRepo, focusRun, onFilesChanged }: { projectId: string; sourceRepo: string | null; focusRun: string | null; onFilesChanged: () => void }) {
  const [runs, setRuns] = useState<RunWithCount[] | null>(null);
  const [selected, setSelected] = useState<string | null>(focusRun);
  const [loadedChanges, setLoadedChanges] = useState<{ runId: string; list: AgentChange[] } | null>(null);
  const [error, setError] = useState<CodeApiError | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [version, setVersion] = useState(0);
  const changes = selected && loadedChanges?.runId === selected ? loadedChanges.list : null;

  useEffect(() => {
    let live = true;
    api<{ runs: RunWithCount[] }>(`/api/code/projects/${projectId}/agent`)
      .then((r) => live && setRuns(r.runs))
      .catch((e: CodeApiError) => live && setError(e));
    return () => {
      live = false;
    };
  }, [projectId, version]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    api<{ changes: AgentChange[] }>(`/api/code/agent/${selected}?after=999999`)
      .then((r) => live && setLoadedChanges({ runId: selected, list: r.changes }))
      .catch((e: CodeApiError) => live && setError(e));
    return () => {
      live = false;
    };
  }, [selected, version]);

  const revert = async (runId: string, path?: string) => {
    setWorking(path ?? "all");
    setError(null);
    try {
      let r = await post<RevertResult>(`/api/code/agent/${runId}/revert`, { path });
      if (!r.ok && r.conflicts.length) {
        const sure = confirm(`These files changed after the agent's run:\n\n${r.conflicts.join("\n")}\n\nRevert anyway? Your later changes to them will be lost.`);
        if (!sure) return;
        r = await post<RevertResult>(`/api/code/agent/${runId}/revert`, { path, force: true });
      }
      if (r.reverted.length) onFilesChanged();
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e as CodeApiError);
    } finally {
      setWorking(null);
    }
  };

  const run = runs?.find((r) => r.id === selected) ?? null;
  const live = (changes ?? []).filter((c) => c.before !== c.after);
  const active = live.filter((c) => !c.revertedAt);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-s-line px-3">
        {selected ? (
          <button type="button" onClick={() => setSelected(null)} className="inline-flex items-center gap-1 text-[12px] text-s-ink-2 hover:text-s-ink">
            <ArrowLeft className="h-3.5 w-3.5" /> All runs
          </button>
        ) : (
          <>
            <History className="h-3.5 w-3.5 text-s-ink-3" />
            <span className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Changes</span>
          </>
        )}
        <button type="button" onClick={() => setPushing(true)} className="ml-auto inline-flex h-7 items-center gap-1 rounded-full border border-s-line px-2.5 text-[12px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink">
          <GitBranch className="h-3.5 w-3.5" /> Push to GitHub
        </button>
      </div>

      <div className="s-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-s-danger/40 px-3 py-2 text-[13px] text-s-danger" role="alert">
            <p className="min-w-0 flex-1">{error.message}</p>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 text-s-ink-3 hover:text-s-ink">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {pushing && <PushForm projectId={projectId} sourceRepo={sourceRepo} onClose={() => setPushing(false)} />}

        {!selected && (
          <>
            {runs === null && <div className="s-skeleton h-20 w-full rounded-xl" />}
            {runs?.length === 0 && <p className="text-[13px] text-s-ink-3">No agent runs yet. Changes the agent makes appear here, where you can review and revert them.</p>}
            <ul className="space-y-1.5">
              {runs?.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setSelected(r.id)} className="w-full rounded-xl border border-s-line px-3 py-2 text-left hover:border-s-line-strong">
                    <p className="line-clamp-2 text-[13px] text-s-ink">{r.request}</p>
                    <p className="mt-0.5 text-[11.5px] text-s-ink-3">
                      {when(r.createdAt)} · {STATUS_LABEL[r.status]} · {r.changedFiles} file{r.changedFiles === 1 ? "" : "s"} changed
                    </p>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11.5px] leading-snug text-s-ink-3">
              While the computer is on, it also keeps a local Git history of the session: run <code className="font-mono">git status</code> or <code className="font-mono">git diff</code> in the terminal.
            </p>
          </>
        )}

        {selected && (
          <div className="space-y-2">
            {run && (
              <div className="rounded-xl border border-s-line bg-s-hover/40 px-3 py-2 text-[13px]">
                <p className="whitespace-pre-wrap text-s-ink">{run.request}</p>
                <p className="mt-0.5 text-[11.5px] text-s-ink-3">
                  {when(run.createdAt)} · {STATUS_LABEL[run.status]}
                </p>
                {run.summary && <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] text-s-ink-2">{run.summary}</p>}
              </div>
            )}
            {changes === null && <div className="s-skeleton h-20 w-full rounded-xl" />}
            {changes && live.length === 0 && <p className="text-[13px] text-s-ink-3">This run didn&apos;t change any files.</p>}
            {active.length > 0 && (
              <button
                type="button"
                disabled={!!working}
                onClick={() => void revert(selected)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-danger hover:text-s-danger disabled:opacity-40"
              >
                {working === "all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} Revert all {active.length} file{active.length === 1 ? "" : "s"}
              </button>
            )}
            {live.map((c) => (
              <FileDiff
                key={c.id}
                change={{ path: c.path, before: c.before, after: c.after }}
                defaultOpen={live.length <= 4}
                note={c.revertedAt ? `Reverted ${when(c.revertedAt)}` : undefined}
                actions={
                  !c.revertedAt && (
                    <button
                      type="button"
                      disabled={!!working}
                      onClick={() => void revert(selected, c.path)}
                      title={`Put ${c.path} back as it was before this run`}
                      className={cn("ml-1 inline-flex shrink-0 items-center gap-1 rounded-full border border-s-line px-2 py-px text-[11px] text-s-ink-2 hover:border-s-danger hover:text-s-danger disabled:opacity-40")}
                    >
                      {working === c.path ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />} Revert
                    </button>
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PushForm({ projectId, sourceRepo, onClose }: { projectId: string; sourceRepo: string | null; onClose: () => void }) {
  const [repo, setRepo] = useState(sourceRepo ?? "");
  const [branch, setBranch] = useState(() => `orbis/changes-${new Date().toISOString().slice(0, 10)}`);
  const [message, setMessage] = useState("Changes from Orbis");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ compareUrl: string; commitUrl: string; branch: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const push = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await post(`/api/code/projects/${projectId}/github-push`, { repo: repo.trim(), branch: branch.trim(), message: message.trim(), confirm: true }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = "mt-1 block h-8 w-full rounded-lg border border-s-line bg-transparent px-2 text-[13px] outline-none focus:border-s-line-strong";
  return (
    <div className="mb-3 rounded-xl border border-s-line p-3 text-[13px]">
      <div className="flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-s-ink-3" />
        <span className="font-medium text-s-ink">Push to a new GitHub branch</span>
        <button type="button" onClick={onClose} aria-label="Close" className="ml-auto text-s-ink-3 hover:text-s-ink">
          <X className="h-4 w-4" />
        </button>
      </div>
      {result ? (
        <div className="mt-2 space-y-1.5">
          <p className="text-s-ink-2">
            Pushed to <code className="font-mono">{result.branch}</code>.
          </p>
          <a href={result.compareUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-s-ink underline">
            Open a pull request <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : (
        <form
          className="mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void push();
          }}
        >
          <label className="block text-[12px] text-s-ink-2">
            Repository (owner/name)
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="you/your-repo" className={field} autoCapitalize="off" spellCheck={false} />
          </label>
          <label className="block text-[12px] text-s-ink-2">
            New branch
            <input value={branch} onChange={(e) => setBranch(e.target.value)} className={cn(field, "font-mono")} autoCapitalize="off" spellCheck={false} />
          </label>
          <label className="block text-[12px] text-s-ink-2">
            Commit message
            <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} className={field} />
          </label>
          <label className="flex items-start gap-2 text-[12px] text-s-ink-2">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
            Create this branch on GitHub with the project&apos;s files as one commit. Existing branches are never changed.
          </label>
          {error && <p className="text-[12.5px] text-s-danger">{error}</p>}
          <button type="submit" disabled={!confirmed || busy || !repo.trim() || !branch.trim() || !message.trim()} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink disabled:opacity-40">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />} Push
          </button>
          <p className="text-[11.5px] leading-snug text-s-ink-3">Needs GitHub connected to Orbis, with write access for Orbis&apos;s GitHub app on that repository.</p>
        </form>
      )}
    </div>
  );
}
