import { z } from "zod";
import type { ChatMessage } from "@/lib/ai/types";
import type { ProjectFile } from "../projects";

/**
 * Pair coding: two AI agents on one coding task. The Architect plans, writes
 * the code and revises it; the Reviewer reviews it independently, with
 * evidence, and verifies each fix. Every reply is JSON checked against the
 * schemas here; the server applies file changes, runs tests in the project's
 * computer and keeps the state below on the run. Pure: no server imports.
 */

export const PAIR_PRIORITIES = ["correctness and reliability", "security", "maintainable architecture", "performance", "readability and code quality", "meeting the user's actual requirements"];

export const SEVERITIES = ["critical", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const CATEGORIES = ["correctness", "security", "architecture", "performance", "readability", "requirements", "tests"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Findings that keep a result from passing review: critical and major ones still open. */
export const BLOCKING: Severity[] = ["critical", "major"];

export const MAX_ROUNDS = 5;
export const DEFAULT_ROUNDS = 2;

export interface PairSettings {
  /** Model ids (null: Auto picks a coding model). */
  architect: string | null;
  reviewer: string | null;
  /** Review-and-revise rounds before the user is asked how to go on. */
  maxRounds: number;
  /** Wait for the user to approve the Architect's plan before any code is written. */
  approvePlan: boolean;
  /** Run the plan's test command in the project's computer after each change, when the computer is on. */
  runTests: boolean;
}

export type PairPhase = "plan" | "implement" | "test" | "review" | "revise" | "final" | "done";
export type Agent = "architect" | "reviewer";

export const PHASE_AGENT: Record<Exclude<PairPhase, "test" | "done">, Agent> = { plan: "architect", implement: "architect", review: "reviewer", revise: "architect", final: "architect" };

// ---------------------------------------------------------------- structured outputs

const path = z.string().trim().min(1).max(300);
const text = (max: number) => z.string().trim().max(max);

export const planSchema = z.object({
  summary: text(1_500).min(1),
  architecture: text(3_000).default(""),
  files: z
    .array(z.object({ path, purpose: text(300).default("") }))
    .max(40)
    .default([]),
  tasks: z.array(text(300)).max(20).default([]),
  decisions: z
    .array(z.object({ decision: text(300), why: text(600) }))
    .max(12)
    .default([]),
  testCommand: text(300).nullable().default(null),
  runCommand: text(300).nullable().default(null),
});
export type ArchitectPlan = z.infer<typeof planSchema>;

export const codeSchema = z.object({
  notes: text(3_000).default(""),
  files: z
    .array(z.object({ path, content: z.string().max(200_000) }))
    .max(30)
    .default([]),
  delete: z.array(path).max(30).default([]),
  /** Revisions: one response per finding the Architect was asked to address. */
  responses: z
    .array(z.object({ id: text(12), decision: z.enum(["accept", "reject"]), reason: text(800).min(5) }))
    .max(40)
    .default([]),
});
export type ArchitectCode = z.infer<typeof codeSchema>;

export const reviewSchema = z.object({
  verdict: z.enum(["approve", "changes_requested"]),
  summary: text(2_000).min(1),
  findings: z
    .array(
      z.object({
        severity: z.enum(SEVERITIES),
        category: z.enum(CATEGORIES),
        file: path.nullable().default(null),
        line: z.number().int().positive().nullable().default(null),
        title: text(200).min(3),
        /** Required: the code or output that shows the problem. */
        evidence: text(1_500).min(10),
        suggestion: text(1_500).default(""),
      }),
    )
    .max(15)
    .default([]),
  /** Ids of earlier findings the Reviewer checked in the current code and found fixed. */
  resolved: z.array(text(12)).max(60).default([]),
  /** Ids of earlier findings still not fixed (including rejected ones the Reviewer disputes). */
  stillOpen: z.array(text(12)).max(60).default([]),
  testAssessment: text(1_500).default(""),
});
export type Review = z.infer<typeof reviewSchema>;

export const finalSchema = z.object({
  summary: text(3_000).min(1),
  howItWorks: text(3_000).default(""),
  setup: z.array(text(400)).max(15).default([]),
  runCommand: text(300).nullable().default(null),
  testCommand: text(300).nullable().default(null),
  knownIssues: z.array(text(400)).max(15).default([]),
});
export type ArchitectFinal = z.infer<typeof finalSchema>;

/** The JSON object in a reply (fenced or not), or why there isn't one. */
export function extractJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced ? fenced[1]! : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "The reply had no JSON object." };
  try {
    return { ok: true, value: JSON.parse(body.slice(start, end + 1)) };
  } catch (e) {
    return { ok: false, error: `The reply's JSON couldn't be read (${(e as Error).message.slice(0, 120)}).` };
  }
}

export function parseReply<T>(schema: z.ZodType<T>, raw: string): { ok: true; data: T } | { ok: false; error: string } {
  const j = extractJson(raw);
  if (!j.ok) return j;
  const r = schema.safeParse(j.value);
  if (r.success) return { ok: true, data: r.data };
  const issue = r.error.issues[0]!;
  return { ok: false, error: `The reply didn't match the format: ${issue.path.join(".") || "(top)"} — ${issue.message}.` };
}

// ---------------------------------------------------------------- state

export type FindingStatus = "open" | "fixed" | "rejected";

export interface PairFinding {
  id: string;
  severity: Severity;
  category: Category;
  file: string | null;
  line: number | null;
  title: string;
  evidence: string;
  suggestion: string;
  status: FindingStatus;
  /** The round it was raised in. */
  round: number;
  /** The Architect's answer: accepted (and changed the code) or rejected, with its reason. */
  response?: { decision: "accept" | "reject"; reason: string; round: number };
  /** The round the Reviewer checked it fixed, or accepted the rejection. */
  closedRound?: number;
}

export interface PairTestRun {
  command: string;
  round: number;
  /** null: it didn't run (see skipped). */
  exitCode: number | null;
  passed: boolean | null;
  outputTail: string;
  ranAt: string;
  skipped?: string;
}

export interface PairRound {
  round: number;
  verdict: Review["verdict"];
  summary: string;
  raised: number;
  resolved: number;
  open: number;
  blocking: number;
}

export interface PairState {
  settings: PairSettings;
  phase: PairPhase;
  /** Reviews done so far (round 1 is the first review). */
  round: number;
  plan: ArchitectPlan | null;
  findings: PairFinding[];
  rounds: PairRound[];
  tests: PairTestRun[];
  /** Instructions the user sent while it worked; each is given to the next agent call, then marked used. */
  notes: { at: string; text: string; used: boolean }[];
  final: ArchitectFinal | null;
  /** What the agent working right now has written so far (streamed). */
  live: { agent: Agent; phase: PairPhase; text: string; at: string } | null;
  /** Display names of the models each agent used. */
  models: { architect?: string; reviewer?: string };
  /** Rounds in a row in which nothing blocking was resolved. */
  stalled: number;
  /** Paths each phase of the Architect changed, newest round last. */
  changed: string[][];
  /** Format problems in a row (a reply that wasn't valid JSON); two stop the task. */
  formatFailures: number;
  /** The last activity event read for the user's instructions (they're kept as events, so a step can't overwrite them). */
  noteSeq?: number;
}

export function newPairState(settings: PairSettings): PairState {
  return {
    settings: { ...settings, maxRounds: Math.min(MAX_ROUNDS, Math.max(1, Math.round(settings.maxRounds || DEFAULT_ROUNDS))) },
    phase: "plan",
    round: 0,
    plan: null,
    findings: [],
    rounds: [],
    tests: [],
    notes: [],
    final: null,
    live: null,
    models: {},
    stalled: 0,
    changed: [],
    formatFailures: 0,
  };
}

export const openFindings = (s: Pick<PairState, "findings">) => s.findings.filter((f) => f.status === "open");
export const blockingFindings = (s: Pick<PairState, "findings">) => openFindings(s).filter((f) => BLOCKING.includes(f.severity));
export const lastTest = (s: Pick<PairState, "tests">) => s.tests.filter((t) => !t.skipped).at(-1) ?? null;

/** Whether the work meets the bar: the Reviewer approved, nothing blocking is open, and the latest tests (if they ran) passed. */
export function meetsBar(s: PairState, verdict: Review["verdict"]): boolean {
  const t = lastTest(s);
  return verdict === "approve" && blockingFindings(s).length === 0 && (!t || t.round < s.round || t.passed !== false);
}

/**
 * Apply a review to the state: earlier findings the Reviewer verified fixed are closed; a rejection the
 * Reviewer doesn't dispute (not in stillOpen) is closed as rejected; disputed ones stay open; new
 * findings get ids. Returns the new state and the round's record.
 */
export function applyReview(s: PairState, review: Review): { state: PairState; round: PairRound } {
  const round = s.round + 1;
  const resolved = new Set(review.resolved);
  const stillOpen = new Set(review.stillOpen);
  let closed = 0;
  const findings: PairFinding[] = s.findings.map((f) => {
    if (f.status !== "open") return f;
    if (resolved.has(f.id) && !stillOpen.has(f.id)) {
      closed++;
      return { ...f, status: f.response?.decision === "reject" ? "rejected" : "fixed", closedRound: round };
    }
    // A rejection the Reviewer let stand.
    if (f.response?.decision === "reject" && f.response.round === round - 1 && !stillOpen.has(f.id)) {
      closed++;
      return { ...f, status: "rejected", closedRound: round };
    }
    return f;
  });
  let n = s.findings.length;
  for (const f of review.findings) findings.push({ ...f, id: `F${++n}`, status: "open", round });
  const blockingBefore = blockingFindings(s).map((f) => f.id);
  const next: PairState = { ...s, round, findings };
  const blockingNow = blockingFindings(next);
  // No progress: something blocking was open before, none of it was closed, and blocking work remains.
  const progressed = blockingBefore.some((id) => findings.find((f) => f.id === id)?.status !== "open");
  next.stalled = blockingBefore.length && !progressed && blockingNow.length ? s.stalled + 1 : 0;
  const rec: PairRound = { round, verdict: review.verdict, summary: review.summary, raised: review.findings.length, resolved: closed, open: openFindings(next).length, blocking: blockingNow.length };
  next.rounds = [...s.rounds, rec];
  return { state: next, round: rec };
}

/** Record the Architect's answers to findings (accept or reject, with reasons) from a revision. */
export function applyResponses(s: PairState, responses: ArchitectCode["responses"]): PairState {
  const by = new Map(responses.map((r) => [r.id, r]));
  return { ...s, findings: s.findings.map((f) => (f.status === "open" && by.has(f.id) ? { ...f, response: { decision: by.get(f.id)!.decision, reason: by.get(f.id)!.reason, round: s.round } } : f)) };
}

export type AfterReview = { next: "final" } | { next: "revise" } | { next: "ask"; why: "rounds" | "stalled" };

/** What comes after a review: the final write-up, another revision, or asking the user (rounds used up, or no progress twice). */
export function afterReview(s: PairState, verdict: Review["verdict"]): AfterReview {
  if (meetsBar(s, verdict)) return { next: "final" };
  if (s.stalled >= 2) return { next: "ask", why: "stalled" };
  if (s.round >= s.settings.maxRounds) return { next: "ask", why: "rounds" };
  return { next: "revise" };
}

/** The question asked when the rounds are used up or the agents aren't making progress. */
export function askText(s: PairState, why: "rounds" | "stalled"): { question: string; options: string[] } {
  const open = openFindings(s);
  const blocking = blockingFindings(s);
  const head =
    why === "stalled"
      ? `The last two reviews found the same ${blocking.length === 1 ? "problem" : "problems"} still open after revisions, so the agents stopped instead of trying the same thing again.`
      : `The agents used the ${s.settings.maxRounds} review round${s.settings.maxRounds === 1 ? "" : "s"} you allowed.`;
  return {
    question: `${head} ${open.length ? `${open.length} finding${open.length === 1 ? " is" : "s are"} still open${blocking.length ? ` (${blocking.length} critical or major)` : ""}.` : "No findings are open, but the review didn't pass."} Accept the result as it is, allow one more round, or type instructions for the Architect.`,
    options: ["Accept the result as it is", "One more round"],
  };
}

// ---------------------------------------------------------------- prompts

const JSON_RULE = "Reply with one JSON object only, no text before or after it, matching exactly the format below.";

export function architectSystem(): string {
  return `You are the Architect in a two-agent coding team inside Orbis. You understand the user's request, plan the project's structure, break it into tasks, write the code, and explain your technical decisions. A separate Reviewer, using a different model, reviews your work independently and must back every issue with evidence.
Priorities, in order: ${PAIR_PRIORITIES.map((p, i) => `${i + 1}. ${p}`).join("; ")}.
Rules:
- Write complete, working files. Every file you send replaces the whole file; send only files you create or change.
- Respect the existing project: keep its language, framework and conventions unless the user asks otherwise.
- Paths are relative to the project root (no leading slash, no ".."). Never write secrets, API keys or credentials into files; never create .env files with real values.
- No fake functionality: if something can't work without a backend or a key, say so in the code and in your notes.
- When answering a review, respond to every finding you are given: "accept" (and change the code) or "reject" (with a specific technical reason). Don't accept a finding just to agree, and don't reject a valid one to avoid work.
- Prefer a test command that runs offline and quickly (the project's computer can reach only npm and PyPI).
${JSON_RULE}`;
}

export function reviewerSystem(): string {
  return `You are the Reviewer in a two-agent coding team inside Orbis: a senior engineer reviewing another AI's code independently. Find real bugs, errors, security vulnerabilities, missed requirements and inefficient or unmaintainable code; judge test results; suggest specific fixes.
Priorities, in order: ${PAIR_PRIORITIES.map((p, i) => `${i + 1}. ${p}`).join("; ")}.
Rules:
- Every finding needs evidence: quote the code (with file and line where you can) or the test output that shows it. No evidence, no finding.
- Don't agree by default and don't invent problems. Style preferences are "nit" at most. Severity: critical (broken, insecure, data loss), major (wrong behaviour, missed requirement), minor (edge cases, maintainability), nit (style).
- For each earlier finding you are shown, check the current code: list it in "resolved" only if you can see it's fixed (or the Architect's rejection is convincing), otherwise in "stillOpen".
- "approve" only when nothing critical or major remains and the code meets the request.
${JSON_RULE}`;
}

const FORMATS = {
  plan: `{"summary": "what will be built", "architecture": "structure and main components", "files": [{"path": "src/app.js", "purpose": "…"}], "tasks": ["…"], "decisions": [{"decision": "…", "why": "…"}], "testCommand": "npm test" | null, "runCommand": "npm start" | null}`,
  code: `{"notes": "what you did and why", "files": [{"path": "…", "content": "full file content"}], "delete": ["path"], "responses": [{"id": "F1", "decision": "accept" | "reject", "reason": "…"}]}`,
  review: `{"verdict": "approve" | "changes_requested", "summary": "…", "findings": [{"severity": "critical" | "major" | "minor" | "nit", "category": "${CATEGORIES.join('" | "')}", "file": "path" | null, "line": 12 | null, "title": "…", "evidence": "quoted code or output", "suggestion": "…"}], "resolved": ["F1"], "stillOpen": ["F2"], "testAssessment": "…"}`,
  final: `{"summary": "what was built", "howItWorks": "…", "setup": ["step"], "runCommand": "…" | null, "testCommand": "…" | null, "knownIssues": ["…"]}`,
};

/** The project's files as the agents see them: changed and planned files first, then the rest, within a size budget. */
export function filesBlock(files: ProjectFile[], focus: string[], budget = 90_000, isSecret: (p: string) => boolean = () => false): string {
  const first = new Set(focus);
  const ordered = [...files].sort((a, b) => Number(first.has(b.path)) - Number(first.has(a.path)) || a.path.localeCompare(b.path));
  const out: string[] = [];
  const left: string[] = [];
  let used = 0;
  for (const f of ordered) {
    if (isSecret(f.path)) {
      left.push(`${f.path} (secret file, not shown)`);
      continue;
    }
    const block = `--- ${f.path}\n${f.content}`;
    if (used + block.length > budget) {
      left.push(f.path);
      continue;
    }
    out.push(block);
    used += block.length;
  }
  return `${out.length ? out.join("\n\n") : "(the project has no files yet)"}${left.length ? `\n\nNot shown (over the size budget): ${left.join(", ")}` : ""}`;
}

const findingLine = (f: PairFinding) =>
  `${f.id} [${f.severity}, ${f.category}] ${f.title}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ""}` : ""}\n  Evidence: ${f.evidence}${f.suggestion ? `\n  Suggestion: ${f.suggestion}` : ""}${f.response ? `\n  Architect ${f.response.decision === "accept" ? "accepted" : "rejected"}: ${f.response.reason}` : ""}`;

const testLine = (t: PairTestRun) =>
  t.skipped ? `Tests (${t.command}) didn't run: ${t.skipped}` : `Tests: \`${t.command}\` ${t.passed ? "passed" : `failed (exit code ${t.exitCode})`}.\nOutput (end):\n${t.outputTail || "(no output)"}`;

export interface PairContext {
  request: string;
  projectName: string;
  files: ProjectFile[];
  isSecret?: (p: string) => boolean;
}

/** The messages for the next agent call in this phase. */
export function messagesFor(phase: Exclude<PairPhase, "test" | "done">, s: PairState, c: PairContext): ChatMessage[] {
  const notes = s.notes.filter((n) => !n.used).map((n) => `- ${n.text}`);
  const focus = [...new Set([...(s.plan?.files.map((f) => f.path) ?? []), ...s.changed.flat()])];
  const parts: string[] = [`User's request:\n${c.request}`, `Project: ${c.projectName}`];
  if (notes.length) parts.push(`New instructions from the user (follow them):\n${notes.join("\n")}`);
  if (s.plan && phase !== "plan") parts.push(`The Architect's plan:\n${JSON.stringify(s.plan)}`);
  const t = s.tests.at(-1);
  if (phase === "plan") {
    parts.push(`Project files:\n${filesBlock(c.files, [], 40_000, c.isSecret)}`, `Make a development plan. Format:\n${FORMATS.plan}`);
  } else if (phase === "implement") {
    parts.push(`Project files:\n${filesBlock(c.files, focus, 80_000, c.isSecret)}`, `Write the implementation of the plan. Leave "responses" empty. Format:\n${FORMATS.code}`);
  } else if (phase === "revise") {
    const open = openFindings(s);
    parts.push(
      `Project files (current):\n${filesBlock(c.files, focus, 80_000, c.isSecret)}`,
      `The Reviewer's latest review (round ${s.round}): ${s.rounds.at(-1)?.summary ?? ""}`,
      `Findings to answer (every one needs a response):\n${open.map(findingLine).join("\n") || "(none: improve what the review summary asks for)"}`,
      ...(t ? [testLine(t)] : []),
      `Revise the code. Format:\n${FORMATS.code}`,
    );
  } else if (phase === "review") {
    const earlier = s.findings.filter((f) => f.status === "open");
    parts.push(
      `Project files (current):\n${filesBlock(c.files, focus, 90_000, c.isSecret)}`,
      s.round === 0
        ? "This is the first review of the Architect's implementation."
        : `This is review round ${s.round + 1}. Files the Architect changed in its last revision: ${s.changed.at(-1)?.join(", ") || "(none)"}.`,
      ...(earlier.length ? [`Earlier findings to check against the current code:\n${earlier.map(findingLine).join("\n")}`] : []),
      ...(t ? [testLine(t)] : ["No tests ran for this version."]),
      `Review it. Format:\n${FORMATS.review}`,
    );
  } else {
    const open = openFindings(s);
    parts.push(
      `Project files:\n${filesBlock(c.files, focus, 40_000, c.isSecret)}`,
      `Review rounds: ${s.rounds.map((r) => `round ${r.round}: ${r.verdict}, ${r.open} open`).join("; ") || "none"}.`,
      ...(open.length ? [`Findings still open (list them honestly under knownIssues):\n${open.map(findingLine).join("\n")}`] : []),
      ...(t ? [testLine(t)] : ["No tests ran."]),
      `Write the final summary for the user, with setup and run instructions. Don't claim tests passed unless they did above. Format:\n${FORMATS.final}`,
    );
  }
  return [
    { role: "system", content: PHASE_AGENT[phase] === "architect" ? architectSystem() : reviewerSystem() },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** Paths the Architect may write: project-relative, no traversal, not secret files. Returns the rejected ones with why. */
export function checkPaths(paths: string[], valid: (p: string) => boolean, isSecret: (p: string) => boolean): { ok: string[]; rejected: { path: string; why: string }[] } {
  const ok: string[] = [];
  const rejected: { path: string; why: string }[] = [];
  for (const p of paths) {
    if (!valid(p) || p.split("/").some((s) => s === ".." || s === ".")) rejected.push({ path: p, why: "not a plain path inside the project" });
    else if (isSecret(p)) rejected.push({ path: p, why: "secret files (like .env) can't be written by the agents" });
    else ok.push(p);
  }
  return { ok, rejected };
}
