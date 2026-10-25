import type { FindingDraft, Severity } from "./types";
import { SEVERITY_ORDER } from "./types";

/**
 * Pull-request audits: Code Guardian reads the whole repository at the pull request's head (so routes, sign-in
 * checks and dependencies are understood in context) but reports only what touches the files the pull request
 * changes, and says whether each finding sits on a line the pull request adds ("introduced") or in code it only
 * touches ("already there"). Pull-request titles, descriptions and code are untrusted input: they are never used
 * as instructions, and nothing from the repository is executed.
 */

export interface PrFile {
  path: string;
  status: string;
  /** Line numbers (new side) the pull request adds or changes. */
  added: Set<number>;
  /** GitHub omits the patch for very large or binary diffs. */
  patchMissing: boolean;
}

export interface PrInfo {
  repo: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  url: string;
  author: string | null;
  files: PrFile[];
  /** GitHub lists at most 3,000 files; Orbis reads up to 300. */
  filesTruncated: boolean;
}

/** The asset name for a pull request: fetchable as a GitHub ref, and stable across the pull request's commits. */
export const prAsset = (repo: string, n: number) => `github:${repo}/tree/pull/${n}/head`;
export const PR_ASSET_RE = /^github:([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/tree\/pull\/(\d{1,7})\/head$/;

/** New-side line numbers added by a unified diff patch. */
export function addedLines(patch: string | null | undefined): Set<number> {
  const out = new Set<number>();
  if (!patch) return out;
  let line = 0;
  for (const raw of patch.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (!line) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) out.add(line++);
    else if (raw.startsWith("-") && !raw.startsWith("---")) continue;
    else if (raw.startsWith("\\")) continue;
    else line++;
  }
  return out;
}

const MANIFEST = /(^|\/)(package-lock\.json|yarn\.lock|package\.json|requirements[^/]*\.txt|pnpm-lock\.yaml|pyproject\.toml)$/;

function splitLocation(loc: string | null): { path: string | null; line: number | null } {
  if (!loc) return { path: null, line: null };
  // Dependency findings are located as "package-lock.json → name@version".
  loc = loc.split(" → ")[0]!;
  const m = /^(.*):(\d+)$/.exec(loc);
  return m ? { path: m[1]!, line: Number(m[2]) } : { path: loc, line: null };
}

export interface ScopedFinding {
  finding: FindingDraft;
  introduced: boolean;
}

/**
 * Keep the findings this pull request is responsible for or touches: findings in changed files (marked introduced
 * when on an added line), and dependency findings when a manifest or lockfile changed. Removed files don't count.
 */
export function scopeToPr(findings: FindingDraft[], files: PrFile[]): { kept: ScopedFinding[]; dropped: number } {
  const changed = new Map(files.filter((f) => f.status !== "removed").map((f) => [f.path, f]));
  const manifestChanged = files.some((f) => MANIFEST.test(f.path) && f.status !== "removed");
  const kept: ScopedFinding[] = [];
  let dropped = 0;
  for (const f of findings) {
    if (f.ruleId.startsWith("deps.")) {
      if (manifestChanged) kept.push({ finding: f, introduced: false });
      else dropped++;
      continue;
    }
    const { path, line } = splitLocation(f.location);
    const file = path ? changed.get(path) : undefined;
    if (!file) {
      dropped++;
      continue;
    }
    // A new file is introduced in full; otherwise the finding's line must be one the pull request adds.
    const introduced = file.status === "added" || (line != null && file.added.has(line));
    kept.push({ finding: f, introduced });
  }
  return { kept, dropped };
}

/**
 * Which earlier findings this pull-request audit re-checked: only those in files the pull request still changes
 * (and dependency findings when a manifest changed). Findings elsewhere weren't looked at, so they can't be marked
 * "not detected".
 */
export function prCovers(files: PrFile[]): (location: string | null) => boolean {
  const changed = new Set(files.filter((f) => f.status !== "removed").map((f) => f.path));
  const manifestChanged = files.some((f) => MANIFEST.test(f.path) && f.status !== "removed");
  return (location) => {
    const { path } = splitLocation(location);
    if (!path) return false;
    if (MANIFEST.test(path)) return manifestChanged;
    return changed.has(path);
  };
}

/** The pull-request evidence line added to each kept finding. */
export function prEvidence(pr: Pick<PrInfo, "number" | "headSha">, introduced: boolean) {
  return {
    source: `Pull request #${pr.number} @ ${pr.headSha.slice(0, 7)}`,
    detail: introduced ? "On a line this pull request adds (introduced by the change)." : "In a file this pull request changes, on a line it doesn't add (already present before the change).",
  };
}

export interface PrCommentInput {
  pr: Pick<PrInfo, "repo" | "number" | "headSha">;
  findings: { title: string; severity: Severity; location: string | null; classification: string; introduced: boolean }[];
  counts: { introduced: number; existing: number };
  limitations: string[];
  runUrl: string;
}

/**
 * The summary Orbis may post on the pull request (only when the person asks and confirms). Titles, severities and
 * locations only: never evidence, code or secrets, because everyone who can read the pull request sees it.
 */
export function prComment(i: PrCommentInput): string {
  const sorted = [...i.findings].sort((a, b) => Number(b.introduced) - Number(a.introduced) || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]).slice(0, 15);
  const clean = (s: string) => s.replace(/[\r\n|`<>]/g, " ").slice(0, 140);
  const lines = [
    `### Orbis security review — ${i.pr.headSha.slice(0, 7)}`,
    "",
    i.findings.length
      ? `${i.counts.introduced} finding(s) on lines this pull request adds, ${i.counts.existing} in code it touches. Findings come from static analysis of the code at this commit; nothing was run. "Needs verification" means a person should confirm it.`
      : "No security findings in the files this pull request changes. This is not proof that the change is secure: it means Orbis's rules and checks found nothing here.",
  ];
  if (sorted.length) {
    lines.push("", "| Severity | Finding | Where | Status | New? |", "| --- | --- | --- | --- | --- |");
    for (const f of sorted) lines.push(`| ${f.severity} | ${clean(f.title)} | ${f.location ? `\`${clean(f.location)}\`` : "—"} | ${clean(f.classification)} | ${f.introduced ? "yes" : "no"} |`);
    if (i.findings.length > sorted.length) lines.push("", `…and ${i.findings.length - sorted.length} more in Orbis.`);
  }
  if (i.limitations.length) lines.push("", `Not checked: ${i.limitations.map(clean).join("; ")}.`);
  lines.push("", `Details and evidence (for people with access): ${i.runUrl}`);
  return lines.join("\n").slice(0, 60_000);
}

// ---------------------------------------------------------------- GitHub reads

type Fetch = typeof fetch;
const H = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "orbis-code-guardian" };

async function gh<T>(path: string, token: string | null, f: Fetch, signal?: AbortSignal): Promise<T> {
  const res = await f(`https://api.github.com${path}`, { headers: { ...H, ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal });
  if (res.status === 404) throw new Error("Pull request not found. If the repository is private, connect GitHub on the Connectors page and choose this repository there.");
  if (res.status === 401 || res.status === 403) throw new Error(res.headers.get("x-ratelimit-remaining") === "0" ? "GitHub's rate limit was reached. Try again later, or connect GitHub for a higher limit." : "GitHub refused access to this pull request.");
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
  return (await res.json()) as T;
}

/** The pull request and its changed files (up to 300), read with the person's token (or anonymously if public). */
export async function fetchPullRequest(repo: string, number: number, opts: { token: string | null; fetchImpl?: Fetch; signal?: AbortSignal }): Promise<PrInfo> {
  const f = opts.fetchImpl ?? fetch;
  const p = await gh<{ title: string; state: string; draft?: boolean; html_url: string; user?: { login?: string }; head: { sha: string; ref: string }; base: { ref: string }; changed_files?: number }>(`/repos/${repo}/pulls/${number}`, opts.token, f, opts.signal);
  const files: PrFile[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh<{ filename: string; status: string; patch?: string }[]>(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, opts.token, f, opts.signal);
    files.push(...batch.map((x) => ({ path: x.filename, status: x.status, added: addedLines(x.patch), patchMissing: x.patch == null && x.status !== "removed" })));
    if (batch.length < 100) break;
  }
  return {
    repo,
    number,
    title: p.title,
    state: p.state,
    draft: !!p.draft,
    headSha: p.head.sha,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    url: p.html_url,
    author: p.user?.login ?? null,
    files,
    filesTruncated: (p.changed_files ?? files.length) > files.length,
  };
}
