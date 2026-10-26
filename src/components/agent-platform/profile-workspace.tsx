"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CircleAlert, FileArchive, GitBranch, Loader2, RotateCcw, Upload } from "lucide-react";
import { api, post, CodeApiError } from "@/components/code/api";
import { useCodeModel } from "@/components/code/use-code-model";
import { useCatalog } from "@/components/common/model-picker";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { ModelSelector } from "@/components/studio/model-selector";
import { Segmented, Switch } from "@/components/studio/ui";
import type { Availability } from "@/lib/agent-platform/availability";
import { agentDef, PERMISSION_LABEL, type AgentDef, type CodeProfile } from "@/lib/agent-platform/registry";
import type { TaskSummary } from "@/lib/code/agent/history";
import { QA_KINDS, type BugInput, type QaInput } from "@/lib/code/agent/profiles";
import type { RunView } from "@/lib/code/agent/types";
import { TASK_STATE_INFO } from "@/lib/code/agent/verdict";
import type { ProjectSummary } from "@/lib/code/projects";
import { ago } from "@/lib/home";
import { cn } from "@/lib/utils";
import { AgentIconTile } from "./marketplace";

const EMPTY_BUG: BugInput = { summary: "", details: "", logs: "", reproduce: "", expected: "" };
const EMPTY_QA: QaInput = { scope: "", kinds: ["unit"], notes: "" };
const KIND_LABEL: Record<(typeof QA_KINDS)[number], string> = { unit: "Unit", integration: "Integration", api: "API" };
const LOG_KEEP = 5_000;

const fieldClass =
  "w-full rounded-xl border border-s-line bg-s-bg/60 px-3 py-2 text-[14px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong focus-visible:outline-2 focus-visible:outline-[var(--s-ring)]";

type Source = "project" | "zip" | "github";

/**
 * The workspace of a task agent built on the coding engine (Bug Fixing, QA Testing): pick or import
 * the project, describe the task in the agent's own form, choose the approvals, and start. The task
 * then runs in the project's Code workspace, where its progress, approvals, changes and report are
 * shown; past tasks are listed here and can be run again with the same form.
 */
export function ProfileWorkspace({ profile }: { profile: CodeProfile }) {
  const def = agentDef(profile)!;
  const router = useRouter();
  const { user } = useApp();
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [source, setSource] = useState<Source>("project");
  const [bug, setBug] = useState<BugInput>(EMPTY_BUG);
  const [qa, setQa] = useState<QaInput>(EMPTY_QA);
  const [approvePlans, setApprovePlans] = useState(true);
  const [reviewEdits, setReviewEdits] = useState(false);
  const [commands, setCommands] = useState<"safe" | "ask">("safe");
  const catalog = useCatalog();
  const [modelId, setModelId] = useCodeModel(catalog);
  const params = useSearchParams();
  // Bug Fixing can run as the first step of the Fix and verify workflow (?workflow=1 from the Workflows page).
  const [asWorkflow, setAsWorkflow] = useState(() => profile === "bug_fixer" && params.get("workflow") === "1");
  // Workflows are only offered where they can run (their database table exists).
  const [workflowsReady, setWorkflowsReady] = useState(false);
  useEffect(() => {
    // Workflows are for signed-in users only; asking while signed out is just a 401.
    if (profile !== "bug_fixer" || !user) return;
    fetch("/api/workflows?check=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { ready: false }))
      .then((j: { ready?: boolean }) => setWorkflowsReady(!!j.ready))
      .catch(() => setWorkflowsReady(false));
  }, [profile, user]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    fetch("/api/agent-platform", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { agents?: { agent: AgentDef; availability: Availability }[] }) => setAvailability(j.agents?.find((a) => a.agent.id === profile)?.availability ?? null))
      .catch(() => setAvailability(null));
  }, [profile]);

  const loadProjects = () =>
    api<{ projects: ProjectSummary[] }>("/api/code/projects")
      .then((r) => {
        setProjects(r.projects);
        setProjectId((cur) => cur || r.projects[0]?.id || "");
      })
      .catch((e: Error) => {
        setProjects([]);
        setError(e.message);
      });
  const loadTasks = () =>
    api<{ tasks: TaskSummary[] }>(`/api/code/tasks?agent=${profile}&sort=newest`)
      .then((r) => setTasks(r.tasks))
      .catch((e: Error) => setTasksError(e.message));

  useEffect(() => {
    if (!user) return;
    void loadProjects();
    void loadTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per user
  }, [user, profile]);

  const ready = availability?.state === "available";
  const valid = profile === "bug_fixer" ? bug.summary.trim().length >= 3 : qa.scope.trim().length >= 3 && qa.kinds.length > 0;

  const uploadZip = async (file: File) => {
    setError(null);
    if (file.size > 3_000_000) return setError("That ZIP is over 3 MB. Leave out node_modules, build output and other generated files.");
    setBusy("zip");
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
        r.onerror = () => reject(new Error("Couldn't read that file."));
        r.readAsDataURL(file);
      });
      const res = await post<{ project: ProjectSummary; imported: number; leftOut: number }>("/api/code/import/zip", { name: file.name.replace(/\.zip$/i, "").slice(0, 80) || "Upload", data });
      setProjects((p) => [res.project, ...(p ?? [])]);
      setProjectId(res.project.id);
      setSource("project");
      setNotice(
        `Imported ${res.imported} file${res.imported === 1 ? "" : "s"} into “${res.project.name}”${res.leftOut ? ` (${res.leftOut} left out: binary, dependency folders or over the limits)` : ""}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      if (zipRef.current) zipRef.current.value = "";
    }
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !valid || busy) return;
    setBusy("start");
    setError(null);
    try {
      if (asWorkflow && workflowsReady) {
        const w = await post<{ workflow: { id: string } }>("/api/workflows", { template: "fix_and_verify", projectId, bug, options: { modelId, approvePlans, commands } });
        router.push(`/agents/workflows/${w.workflow.id}`);
        return;
      }
      const r = await post<{ run: RunView; href: string }>("/api/agent-platform/tasks", {
        agent: profile,
        projectId,
        input: profile === "bug_fixer" ? bug : qa,
        options: { modelId, approvePlans, reviewEdits, commands },
      });
      router.push(r.href);
    } catch (err) {
      const ce = err as CodeApiError;
      setError(ce.code === "conflict" && ce.details?.runId ? `${ce.message} Open it from the project in Code.` : ce.message);
      setBusy(null);
    }
  };

  /** Fill the form from an earlier task, to run it again (the user reviews it and presses Start). */
  const runAgain = async (t: TaskSummary) => {
    setError(null);
    try {
      const { run } = await api<{ run: RunView }>(`/api/code/agent/${t.id}`);
      const input = run.options.agentInput;
      if (profile === "bug_fixer" && input && "summary" in input) setBug({ ...EMPTY_BUG, ...input });
      if (profile === "qa_tester" && input && "scope" in input) setQa({ ...EMPTY_QA, ...input });
      setProjectId(t.projectId);
      setSource("project");
      setApprovePlans(run.options.approvePlans);
      setReviewEdits(run.options.reviewEdits);
      setCommands(run.options.commands === "ask" ? "ask" : "safe");
      setNotice("The form has the earlier task's details. Check them and press Start.");
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const logNote = useMemo(() => (bug.logs.length > LOG_KEEP ? `${bug.logs.length.toLocaleString()} characters: the agent gets the first 2,000 and the last 3,000.` : null), [bug.logs.length]);

  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">
          <Link href="/agents" className="hover:text-s-ink">
            Agents
          </Link>{" "}
          / {def.name}
        </span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-20 pt-2 sm:px-8">
          <div className="s-in flex items-start gap-4">
            <AgentIconTile agent={def} size="lg" />
            <div className="min-w-0">
              <h1 className="font-serif text-[clamp(30px,4.5vw,40px)] leading-[1.08] tracking-[-0.01em]">{def.name}</h1>
              <p className="mt-1.5 text-[15px] text-s-ink-2">{def.description}</p>
            </div>
          </div>

          <ul className="s-in mt-5 flex flex-wrap gap-1.5 [animation-delay:30ms]" aria-label="What this agent's tools may do">
            {def.permissions.map((p) => (
              <li key={p} className="rounded-full border border-s-line px-2.5 py-1 text-[12px] text-s-ink-2">
                {PERMISSION_LABEL[p]}
              </li>
            ))}
          </ul>

          {!user ? (
            <p className="mt-8 s-card rounded-2xl px-4 py-3 text-[14px]">
              <Link href={`/login?next=${encodeURIComponent(def.href)}`} className="font-medium text-s-accent underline-offset-4 hover:underline">
                Sign in
              </Link>{" "}
              to give {def.name} a task.
            </p>
          ) : (
            <form ref={formRef} onSubmit={start} className="glass s-in mt-7 space-y-6 rounded-[24px] p-5 [animation-delay:60ms] sm:p-6" aria-labelledby="new-task">
              <h2 id="new-task" className="text-[17px] font-semibold tracking-[-0.01em]">
                New task
              </h2>

              {availability && availability.state !== "available" && (
                <p role="alert" className="flex items-start gap-2 rounded-xl border border-s-line bg-s-hover/60 px-3 py-2 text-[13.5px] text-s-ink-2">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-s-danger" aria-hidden />
                  <span>
                    {availability.message}
                    {availability.state === "upgrade" && (
                      <>
                        {" "}
                        <Link href="/pricing" className="text-s-accent underline-offset-4 hover:underline">
                          See plans
                        </Link>
                      </>
                    )}
                  </span>
                </p>
              )}

              <fieldset>
                <legend className="text-[13px] font-medium">Project</legend>
                <p className="mt-0.5 text-[12.5px] text-s-ink-3">The agent works on a copy of your code in an Orbis project; nothing reaches GitHub unless you push it.</p>
                <div className="mt-2.5">
                  <Segmented
                    label="Where the code comes from"
                    value={source}
                    onChange={setSource}
                    options={[
                      { value: "project", label: "My projects" },
                      { value: "zip", label: "Upload a ZIP", icon: <FileArchive /> },
                      { value: "github", label: "GitHub", icon: <GitBranch /> },
                    ]}
                  />
                </div>
                <div className="mt-3">
                  {source === "project" ? (
                    projects === null ? (
                      <div className="s-skeleton h-10 w-full rounded-xl" />
                    ) : projects.length === 0 ? (
                      <p className="text-[13.5px] text-s-ink-2">No projects yet. Upload a ZIP or import from GitHub.</p>
                    ) : (
                      <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className={cn(fieldClass, "h-10")}>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                            {p.sourceRepo ? ` (${p.sourceRepo})` : ""}
                          </option>
                        ))}
                      </select>
                    )
                  ) : source === "zip" ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <input ref={zipRef} type="file" accept=".zip,application/zip" className="sr-only" id="agent-zip" onChange={(e) => e.target.files?.[0] && void uploadZip(e.target.files[0])} />
                      <label
                        htmlFor="agent-zip"
                        className={cn(
                          "inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-s-line-strong px-4 text-[13.5px] font-medium hover:bg-s-hover",
                          busy === "zip" && "pointer-events-none opacity-60",
                        )}
                      >
                        {busy === "zip" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Choose a .zip
                      </label>
                      <span className="text-[12.5px] text-s-ink-3">Up to 3 MB; text files only, within the project limits (300 files, 3 MB).</span>
                    </div>
                  ) : (
                    <p className="text-[13.5px] text-s-ink-2">
                      Import a repository as a project in{" "}
                      <Link href="/code?start=github" className="text-s-accent underline-offset-4 hover:underline">
                        Code
                      </Link>
                      , then come back and pick it under My projects. Orbis reads only the repositories you allow in its GitHub App.
                    </p>
                  )}
                </div>
              </fieldset>

              {profile === "bug_fixer" ? (
                <div className="space-y-4">
                  <Field label="What's wrong?" hint="One line, like a bug title." required>
                    {(id) => (
                      <input
                        id={id}
                        value={bug.summary}
                        onChange={(e) => setBug({ ...bug, summary: e.target.value })}
                        maxLength={300}
                        required
                        placeholder="Checkout total is wrong when a discount code is applied"
                        className={cn(fieldClass, "h-10")}
                      />
                    )}
                  </Field>
                  <Field label="Details" hint="What you saw, where, and since when.">
                    {(id) => <textarea id={id} value={bug.details} onChange={(e) => setBug({ ...bug, details: e.target.value })} maxLength={3000} rows={3} className={fieldClass} />}
                  </Field>
                  <Field label="Error output, logs or stack trace" hint={logNote ?? "Paste it as it is. It's given to the agent as data, never as instructions."}>
                    {(id) => (
                      <textarea id={id} value={bug.logs} onChange={(e) => setBug({ ...bug, logs: e.target.value })} rows={6} spellCheck={false} className={cn(fieldClass, "font-mono text-[12.5px]")} />
                    )}
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="How to reproduce">
                      {(id) => <textarea id={id} value={bug.reproduce} onChange={(e) => setBug({ ...bug, reproduce: e.target.value })} maxLength={2000} rows={3} className={fieldClass} />}
                    </Field>
                    <Field label="What should happen">
                      {(id) => <textarea id={id} value={bug.expected} onChange={(e) => setBug({ ...bug, expected: e.target.value })} maxLength={1000} rows={3} className={fieldClass} />}
                    </Field>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <Field label="What should be tested?" hint="A feature, file, function or endpoint, and anything it must handle." required>
                    {(id) => (
                      <textarea
                        id={id}
                        value={qa.scope}
                        onChange={(e) => setQa({ ...qa, scope: e.target.value })}
                        maxLength={2000}
                        rows={3}
                        required
                        placeholder="The cart totals in src/cart.js: discounts, empty carts, rounding"
                        className={fieldClass}
                      />
                    )}
                  </Field>
                  <fieldset>
                    <legend className="text-[13px] font-medium">Kinds of tests</legend>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {QA_KINDS.map((k) => {
                        const on = qa.kinds.includes(k);
                        return (
                          <label
                            key={k}
                            className={cn("inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-[13px]", on ? "border-s-accent bg-s-accent/10" : "border-s-line")}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => setQa({ ...qa, kinds: on ? qa.kinds.filter((x) => x !== k) : [...qa.kinds, k] })}
                              className="accent-[var(--s-accent)]"
                            />
                            {KIND_LABEL[k]}
                          </label>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 text-[12.5px] text-s-ink-3">Browser tests aren&apos;t offered: the isolated computer has no browser installed for them.</p>
                  </fieldset>
                  <Field label="Notes" hint="Frameworks to use, cases you care about, anything to avoid.">
                    {(id) => <textarea id={id} value={qa.notes} onChange={(e) => setQa({ ...qa, notes: e.target.value })} maxLength={2000} rows={2} className={fieldClass} />}
                  </Field>
                </div>
              )}

              {profile === "bug_fixer" && workflowsReady && (
                <div className="s-card rounded-2xl p-4">
                  <Toggle
                    label="Run the full workflow"
                    hint="After the fix: QA Testing adds regression tests and runs them, Code Review checks the changes for bugs and security problems, then you approve or reject (rejecting undoes everything)."
                    checked={asWorkflow}
                    onChange={setAsWorkflow}
                  />
                  <Link href="/agents/workflows" className="mt-2 inline-block text-[12.5px] text-s-accent underline-offset-4 hover:underline">
                    Past workflows
                  </Link>
                </div>
              )}

              <fieldset className="space-y-3 s-card rounded-2xl p-4">
                <legend className="px-1 text-[13px] font-medium">Approvals and model</legend>
                <Toggle
                  label="Approve the plan before anything changes"
                  hint="The agent inspects the code and proposes a plan; nothing is edited or run until you approve it."
                  checked={approvePlans}
                  onChange={setApprovePlans}
                />
                {!(asWorkflow && workflowsReady) && (
                  <Toggle
                    label="Review each set of edits before it's saved"
                    hint="Slower, but you see every change first. Either way, every change can be reverted."
                    checked={reviewEdits}
                    onChange={setReviewEdits}
                  />
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[13.5px]">Commands</p>
                    <p className="text-[12.5px] text-s-ink-3">Safe list: tests, builds, installs and reading run straight away; anything else asks you.</p>
                  </div>
                  <Segmented
                    label="Commands"
                    value={commands}
                    onChange={setCommands}
                    options={[
                      { value: "safe", label: "Safe list" },
                      { value: "ask", label: "Ask every time" },
                    ]}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[13.5px]">Model</p>
                  <ModelSelector models={catalog?.models ?? null} value={modelId} onChange={setModelId} auto={catalog?.auto ?? null} className="min-w-0 !shrink" />
                </div>
              </fieldset>

              {notice && (
                <p role="status" className="text-[13.5px] text-s-ink-2">
                  {notice}
                </p>
              )}
              {error && (
                <p role="alert" className="text-[13.5px] text-s-danger">
                  {error}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-[460px] text-[12.5px] text-s-ink-3">{def.charging}</p>
                <button
                  type="submit"
                  disabled={!ready || !projectId || !valid || !!busy}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-50"
                >
                  {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {asWorkflow && workflowsReady ? "Start the workflow" : `Start ${def.name.toLowerCase()} task`}{" "}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </form>
          )}

          {user && (
            <section aria-labelledby="past-tasks" className="s-in mt-10 [animation-delay:90ms]">
              <h2 id="past-tasks" className="text-[17px] font-semibold tracking-[-0.01em]">
                Past tasks
              </h2>
              {tasksError ? (
                <p role="alert" className="mt-3 text-[13.5px] text-s-danger">
                  {tasksError}
                </p>
              ) : tasks === null ? (
                <div className="mt-3 space-y-2">
                  <div className="s-skeleton h-16 rounded-2xl" />
                  <div className="s-skeleton h-16 rounded-2xl" />
                </div>
              ) : tasks.length === 0 ? (
                <p className="mt-3 rounded-2xl border border-dashed border-s-line-strong px-4 py-6 text-center text-[13.5px] text-s-ink-2">No {def.name} tasks yet.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {tasks.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 s-card rounded-2xl p-3.5">
                      <div className="min-w-0 flex-1">
                        <Link href={`/code/${t.projectId}?run=${t.id}`} className="block truncate text-[14px] font-medium hover:underline">
                          {t.title}
                        </Link>
                        <p className="mt-0.5 text-[12.5px] text-s-ink-3">
                          <span className="font-medium text-s-ink-2">{TASK_STATE_INFO[t.state].label}</span> · {t.projectName} · <span suppressHydrationWarning>{ago(t.updatedAt)}</span>
                          {t.costUsd !== null ? ` · ${t.costUsd < 0.01 ? "under $0.01" : `$${t.costUsd.toFixed(2)}`}` : ""}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Link
                          href={`/code/${t.projectId}?run=${t.id}`}
                          className="inline-flex h-8 items-center rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
                        >
                          Open
                        </Link>
                        {t.continuation.kind === "follow_up" && (
                          <button
                            type="button"
                            onClick={() => void runAgain(t)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
                          >
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Run again
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: (id: string) => React.ReactNode }) {
  const id = `f-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
        {required && <span className="text-s-ink-3"> (required)</span>}
      </label>
      {hint && <p className="mt-0.5 text-[12.5px] text-s-ink-3">{hint}</p>}
      <div className="mt-1.5">{children(id)}</div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-[13.5px]">{label}</p>
        <p className="text-[12.5px] text-s-ink-3">{hint}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}
