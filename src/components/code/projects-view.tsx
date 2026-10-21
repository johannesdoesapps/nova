"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, Code2, FlaskConical, FolderGit2, Globe, Loader2, Plus, Server, ShieldCheck, Sparkles, Terminal, Trash2 } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { forgetPlace } from "@/components/studio/mode-switch";
import { StudioHeader } from "@/components/studio/frame";
import { EXAMPLE_PROJECT, TEMPLATES, TEMPLATE_IDS, type ProjectSummary, type TemplateId } from "@/lib/code/projects";
import { cn } from "@/lib/utils";
import { api, CodeApiError, post, putBuildRequest, type Allowance } from "./api";

/**
 * Code's start screen: what Code does in one sentence, the three steps, the
 * user's recent projects to continue, and the ways to start one (an example
 * with a bug to fix, a GitHub repository, or a new project from a template).
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

/** Example website prompts: each fills the box with a real request to edit or send. */
export const SITE_EXAMPLES: { label: string; prompt: string }[] = [
  {
    label: "Premium SaaS landing page",
    prompt:
      "Build a premium SaaS landing page for an AI note-taking app called Lumen: a sticky navigation bar, a bold hero with a call to action, feature cards, three pricing plans, testimonials (clearly labelled sample content), an FAQ and a footer. Dark theme, responsive on mobile and desktop.",
  },
  {
    label: "Designer portfolio",
    prompt:
      "Create an online portfolio for a product designer: an intro, a grid of six case studies with short descriptions, an about section, and a contact form that validates email addresses. Minimal, light, elegant typography.",
  },
  {
    label: "E-commerce storefront",
    prompt:
      "Build an e-commerce storefront for a small coffee roaster: a product grid with filters, product cards with prices (sample data), a cart drawer that adds and removes items, and a checkout button that explains payments aren't connected yet.",
  },
  {
    label: "Restaurant with reservations",
    prompt:
      "Create a restaurant website for a modern Italian trattoria: hero, menu with sections and prices (sample data), opening hours, location, and a reservation inquiry form with date, time, party size and validation.",
  },
  {
    label: "Dashboard with charts",
    prompt:
      "Build a dashboard for a small online shop with a responsive sidebar that collapses on phones, summary cards, a sales line chart and a category bar chart (sample data, drawn with SVG or canvas), and a recent orders table.",
  },
];

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

const STEPS = [
  { title: "Choose a project", text: "Start from an example, a GitHub repository or a template." },
  { title: "Describe the task", text: "In plain English: “Fix the login bug”, “Add a contact form”." },
  { title: "Review the result", text: "See what changed, the real test results, and undo anything." },
];

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
  const [site, setSite] = useState("");
  const [siteTarget, setSiteTarget] = useState<string>("new");
  const siteBox = useRef<HTMLTextAreaElement>(null);

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
    setBusy("build");
    setError(null);
    try {
      let pid = siteTarget;
      if (pid === "new") pid = (await post<{ project: ProjectSummary }>("/api/code/projects", { name: siteName(text), template: "website" })).project.id;
      putBuildRequest(pid, text);
      router.push(`/code/${pid}?build=1`);
    } catch (e) {
      setError(e as CodeApiError);
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
    <StudioHeader>
      <span className="text-[14px] font-medium text-s-ink-2">Code</span>
    </StudioHeader>
  );

  const intro = (
    <div className="s-in">
      <h1 className="font-serif text-[clamp(32px,5vw,46px)] leading-[1.05] tracking-[-0.01em]">What would you like to build or fix?</h1>
      <p className="mt-3 max-w-2xl text-[15.5px] leading-relaxed text-s-ink-2">
        Pick a project and describe the task in plain English. Orbis&apos;s coding agent explores the code, makes the changes, runs the tests on a private computer, and shows you exactly what changed.
      </p>
      <ol className="mt-6 grid gap-3 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3 rounded-2xl border border-s-line p-3.5">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-s-hover text-[12px] font-medium text-s-ink-2" aria-hidden>
              {i + 1}
            </span>
            <span>
              <span className="block text-[14px] font-medium text-s-ink">{s.title}</span>
              <span className="mt-0.5 block text-[12.5px] leading-snug text-s-ink-3">{s.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );

  if (!user) {
    return (
      <>
        {header}
        <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1040px] px-4 pb-24 pt-4 sm:px-8">
            {intro}
            <Link href="/login?next=/code" className="mt-7 inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110">
              Sign in to start
            </Link>
          </div>
        </div>
      </>
    );
  }

  const recent = data?.projects.slice(0, 3) ?? [];
  const card = "flex flex-col rounded-2xl border border-s-line p-4 text-left transition hover:border-s-line-strong disabled:opacity-50";

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-4 pb-24 pt-4 sm:px-8">
          {intro}

          {error && (
            <p role="alert" className="mt-5 rounded-xl border border-s-danger/40 px-3.5 py-2.5 text-[13px] text-s-danger">
              {error.message}{" "}
              {error.upgrade && (
                <Link href="/pricing" className="underline">
                  See plans
                </Link>
              )}
            </p>
          )}

          <section className="mt-8" aria-labelledby="build-h">
            <form
              className="glass-strong glass-edge rounded-[24px] p-4"
              onSubmit={(e) => {
                e.preventDefault();
                void buildSite();
              }}
            >
              <h2 id="build-h" className="flex items-center gap-2 text-[15px] font-medium text-s-ink">
                <Globe className="h-4 w-4 text-s-ink-2" aria-hidden /> Build a website
              </h2>
              <label htmlFor="build-site" className="sr-only">
                Describe the website you want to build
              </label>
              <textarea
                id="build-site"
                ref={siteBox}
                value={site}
                onChange={(e) => setSite(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void buildSite();
                  }
                }}
                rows={3}
                maxLength={8000}
                placeholder="Describe the website you want to build…"
                className="mt-2 block w-full resize-none bg-transparent px-1 py-1 text-[15px] leading-relaxed outline-none placeholder:text-s-ink-3"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label htmlFor="build-target" className="sr-only">
                  Project
                </label>
                <select
                  id="build-target"
                  value={siteTarget}
                  onChange={(e) => setSiteTarget(e.target.value)}
                  className="h-9 max-w-[260px] rounded-full border border-s-line bg-transparent px-3 text-[13px] text-s-ink-2"
                >
                  <option value="new">New website project</option>
                  {(data?.projects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      Change “{p.name}”
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={!!busy || (siteTarget === "new" && full)}
                  className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-40"
                >
                  {busy === "build" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
                  {busy === "build" ? "Setting up…" : "Build website"}
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {SITE_EXAMPLES.map((x) => (
                  <button
                    key={x.label}
                    type="button"
                    onClick={() => {
                      setSite(x.prompt);
                      siteBox.current?.focus();
                    }}
                    title="Fills in the box: edit it, then press Build website"
                    className="rounded-full border border-s-line px-2.5 py-1 text-[12.5px] text-s-ink-2 hover:border-s-line-strong hover:text-s-ink"
                  >
                    {x.label}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-s-ink-3">
                The agent writes the site&apos;s files, starts it on the project&apos;s private computer (this uses workspace minutes), checks it in a real browser at desktop and phone sizes, and
                fixes what it finds. You see the live preview and can ask for changes; every change can be undone.
              </p>
            </form>
          </section>

          {recent.length > 0 && (
            <section className="mt-9" aria-labelledby="continue-h">
              <h2 id="continue-h" className="text-[13px] font-medium uppercase tracking-[0.08em] text-s-ink-3">
                Continue where you left off
              </h2>
              <ul className="mt-3 grid gap-3 sm:grid-cols-3">
                {recent.map((p) => {
                  const Icon = ICON[p.template as TemplateId] ?? FolderGit2;
                  return (
                    <li key={p.id}>
                      <Link href={`/code/${p.id}`} className={cn(card, "h-full")}>
                        <Icon className="h-4 w-4 text-s-ink-3" />
                        <span className="mt-2 line-clamp-2 text-[14.5px] font-medium text-s-ink">{p.name}</span>
                        <span className="mt-auto pt-2 text-[12px] text-s-ink-3">
                          {p.sourceRepo ? `From ${p.sourceRepo} · ` : ""}Edited {edited(p.updatedAt)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section ref={newRef} className="mt-9 scroll-mt-4" aria-labelledby="start-h">
            <h2 id="start-h" className="text-[13px] font-medium uppercase tracking-[0.08em] text-s-ink-3">
              Start something new
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <button type="button" onClick={() => void tryExample()} disabled={!!busy || full} className={card}>
                <FlaskConical className="h-4 w-4 text-s-ink-2" />
                <span className="mt-2 text-[14.5px] font-medium text-s-ink">{busy === "example" ? "Setting up…" : "Try an example"}</span>
                <span className="mt-1 text-[12.5px] leading-snug text-s-ink-3">A small calculator whose tests fail. Watch the agent find the bug, fix it and prove it with the tests.</span>
              </button>
              <button
                type="button"
                onClick={() => void loadRepos()}
                aria-expanded={open === "github"}
                disabled={!!busy}
                className={cn(card, open === "github" && "border-s-line-strong bg-s-hover/40")}
              >
                <FolderGit2 className="h-4 w-4 text-s-ink-2" />
                <span className="mt-2 text-[14.5px] font-medium text-s-ink">Import from GitHub</span>
                <span className="mt-1 text-[12.5px] leading-snug text-s-ink-3">Copy one of your repositories into a project. Your repository isn&apos;t changed.</span>
              </button>
              <button
                type="button"
                onClick={() => setOpen(open === "new" ? null : "new")}
                aria-expanded={open === "new"}
                disabled={!!busy}
                className={cn(card, open === "new" && "border-s-line-strong bg-s-hover/40")}
              >
                <Plus className="h-4 w-4 text-s-ink-2" />
                <span className="mt-2 flex items-center gap-1 text-[14.5px] font-medium text-s-ink">
                  New project <ChevronDown className={cn("h-3.5 w-3.5 transition", open === "new" && "rotate-180")} aria-hidden />
                </span>
                <span className="mt-1 text-[12.5px] leading-snug text-s-ink-3">Start from a website, Node.js, Python or blank template.</span>
              </button>
            </div>
            {full && (
              <p className="mt-2 text-[12.5px] text-s-ink-3">
                You have {data!.maxProjects} projects, the most your plan keeps. Delete one to make room, or{" "}
                <Link href="/pricing" className="underline">
                  upgrade
                </Link>
                .
              </p>
            )}

            {open === "github" && (
              <div className="glass-strong mt-3 rounded-2xl p-4">
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
                <p className="mt-2 text-[12px] text-s-ink-3">Text files up to 100 KB from the default branch are copied. To send changes back, use Push to GitHub, which always makes a new branch.</p>
              </div>
            )}

            {open === "new" && (
              <div className="glass-strong mt-3 rounded-2xl p-4">
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
              </div>
            )}
          </section>

          <section className="mt-9" aria-labelledby="all-h">
            <h2 id="all-h" className="text-[13px] font-medium uppercase tracking-[0.08em] text-s-ink-3">
              All projects
            </h2>
            {!data && !error && <div className="s-skeleton mt-3 h-14 w-full" />}
            {data && data.projects.length === 0 && <p className="mt-3 text-[14px] text-s-ink-3">No projects yet. Try the example to see how it works.</p>}
            {data && data.projects.length > 0 && (
              <ul className="mt-3 divide-y divide-s-line rounded-2xl border border-s-line">
                {data.projects.map((p) => {
                  const Icon = ICON[p.template as TemplateId] ?? FolderGit2;
                  return (
                    <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                      <Icon className="h-4 w-4 shrink-0 text-s-ink-3" />
                      <Link href={`/code/${p.id}`} className="min-w-0 flex-1">
                        <div className="truncate text-[14.5px] font-medium">{p.name}</div>
                        <div className="truncate text-[12.5px] text-s-ink-3">
                          {p.sourceRepo ? `From ${p.sourceRepo} · ` : ""}Edited {edited(p.updatedAt)}
                        </div>
                      </Link>
                      <button
                        type="button"
                        onClick={() => void remove(p)}
                        aria-label={`Delete ${p.name}`}
                        title="Delete project"
                        className="grid h-9 w-9 place-items-center rounded-xl text-s-ink-3 hover:bg-s-hover hover:text-s-danger"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                      <Link href={`/code/${p.id}`} aria-label={`Open ${p.name}`} title="Open" className="grid h-9 w-9 place-items-center rounded-xl text-s-ink-2 hover:bg-s-hover">
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <p className="mt-8 flex items-start gap-2 text-[12.5px] leading-relaxed text-s-ink-3">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Your files are saved to your account. Code runs on a private computer for each project, which can only download packages from npm and PyPI. {data && minutesLine(data.allowance)}
            </span>
          </p>
        </div>
      </div>
    </>
  );
}
