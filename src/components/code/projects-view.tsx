"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Code2, FolderGit2, Globe, Plus, Server, Terminal, Trash2 } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { TEMPLATES, TEMPLATE_IDS, type ProjectSummary, type TemplateId } from "@/lib/code/projects";
import { cn } from "@/lib/utils";
import { api, CodeApiError, post, type Allowance } from "./api";

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

export function CodeProjectsView() {
  const { user } = useApp();
  const router = useRouter();
  const [data, setData] = useState<ListData | null>(null);
  const [error, setError] = useState<CodeApiError | null>(null);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<TemplateId>("website");
  const [busy, setBusy] = useState(false);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoNote, setRepoNote] = useState<string | null>(null);
  const [repo, setRepo] = useState("");

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

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ project: ProjectSummary }>("/api/code/projects", { name: name.trim() || TEMPLATES[template].label, template });
      router.push(`/code/${r.project.id}`);
    } catch (e) {
      setError(e as CodeApiError);
      setBusy(false);
    }
  };

  const loadRepos = async () => {
    setRepoNote(null);
    try {
      const s = await api<{ configured: boolean; linked: boolean; installed: boolean }>("/api/github/status");
      if (!s.configured) return setRepoNote("GitHub isn't set up on this site yet.");
      if (!s.linked || !s.installed) return setRepoNote("Connect GitHub first: open a chat, press + and choose “Add from GitHub”.");
      const r = await api<{ repos: Repo[] }>("/api/github/repos");
      setRepos(r.repos);
      if (!r.repos.length) setRepoNote("Orbis can't see any of your repositories yet.");
    } catch (e) {
      setRepoNote((e as Error).message);
    }
  };

  const importRepo = async () => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ project: ProjectSummary }>("/api/code/import", { repo });
      router.push(`/code/${r.project.id}`);
    } catch (e) {
      setError(e as CodeApiError);
      setBusy(false);
    }
  };

  const remove = async (p: ProjectSummary) => {
    if (!confirm(`Delete “${p.name}” and all its files? This can't be undone.`)) return;
    try {
      await api(`/api/code/projects/${p.id}`, { method: "DELETE" });
      setData((d) => d && { ...d, projects: d.projects.filter((x) => x.id !== p.id) });
    } catch (e) {
      setError(e as CodeApiError);
    }
  };

  if (!user) {
    return (
      <>
        <StudioHeader>
          <span className="text-[14px] font-medium text-s-ink-2">Code</span>
        </StudioHeader>
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div>
            <h1 className="font-serif text-[36px]">Code</h1>
            <p className="mt-2 text-[15px] text-s-ink-2">Write, run and preview projects in your browser, with AI that edits your files.</p>
            <Link href="/login?next=/code" className="mt-5 inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink">
              Sign in to start
            </Link>
          </div>
        </div>
      </>
    );
  }

  const full = data && data.maxProjects !== null && data.projects.length >= data.maxProjects;

  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">Code</span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(34px,5vw,46px)] leading-[1.05] tracking-[-0.01em]">Code</h1>
            <p className="mt-2 max-w-2xl text-[15.5px] text-s-ink-2">
              Projects with an editor, a terminal, a live preview and AI that edits your files. Your files are saved to your account; a workspace computer runs them when you press Run.
            </p>
            {data && <p className="mt-2 text-[13px] text-s-ink-3">{minutesLine(data.allowance)}</p>}
          </div>

          {error && (
            <p className="mt-5 rounded-xl border border-s-line px-3.5 py-2.5 text-[13px] text-s-danger">
              {error.message}{" "}
              {error.upgrade && (
                <Link href="/pricing" className="underline">
                  See plans
                </Link>
              )}
            </p>
          )}

          <section className="glass-strong glass-edge s-in mt-7 rounded-[26px] p-4 sm:p-6" aria-label="New project">
            <h2 className="text-[15px] font-medium">New project</h2>
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              {TEMPLATE_IDS.map((id) => {
                const t = TEMPLATES[id];
                const Icon = ICON[id];
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTemplate(id)}
                    aria-pressed={template === id}
                    className={cn(
                      "rounded-2xl border p-3 text-left transition",
                      template === id ? "border-s-line-strong bg-s-hover" : "border-s-line hover:border-s-line-strong",
                    )}
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
                disabled={busy || !!full}
                className="inline-flex h-10 items-center gap-2 rounded-full bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-40"
              >
                <Plus className="h-4 w-4" /> {busy ? "Creating…" : "Create"}
              </button>
            </form>
            {full && <p className="mt-2 text-[12.5px] text-s-ink-3">You have {data!.maxProjects} projects, the most your plan keeps. Delete one to make room, or <Link href="/pricing" className="underline">upgrade</Link>.</p>}

            <div className="mt-5 border-t border-s-line pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <FolderGit2 className="h-4 w-4 text-s-ink-2" />
                <span className="text-[13.5px]">Start from a GitHub repository</span>
                {!repos && (
                  <button type="button" onClick={() => void loadRepos()} className="rounded-full border border-s-line px-3 py-1 text-[12.5px] text-s-ink-2 hover:border-s-line-strong">
                    Choose repository
                  </button>
                )}
              </div>
              {repos && repos.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <label htmlFor="code-repo" className="sr-only">
                    Repository
                  </label>
                  <select id="code-repo" value={repo} onChange={(e) => setRepo(e.target.value)} className="h-10 min-w-0 flex-1 rounded-full border border-s-line bg-s-bg px-3 text-[13.5px]">
                    <option value="">Choose…</option>
                    {repos.map((r) => (
                      <option key={r.fullName} value={r.fullName}>
                        {r.fullName}
                        {r.private ? " (private)" : ""}
                      </option>
                    ))}
                  </select>
                  <button type="button" disabled={!repo || busy || !!full} onClick={() => void importRepo()} className="h-10 rounded-full border border-s-line px-4 text-[13.5px] hover:border-s-line-strong disabled:opacity-40">
                    {busy ? "Importing…" : "Import"}
                  </button>
                </div>
              )}
              {repoNote && <p className="mt-2 text-[12.5px] text-s-ink-3">{repoNote}</p>}
            </div>
          </section>

          <section className="mt-8" aria-label="Your projects">
            <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Your projects</h2>
            {!data && !error && <div className="s-skeleton mt-3 h-14 w-full" />}
            {data && data.projects.length === 0 && <p className="mt-3 text-[14px] text-s-ink-3">No projects yet. Pick a template above to start.</p>}
            <ul className="mt-3 divide-y divide-s-line rounded-2xl border border-s-line">
              {data?.projects.map((p) => {
                const Icon = ICON[p.template as TemplateId] ?? FolderGit2;
                return (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                    <Icon className="h-4 w-4 shrink-0 text-s-ink-3" />
                    <Link href={`/code/${p.id}`} className="min-w-0 flex-1">
                      <div className="truncate text-[14.5px] font-medium">{p.name}</div>
                      <div className="truncate text-[12.5px] text-s-ink-3">
                        {p.sourceRepo ? `From ${p.sourceRepo} · ` : ""}Edited {new Date(p.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                      </div>
                    </Link>
                    <button type="button" onClick={() => void remove(p)} aria-label={`Delete ${p.name}`} className="grid h-9 w-9 place-items-center rounded-xl text-s-ink-3 hover:bg-s-hover hover:text-s-danger">
                      <Trash2 className="h-4 w-4" />
                    </button>
                    <Link href={`/code/${p.id}`} aria-label={`Open ${p.name}`} className="grid h-9 w-9 place-items-center rounded-xl text-s-ink-2 hover:bg-s-hover">
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
