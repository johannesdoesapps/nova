"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, Code2, FlaskConical, FolderGit2, Globe, Lightbulb, Plus, Server, Terminal, Trash2, X } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { forgetPlace } from "@/components/studio/mode-switch";
import { StudioHeader } from "@/components/studio/frame";
import { Menu, MenuItem } from "@/components/studio/ui";
import { SITE_EXAMPLES, siteExample } from "@/lib/code/site-examples";
import { EXAMPLE_PROJECT, TEMPLATES, TEMPLATE_IDS, type ProjectSummary, type TemplateId } from "@/lib/code/projects";
import { cn } from "@/lib/utils";
import { api, CodeApiError, post, putBuildRequest, type Allowance } from "./api";
import { useAttachments } from "./attachments";
import { PromptBar } from "./prompt-bar";
import { useCodeModel } from "./use-code-model";
import { useCatalog } from "@/components/common/model-picker";
import { ModelSelector } from "@/components/studio/model-selector";
import { Greeting } from "@/components/studio/greeting";

export { SITE_EXAMPLES };

/**
 * Code's start screen: one prompt bar, front and centre. Starting a project
 * another way (template, GitHub, the example) is in the New menu, ideas are
 * behind the bulb, and the user's projects behind "Your projects".
 */

const ICON: Record<TemplateId, typeof Globe> = { website: Globe, node: Server, python: Terminal, blank: Code2 };

interface ListData {
  projects: ProjectSummary[];
  maxProjects: number | null;
  allowance: Allowance;
  plan: string;
}

interface Repo {
  fullName: string;
  private: boolean;
}

export function minutesLine(a: Allowance): string {
  if (a.limit === null) return "Workspace time: no limit on your account.";
  if (a.limit === 0) return "Your plan doesn't include workspace computer time.";
  return `${a.left?.toLocaleString("en-US")} of ${a.limit.toLocaleString("en-US")} workspace minutes left this month`;
}

/** A short project name from a website request. */
export function siteName(prompt: string): string {
  const called = prompt.match(/\bcalled\s+["“]?([A-Z][\w&' -]{1,30}?)["”]?(?=[.,;:!?]|\s+(?:with|that|for|and|in)\b|$)/);
  if (called) return `Website: ${called[1]!.trim()}`;
  const words = prompt
    .replace(/^\s*(please\s+)?(build|create|make|design|write)\s+(me\s+)?(an?|the)?\s*/i, "")
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .replace(/[.,;:!?]+$/, "");
  const name = words ? words[0]!.toUpperCase() + words.slice(1) : "New website";
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

const edited = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export function CodeProjectsView() {
  const { user } = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const [data, setData] = useState<ListData | null>(null);
  const [error, setError] = useState<CodeApiError | null>(null);
  const [open, setOpen] = useState<"new" | "github" | null>(params.get("new") ? "new" : null);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<TemplateId>("website");
  const [busy, setBusy] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoNote, setRepoNote] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const newRef = useRef<HTMLElement>(null);
  // "?idea=<id>" (from the public site, carried through sign-up) fills the box with that example to edit or send.
  const [site, setSite] = useState(() => siteExample(params.get("idea"))?.prompt ?? "");
  const catalog = useCatalog();
  const [modelId, setModelId] = useCodeModel(catalog);
  const [siteTarget, setSiteTarget] = useState<string>("new");
  const siteBox = useRef<HTMLTextAreaElement>(null);
  const [showAll, setShowAll] = useState(false);
  // Files and images for the build, uploaded once its project exists.
  const attachments = useAttachments(null);
  /** The project a failed "Build website" already made, so trying again doesn't make another. */
  const created = useRef<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    api<ListData>("/api/code/projects")
      .then((d) => alive && setData(d))
      .catch((e: CodeApiError) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [user]);

  // "New project" from the sidebar or the command palette opens the form.
  const wantsNew = params.get("new");
  useEffect(() => {
    if (!wantsNew) return;
    newRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [wantsNew]);

  const full = !!data && data.maxProjects !== null && data.projects.length >= data.maxProjects;

  const create = async () => {
    setBusy("new");
    setError(null);
    try {
      const r = await post<{ project: ProjectSummary }>("/api/code/projects", { name: name.trim() || TEMPLATES[template].label, template });
      router.push(`/code/${r.project.id}`);
    } catch (e) {
      setError(e as CodeApiError);
      setBusy(null);
    }
  };

  /**
   * "Build website": a new project from the website template (or the chosen
   * existing one), then its page, where the agent starts on the request at
   * once, working on its own; it changes only that project.
   */
  const buildSite = async () => {
    const text = site.trim();
    if (!text) return siteBox.current?.focus();
    if (attachments.busy || busy || (siteTarget === "new" && full)) return;
    setBusy("build");
    setError(null);
    try {
      let pid = siteTarget;
      if (pid === "new") pid = created.current ??= (await post<{ project: ProjectSummary }>("/api/code/projects", { name: siteName(text), template: "website" })).project.id;
      const ids = await attachments.uploadTo(pid);
      putBuildRequest(pid, text, ids, modelId);
      router.push(`/code/${pid}?build=1`);
    } catch (e) {
      setError(e instanceof CodeApiError ? e : new CodeApiError((e as Error).message, 0, null, null));
      setBusy(null);
    }
  };

  /** An ordinary Node.js project with the example's files and Run command; the agent's box is filled in. */
  const tryExample = async () => {
    setBusy("example");
    setError(null);
    try {
      const r = await post<{ project: ProjectSummary }>("/api/code/projects", { name: EXAMPLE_PROJECT.name, template: EXAMPLE_PROJECT.template });
      const pid = r.project.id;
      const starter = Object.keys(TEMPLATES[EXAMPLE_PROJECT.template].files).filter((p) => !(p in EXAMPLE_PROJECT.files));
      await post(`/api/code/projects/${pid}/files`, {
        changes: [...Object.entries(EXAMPLE_PROJECT.files).map(([path, content]) => ({ path, content })), ...starter.map((path) => ({ path, content: null }))],
      });
      await api(`/api/code/projects/${pid}`, { method: "PATCH", body: JSON.stringify({ runCommand: EXAMPLE_PROJECT.runCommand }) });
      router.push(`/code/${pid}?task=example`);
    } catch (e) {
      setError(e as CodeApiError);
      setBusy(null);
    }
  };

  const loadRepos = async () => {
    setOpen("github");
    if (repos) return;
    setRepoNote(null);
    try {
      const s = await api<{ configured: boolean; linked: boolean; installed: boolean }>("/api/github/status");
      if (!s.configured) return setRepoNote("GitHub isn't set up on this site yet.");
      if (!s.linked || !s.installed) return setRepoNote("Connect GitHub first: open Connectors and connect GitHub, or in a chat press + and choose “Add from GitHub”.");
      const r = await api<{ repos: Repo[] }>("/api/github/repos");
      setRepos(r.repos);
      if (!r.repos.length) setRepoNote("Orbis can't see any of your repositories yet.");
    } catch (e) {
      setRepoNote((e as Error).message);
    }
  };

  const importRepo = async () => {
    if (!repo) return;
    setBusy("github");
    setError(null);
    try {
      const r = await post<{ project: ProjectSummary }>("/api/code/import", { repo });
      router.push(`/code/${r.project.id}`);
    } catch (e) {
      setError(e as CodeApiError);
      setBusy(null);
    }
  };

  const remove = async (p: ProjectSummary) => {
    if (!confirm(`Delete “${p.name}” and all its files? This can't be undone.`)) return;
    try {
      await api(`/api/code/projects/${p.id}`, { method: "DELETE" });
      forgetPlace("code", `/code/${p.id}`);
      setData((d) => d && { ...d, projects: d.projects.filter((x) => x.id !== p.id) });
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  const header = (
    <StudioHeader
      actions={
        user ? (
          <Menu
            label="Start a project"
            align="end"
            width={260}
            disabled={!!busy}
            buttonLabel="New project"
            buttonTitle="New project, import or example"
            buttonClassName="inline-flex h-8 items-center gap-1.5 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 transition hover:border-s-line-strong hover:text-s-ink disabled:opacity-50"
            button={
              <>
                <Plus className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">New</span>
              </>
            }
          >
            <MenuItem icon={<Plus />} hint="Website, Node.js, Python or blank" disabled={full} onClick={() => setOpen("new")}>
              New project from a template
            </MenuItem>
            <MenuItem icon={<FolderGit2 />} hint="Copies a repository; yours isn't changed" onClick={() => void loadRepos()}>
              Import from GitHub
            </MenuItem>
            <MenuItem icon={<FlaskConical />} hint="A small app with a bug for the agent to fix" disabled={full} onClick={() => void tryExample()}>
              {busy === "example" ? "Setting up…" : "Try an example"}
            </MenuItem>
          </Menu>
        ) : undefined
      }
    >
      <span className="text-[14px] font-medium text-s-ink-2">Code</span>
    </StudioHeader>
  );

  const title = (
    <div className="flex flex-col items-center">
      <Greeting name={user?.displayName} />
      <h1 className="s-in mt-2 text-center font-serif text-[clamp(30px,4.5vw,42px)] leading-[1.08] tracking-[-0.01em] [animation-delay:80ms]">What would you like to build?</h1>
    </div>
  );

  if (!user) {
    return (
      <>
        {header}
        <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col items-center justify-center px-4 py-12 text-center sm:px-8">
            {title}
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-s-ink-3">
              Describe it in plain English. Orbis&apos;s coding agent writes the code, runs it on a private computer, and shows you exactly what changed.
            </p>
            <Link href="/login?next=/code" className="mt-7 inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110">
              Sign in to start
            </Link>
          </div>
        </div>
      </>
    );
  }

  const count = data?.projects.length ?? 0;
  const target = data?.projects.find((p) => p.id === siteTarget);

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col px-4 sm:px-8">
          <div className="flex flex-1 flex-col justify-center py-10">
            {title}

            <section className="mt-7" aria-label="Describe what to build">
              <PromptBar
                id="build-site"
                label={target ? `Describe the change to ${target.name}` : "Describe the website you want to build"}
                inputRef={siteBox}
                value={site}
                onChange={setSite}
                onSubmit={() => void buildSite()}
                sending={busy === "build"}
                attachments={attachments}
                placeholder={target ? `Describe the change to “${target.name}”…` : "Describe the website you want to build…"}
                working={busy === "build"}
                footerLeft={
                  <>
                    <label htmlFor="build-target" className="sr-only">
                      Project
                    </label>
                    <select
                      id="build-target"
                      value={siteTarget}
                      onChange={(e) => setSiteTarget(e.target.value)}
                      title="Where the agent works: a new website project, or one of yours. It writes the files, runs the site on the project's private computer (this uses workspace minutes), checks it in a real browser and fixes what it finds. Every change can be undone."
                      className="h-8 min-w-0 max-w-[230px] truncate rounded-full bg-transparent px-2 text-[12.5px] text-s-ink-2 hover:bg-s-hover hover:text-s-ink"
                    >
                      <option value="new">New website project</option>
                      {(data?.projects ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          Change “{p.name}”
                        </option>
                      ))}
                    </select>
                  </>
                }
                footerRight={
                  <>
                    {siteTarget === "new" && full && <span className="text-[12.5px] text-s-danger">Project limit reached</span>}
                    <Menu
                      label="Ideas"
                      align="end"
                      side="auto"
                      width={250}
                      buttonLabel="Ideas to start from"
                      buttonTitle="Ideas to start from"
                      buttonClassName="grid h-8 w-8 place-items-center rounded-full text-s-ink-3 transition hover:bg-s-hover hover:text-s-ink [&_svg]:h-4 [&_svg]:w-4"
                      button={<Lightbulb />}
                    >
                      {SITE_EXAMPLES.map((x) => (
                        <MenuItem
                          key={x.label}
                          onClick={() => {
                            setSite(x.prompt);
                            requestAnimationFrame(() => siteBox.current?.focus());
                          }}
                        >
                          {x.label}
                        </MenuItem>
                      ))}
                    </Menu>
                    <ModelSelector models={catalog?.models ?? null} value={modelId} onChange={setModelId} auto={catalog?.auto ?? null} className="min-w-0 !shrink" />
                  </>
                }
              />
            </section>

            {error && (
              <p role="alert" className="mt-4 rounded-xl border border-s-danger/40 px-3.5 py-2.5 text-[13px] text-s-danger">
                {error.message}{" "}
                {error.upgrade && (
                  <Link href="/pricing" className="underline">
                    See plans
                  </Link>
                )}
              </p>
            )}

            {open === "github" && (
              <section ref={newRef} className="glass-strong mt-4 rounded-2xl p-4" aria-label="Import from GitHub">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    {repos && repos.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        <label htmlFor="code-repo" className="sr-only">
                          Repository
                        </label>
                        <select id="code-repo" value={repo} onChange={(e) => setRepo(e.target.value)} className="h-10 min-w-0 flex-1 rounded-full border border-s-line bg-s-bg px-3 text-[13.5px]">
                          <option value="">Choose a repository…</option>
                          {repos.map((r) => (
                            <option key={r.fullName} value={r.fullName}>
                              {r.fullName}
                              {r.private ? " (private)" : ""}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!repo || !!busy || full}
                          onClick={() => void importRepo()}
                          className="h-10 rounded-full bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink disabled:opacity-40"
                        >
                          {busy === "github" ? "Importing…" : "Import"}
                        </button>
                      </div>
                    )}
                    {!repos && !repoNote && <p className="text-[13px] text-s-ink-3">Looking for your repositories…</p>}
                    {repoNote && <p className="text-[13px] text-s-ink-2">{repoNote}</p>}
                    <p className="mt-2 text-[12px] text-s-ink-3">
                      Text files up to 100 KB from the default branch are copied. Later, Update from GitHub brings in new changes without touching yours, and Push to GitHub sends your changes to a new
                      branch.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpen(null)}
                    aria-label="Close"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </section>
            )}

            {open === "new" && (
              <section ref={newRef} className="glass-strong mt-4 scroll-mt-4 rounded-2xl p-4" aria-label="New project">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-[14px] font-medium text-s-ink">New project</h2>
                  <button type="button" onClick={() => setOpen(null)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-s-ink-3 hover:bg-s-hover hover:text-s-ink">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Template">
                  {TEMPLATE_IDS.map((id) => {
                    const t = TEMPLATES[id];
                    const Icon = ICON[id];
                    return (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        onClick={() => setTemplate(id)}
                        aria-checked={template === id}
                        className={cn("rounded-2xl border p-3 text-left transition", template === id ? "border-s-line-strong bg-s-hover" : "border-s-line hover:border-s-line-strong")}
                      >
                        <Icon className="h-4 w-4 text-s-ink-2" />
                        <div className="mt-2 text-[14px] font-medium">{t.label}</div>
                        <div className="mt-0.5 text-[12.5px] leading-snug text-s-ink-3">{t.description}</div>
                      </button>
                    );
                  })}
                </div>
                <form
                  className="mt-3 flex flex-wrap gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void create();
                  }}
                >
                  <label htmlFor="code-name" className="sr-only">
                    Project name
                  </label>
                  <input
                    id="code-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={80}
                    placeholder={`Name (e.g. My ${TEMPLATES[template].label.toLowerCase()})`}
                    className="h-10 min-w-0 flex-1 rounded-full border border-s-line bg-transparent px-4 text-[14px] outline-none focus:border-s-line-strong"
                  />
                  <button
                    type="submit"
                    disabled={!!busy || full}
                    className="inline-flex h-10 items-center gap-2 rounded-full bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-40"
                  >
                    <Plus className="h-4 w-4" /> {busy === "new" ? "Creating…" : "Create project"}
                  </button>
                </form>
                {full && (
                  <p className="mt-2 text-[12.5px] text-s-ink-3">
                    You have {data!.maxProjects} projects, the most your plan keeps. Delete one to make room, or{" "}
                    <Link href="/pricing" className="underline">
                      upgrade
                    </Link>
                    .
                  </p>
                )}
              </section>
            )}
          </div>

          {count > 0 && (
            <section className="pb-6" aria-label="Your projects">
              <button
                type="button"
                onClick={() => setShowAll(!showAll)}
                aria-expanded={showAll}
                aria-controls="code-projects"
                className="mx-auto flex items-center gap-1 rounded-full px-3 py-1.5 text-[12.5px] text-s-ink-3 transition hover:bg-s-hover hover:text-s-ink"
              >
                Your projects ({count}) <ChevronDown className={cn("h-3.5 w-3.5 transition", showAll && "rotate-180")} aria-hidden />
              </button>
              {showAll && data && (
                <div id="code-projects" className="mt-2">
                  <ul className="divide-y divide-s-line rounded-2xl border border-s-line">
                    {data.projects.map((p) => {
                      const Icon = ICON[p.template as TemplateId] ?? FolderGit2;
                      return (
                        <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                          <Icon className="h-4 w-4 shrink-0 text-s-ink-3" />
                          <Link href={`/code/${p.id}`} className="min-w-0 flex-1">
                            <div className="truncate text-[14px] font-medium">{p.name}</div>
                            <div className="truncate text-[12px] text-s-ink-3">
                              {p.sourceRepo ? `From ${p.sourceRepo} · ` : ""}Edited {edited(p.updatedAt)}
                            </div>
                          </Link>
                          <button
                            type="button"
                            onClick={() => void remove(p)}
                            aria-label={`Delete ${p.name}`}
                            title="Delete project"
                            className="grid h-8 w-8 place-items-center rounded-xl text-s-ink-3 hover:bg-s-hover hover:text-s-danger"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                          <Link href={`/code/${p.id}`} aria-label={`Open ${p.name}`} title="Open" className="grid h-8 w-8 place-items-center rounded-xl text-s-ink-2 hover:bg-s-hover">
                            <ArrowRight className="h-4 w-4" />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-3 text-[12px] leading-relaxed text-s-ink-3">
                    Your files are saved to your account. Code runs on a private computer for each project, which can only download packages from npm and PyPI. {minutesLine(data.allowance)}
                  </p>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
