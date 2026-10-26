"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FileArchive, FileCode2, GitPullRequest, Loader2, Plus, ScanSearch, Trash2, X } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { api, CodeApiError, post } from "@/components/code/api";
import type { ProjectSummary } from "@/lib/code/projects";
import { ago } from "@/lib/home";
import type { ReviewView } from "@/lib/review/server";
import { cn } from "@/lib/utils";
import { SeverityCounts, StatusPill } from "./bits";

type Kind = "paste" | "diff" | "zip" | "github" | "project";
const TABS: { id: Kind; label: string; icon: typeof FileCode2 }[] = [
  { id: "paste", label: "Paste code", icon: FileCode2 },
  { id: "diff", label: "Paste a diff", icon: GitPullRequest },
  { id: "github", label: "GitHub", icon: GitPullRequest },
  { id: "zip", label: "Upload ZIP", icon: FileArchive },
  { id: "project", label: "Code project", icon: FileCode2 },
];

const ZIP_LIMIT = 3_000_000;

/**
 * Code Review's start page: choose what to review (pasted code, a diff, a GitHub repository or pull
 * request, a ZIP, or one of your Code projects), optionally say what to focus on, and see past reviews.
 */
export function ReviewHome() {
  const { user } = useApp();
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("paste");
  const [files, setFiles] = useState([{ path: "", content: "" }]);
  const [diff, setDiff] = useState("");
  const [url, setUrl] = useState("");
  const [zip, setZip] = useState<{ name: string; data: string; size: number } | null>(null);
  const [projectId, setProjectId] = useState("");
  const [focus, setFocus] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [reviews, setReviews] = useState<ReviewView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CodeApiError | null>(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    api<{ reviews: ReviewView[] }>("/api/review")
      .then((r) => alive && setReviews(r.reviews))
      .catch(() => alive && setReviews([]));
    api<{ projects: ProjectSummary[] }>("/api/code/projects")
      .then((r) => alive && setProjects(r.projects))
      .catch(() => alive && setProjects([]));
    return () => {
      alive = false;
    };
  }, [user]);

  const ready = kind === "paste" ? files.some((f) => f.content.trim()) : kind === "diff" ? diff.trim().length > 10 : kind === "github" ? url.trim().length > 2 : kind === "zip" ? !!zip : !!projectId;

  const pickZip = (file: File | undefined) => {
    setError(null);
    if (!file) return setZip(null);
    if (file.size > ZIP_LIMIT) return setError(new CodeApiError("That ZIP is over 3 MB. Leave out node_modules and build folders, or review the GitHub repository instead.", 400, null, null));
    const reader = new FileReader();
    reader.onload = () => setZip({ name: file.name, size: file.size, data: String(reader.result).split(",")[1] ?? "" });
    reader.onerror = () => setError(new CodeApiError("Couldn't read that file.", 0, null, null));
    reader.readAsDataURL(file);
  };

  const start = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const source =
      kind === "paste"
        ? { kind, files: files.filter((f) => f.content.trim()).map((f, i) => ({ path: f.path.trim() || `snippet-${i + 1}.txt`, content: f.content })) }
        : kind === "diff"
          ? { kind, diff }
          : kind === "github"
            ? { kind, url: url.trim() }
            : kind === "zip"
              ? { kind, name: zip!.name, data: zip!.data }
              : { kind, projectId };
    try {
      const r = await post<{ review: ReviewView }>("/api/review", { source, focus: focus.trim() || null });
      router.push(`/review/${r.review.id}`);
    } catch (e) {
      setError(e instanceof CodeApiError ? e : new CodeApiError((e as Error).message, 0, null, null));
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this review and its stored copy of the code?")) return;
    try {
      await api(`/api/review/${id}`, { method: "DELETE" });
      setReviews((rs) => rs?.filter((r) => r.id !== id) ?? null);
    } catch (e) {
      setError(e instanceof CodeApiError ? e : null);
    }
  };

  const header = (
    <StudioHeader>
      <h1 className="text-[14px] font-medium text-s-ink-2">Code Review</h1>
    </StudioHeader>
  );

  if (!user) {
    return (
      <>
        {header}
        <div className="mx-auto max-w-[640px] px-4 py-16 text-center">
          <h2 className="font-serif text-[clamp(28px,4.5vw,40px)]">Find bugs before they ship</h2>
          <p className="mt-3 text-[15px] text-s-ink-2">
            Review code, a diff or a pull request for bugs, edge cases, security problems and missing tests. Every finding points to the line it&apos;s about.
          </p>
          <Link href="/login?next=/review" className="mt-6 inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink">
            Sign in to start
          </Link>
        </div>
      </>
    );
  }

  const field = "block w-full rounded-xl border border-s-line bg-transparent p-3 text-[14px] outline-none placeholder:text-s-ink-3 focus:border-s-line-strong";

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-24 pt-2 sm:px-8">
          <h2 className="font-serif text-[clamp(30px,5vw,40px)] leading-tight">Code Review</h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-s-ink-2">
            Finds bugs, logic errors, unhandled edge cases, security problems, missing tests and performance issues. Each finding quotes the line it&apos;s about — Orbis checks that the line exists —
            and says how sure it is. Nothing is run and nothing is changed until you ask.
          </p>

          <section aria-label="Start a review" className="mt-6 s-card rounded-2xl p-4">
            <div role="tablist" aria-label="What to review" className="flex flex-wrap gap-1.5">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={kind === t.id}
                  onClick={() => setKind(t.id)}
                  className={cn(
                    "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] transition",
                    kind === t.id ? "border-s-line-strong bg-s-hover text-s-ink" : "border-s-line text-s-ink-2 hover:text-s-ink",
                  )}
                >
                  <t.icon className="h-3.5 w-3.5" aria-hidden />
                  {t.label}
                </button>
              ))}
            </div>

            <div className="mt-4" role="tabpanel">
              {kind === "paste" && (
                <div className="space-y-3">
                  {files.map((f, i) => (
                    <div key={i} className="rounded-xl border border-s-line p-2.5">
                      <div className="flex items-center gap-2">
                        <label className="sr-only" htmlFor={`rv-path-${i}`}>
                          File name
                        </label>
                        <input
                          id={`rv-path-${i}`}
                          value={f.path}
                          onChange={(e) => setFiles((fs) => fs.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
                          placeholder="File name, e.g. src/cart.ts (helps the review)"
                          maxLength={300}
                          className="h-9 min-w-0 flex-1 rounded-lg border border-s-line bg-transparent px-2.5 font-mono text-[12.5px] outline-none focus:border-s-line-strong"
                        />
                        {files.length > 1 && (
                          <button
                            type="button"
                            aria-label={`Remove file ${i + 1}`}
                            onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}
                            className="grid h-9 w-9 place-items-center rounded-lg text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                      <label className="sr-only" htmlFor={`rv-code-${i}`}>
                        Code
                      </label>
                      <textarea
                        id={`rv-code-${i}`}
                        value={f.content}
                        onChange={(e) => setFiles((fs) => fs.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
                        rows={10}
                        maxLength={120_000}
                        placeholder="Paste the code to review…"
                        spellCheck={false}
                        className={cn(field, "mt-2 resize-y font-mono text-[12.5px]")}
                      />
                    </div>
                  ))}
                  {files.length < 10 && (
                    <button
                      type="button"
                      onClick={() => setFiles((fs) => [...fs, { path: "", content: "" }])}
                      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-s-line px-3 text-[13px] text-s-ink-2 hover:text-s-ink"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden /> Add another file
                    </button>
                  )}
                </div>
              )}
              {kind === "diff" && (
                <>
                  <label htmlFor="rv-diff" className="block text-[13px] font-medium">
                    Unified diff
                  </label>
                  <p className="mt-0.5 text-[12.5px] text-s-ink-3">
                    From git diff, a .patch file, or a pull request&apos;s “.diff” view. Only the changed hunks are seen, so a GitHub pull request link gives the reviewer more context.
                  </p>
                  <textarea
                    id="rv-diff"
                    value={diff}
                    onChange={(e) => setDiff(e.target.value)}
                    rows={12}
                    spellCheck={false}
                    placeholder={"diff --git a/src/cart.js b/src/cart.js\n--- a/src/cart.js\n+++ b/src/cart.js\n@@ …"}
                    className={cn(field, "mt-2 resize-y font-mono text-[12.5px]")}
                  />
                </>
              )}
              {kind === "github" && (
                <>
                  <label htmlFor="rv-url" className="block text-[13px] font-medium">
                    Repository or pull request
                  </label>
                  <input
                    id="rv-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://github.com/owner/repo/pull/123  or  owner/repo"
                    className={cn(field, "mt-1.5 font-mono text-[13px]")}
                  />
                  <p className="mt-1.5 text-[12.5px] text-s-ink-3">
                    Public repositories and pull requests work without connecting anything. Private repositories use the Orbis GitHub App you installed (read-only); private pull requests also need the
                    app&apos;s “Pull requests: read” permission. Orbis never writes to GitHub from a review.
                  </p>
                </>
              )}
              {kind === "zip" && (
                <>
                  <label htmlFor="rv-zip" className="block text-[13px] font-medium">
                    ZIP of your project (up to 3 MB)
                  </label>
                  <input
                    id="rv-zip"
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(e) => pickZip(e.target.files?.[0])}
                    className="mt-1.5 block text-[13px] file:mr-3 file:h-9 file:rounded-full file:border file:border-s-line file:bg-transparent file:px-3 file:text-s-ink"
                  />
                  {zip && (
                    <p className="mt-1.5 text-[12.5px] text-s-ink-2">
                      {zip.name} · {(zip.size / 1024).toFixed(0)} KB
                    </p>
                  )}
                  <p className="mt-1.5 text-[12.5px] text-s-ink-3">Text files only; dependency and build folders are skipped. The upload is read, never run.</p>
                </>
              )}
              {kind === "project" && (
                <>
                  <label htmlFor="rv-project" className="block text-[13px] font-medium">
                    Code project
                  </label>
                  {projects === null ? (
                    <div className="s-skeleton mt-1.5 h-10 rounded-xl" role="status" aria-label="Loading projects" />
                  ) : projects.length ? (
                    <select
                      id="rv-project"
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      className="mt-1.5 h-10 w-full max-w-md rounded-xl border border-s-line bg-transparent px-2.5 text-[14px]"
                    >
                      <option value="">Choose a project…</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="mt-1.5 text-[13px] text-s-ink-3">
                      You have no Code projects yet.{" "}
                      <Link href="/code" className="underline">
                        Create one in Code
                      </Link>
                      .
                    </p>
                  )}
                </>
              )}
            </div>

            <label htmlFor="rv-focus" className="mt-4 block text-[13px] font-medium">
              Anything to focus on? <span className="font-normal text-s-ink-3">(optional)</span>
            </label>
            <input
              id="rv-focus"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              maxLength={2000}
              placeholder="e.g. the checkout total sometimes comes out wrong"
              className={cn(field, "mt-1.5")}
            />

            {error && (
              <p role="alert" className="mt-3 rounded-xl border border-s-danger/40 px-3 py-2 text-[13px] text-s-danger">
                {error.message}{" "}
                {error.upgrade && (
                  <Link href="/pricing" className="underline">
                    See plans
                  </Link>
                )}
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void start()}
                disabled={!ready || busy}
                className="inline-flex h-10 items-center gap-2 rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ScanSearch className="h-4 w-4" aria-hidden />} {busy ? "Loading the code…" : "Start review"}
              </button>
              <span className="text-[12px] text-s-ink-3">Each part of the review is charged like a message of its size; larger projects take a few parts (up to about 180 KB of code).</span>
            </div>
          </section>

          <section aria-labelledby="rv-history" className="mt-8">
            <h3 id="rv-history" className="text-[15px] font-medium text-s-ink">
              Your reviews
            </h3>
            {reviews === null ? (
              <div className="s-skeleton mt-3 h-14 rounded-2xl" role="status" aria-label="Loading reviews" />
            ) : reviews.length === 0 ? (
              <p className="mt-2 text-[13.5px] text-s-ink-3">None yet. Each review is kept here with its findings, so you can come back to it.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {reviews.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 s-card rounded-2xl px-3 py-2.5">
                    <Link href={`/review/${r.id}`} className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] text-s-ink">{r.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-s-ink-3">
                        <StatusPill status={r.status} />
                        <span>{r.source.label}</span>
                        <time dateTime={r.created_at} suppressHydrationWarning>
                          {ago(r.created_at)}
                        </time>
                        <SeverityCounts counts={r.counts} />
                      </span>
                    </Link>
                    <button
                      type="button"
                      onClick={() => void remove(r.id)}
                      aria-label={`Delete review ${r.title}`}
                      title="Delete"
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-s-ink-3 hover:bg-s-hover hover:text-s-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
