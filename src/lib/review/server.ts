import "server-only";
import { getProvider, resolveModelChoice, withTimeout } from "../ai";
import { estimateTokens } from "../ai/cost";
import { autoIdFor } from "../ai/router-modes";
import type { ChatMessage, ModelInfo, Usage } from "../ai/types";
import { isAdmin } from "../admin";
import type { Authed } from "../code/server";
import { createProject } from "../code/server";
import { projectLimits, validProjectPath } from "../code/projects";
import { ApiError } from "../http";
import { reportError } from "../observability";
import { runCodeRules } from "../security/code-rules";
import { checkDependencies, parseManifests } from "../security/deps";
import type { FindingDraft } from "../security/types";
import { enforceLimits, planLimits, recordRun } from "../usage";
import { addedLines, countBySeverity, planChunks, parseFindings, rank, reviewMessages, type Confidence, type Finding, type ReviewFile } from "./review";
import { loadSource, type SourceInput } from "./sources";

/**
 * Code Review runs in steps the page asks for, one AI call per step, so no request runs long and a closed
 * tab just pauses it. Each step holds a short lock so two tabs can't run the same step; every AI call goes
 * through the usage ledger (plan limits, budget, recorded cost) like the rest of Orbis.
 */

const STEP_LOCK_MS = 115_000;
const MODEL_TIMEOUT_MS = 100_000;
const MAX_FAILURES_PER_CHUNK = 2;

export interface ReviewRow {
  id: string;
  title: string;
  source: { kind: string; label: string; url?: string; ref?: string; projectId?: string };
  focus: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  files: ReviewFile[];
  diff: string | null;
  chunks: string[][];
  next_chunk: number;
  skipped: string[];
  findings: Finding[];
  log: { at: string; kind: "info" | "step" | "warning" | "error"; text: string }[];
  model_id: string | null;
  usage: { modelCalls?: number; inputTokens?: number; outputTokens?: number; failures?: number; modelName?: string };
  error: string | null;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

/** What the page gets: everything but the stored file contents (fetched on demand for fixes). */
export type ReviewView = Omit<ReviewRow, "files" | "diff" | "locked_until"> & { fileCount: number; busy: boolean; counts: ReturnType<typeof countBySeverity> };

export function toView(r: ReviewRow): ReviewView {
  const { files, diff: _diff, locked_until, ...rest } = r;
  void _diff;
  return { ...rest, fileCount: files.length, busy: !!locked_until && Date.parse(locked_until) > Date.now(), counts: countBySeverity(r.findings) };
}

const now = () => new Date().toISOString();
const entry = (kind: ReviewRow["log"][number]["kind"], text: string) => ({ at: now(), kind, text: text.slice(0, 600) });

/** Deterministic findings from Code Guardian's rules and OSV, in the review's format. */
function ruleFindings(drafts: FindingDraft[]): Finding[] {
  const conf: Record<string, Confidence> = { confirmed: "confirmed", firm: "likely", tentative: "needs_verification" };
  return drafts.flatMap((d, i) => {
    const loc = d.location ?? "";
    const at = loc.lastIndexOf(":");
    const file = at > 0 ? loc.slice(0, at) : loc;
    const line = at > 0 ? Number(loc.slice(at + 1)) || 1 : 1;
    if (!file) return [];
    return [
      {
        id: `r${i + 1}`,
        severity: d.severity === "info" ? "low" : d.severity,
        category: "security",
        confidence: conf[d.confidence] ?? "needs_verification",
        file,
        line,
        title: d.title,
        description: d.description,
        reasoning: d.rationale ?? "",
        evidence: d.evidence
          .map((e) => e.detail)
          .join(" · ")
          .slice(0, 400),
        fix: d.remediation ? { explanation: d.remediation, before: null, after: null } : null,
        source: `rule:${d.ruleId}`,
        status: "open" as const,
      } satisfies Finding,
    ];
  });
}

export async function createReview(req: Request, auth: Authed, input: { source: SourceInput; focus?: string | null }): Promise<ReviewView> {
  const loaded = await loadSource(auth, input.source, withTimeout(45_000, req.signal));
  const added = loaded.diff ? addedLines(loaded.diff) : null;
  const plan = planChunks(loaded.files);
  if (!plan.chunks.length) throw new ApiError("bad_request", "None of these files are source code Orbis can review (or they're all over 40 KB).");
  const log: ReviewRow["log"] = [
    entry("info", `Loaded ${loaded.files.length} file${loaded.files.length === 1 ? "" : "s"} from ${loaded.source.label}.`),
    ...loaded.notes.map((n) => entry("warning", n)),
  ];

  // Fast, deterministic checks first: secret and insecure-code rules, then known vulnerable dependencies.
  const rules = runCodeRules(loaded.files, loaded.source.label);
  const drafts: FindingDraft[] = [...rules.findings];
  log.push(entry("step", `Security rules: ${rules.filesScanned} files checked, ${rules.findings.length} finding${rules.findings.length === 1 ? "" : "s"}.`));
  const manifests = parseManifests(loaded.files);
  if (manifests.packages.length) {
    try {
      const deps = await checkDependencies(manifests.packages, loaded.source.label, { signal: withTimeout(20_000, req.signal) });
      drafts.push(...deps.findings);
      log.push(entry("step", `Dependencies: ${deps.queried} packages checked against OSV.dev, ${deps.vulnerable} with known vulnerabilities.`));
    } catch (err) {
      log.push(entry("warning", `Dependencies weren't checked: OSV.dev couldn't be reached (${(err as Error).message.slice(0, 120)}).`));
    }
  }
  let findings = rank(ruleFindings(drafts));
  if (added) findings = findings.map((f) => ({ ...f, inChange: added.get(f.file)?.has(f.line) ?? false }));
  log.push(
    entry(
      "info",
      `AI review planned in ${plan.chunks.length} part${plan.chunks.length === 1 ? "" : "s"} covering ${plan.reviewed} file${plan.reviewed === 1 ? "" : "s"}${plan.left.length ? `; ${plan.left.length} source file${plan.left.length === 1 ? "" : "s"} left out to stay within the review size` : ""}.`,
    ),
  );

  const { data, error } = await auth.supabase
    .from("code_reviews")
    .insert({
      title: loaded.title.slice(0, 200) || "Code review",
      status: "running",
      next_chunk: 0,
      source: loaded.source,
      focus: input.focus?.trim() || null,
      files: loaded.files,
      diff: loaded.diff,
      chunks: plan.chunks,
      skipped: plan.left.slice(0, 500),
      findings,
      log,
    })
    .select("*")
    .single();
  if (error) {
    reportError(error, { where: "review.create" });
    throw new ApiError("internal", "Couldn't save the review.");
  }
  return toView(data as ReviewRow);
}

export async function getReview(auth: Authed, id: string): Promise<ReviewRow> {
  const { data, error } = await auth.supabase.from("code_reviews").select("*").eq("id", id).maybeSingle();
  if (error) throw new ApiError("internal", "Couldn't load the review.");
  if (!data) throw new ApiError("not_found", "Review not found.");
  return data as ReviewRow;
}

export async function listReviews(auth: Authed): Promise<ReviewView[]> {
  const { data, error } = await auth.supabase
    .from("code_reviews")
    .select("id, title, source, focus, status, chunks, next_chunk, skipped, findings, log, model_id, usage, error, locked_until, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) throw new ApiError("internal", "Couldn't load your reviews.");
  return (data as Omit<ReviewRow, "files" | "diff">[]).map((r) => ({ ...toView({ ...r, files: [], diff: null } as ReviewRow), log: [] }));
}

async function update(auth: Authed, id: string, patch: Partial<ReviewRow>): Promise<ReviewRow> {
  const { data, error } = await auth.supabase
    .from("code_reviews")
    .update({ ...patch, updated_at: now() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new ApiError("internal", "Couldn't save the review.");
  return data as ReviewRow;
}

async function chooseModel(auth: Authed, row: ReviewRow, modelId: string | null): Promise<ModelInfo> {
  const tiers = (await planLimits(auth)).tiers;
  const prompt = `[code review] ${row.title}`;
  const choice = await resolveModelChoice(modelId ?? row.model_id ?? autoIdFor("coding"), { prompt, needs: ["reasoning"], tiers }).catch(() =>
    resolveModelChoice(modelId ?? autoIdFor("coding"), { prompt, tiers }),
  );
  if (choice.model.provider === "demo") throw new ApiError("not_configured", "No AI model is set up on this site, so the AI review can't run. The rule-based findings above are still valid.");
  return choice.model;
}

/** One model call, metered; an invalid reply is retried once with a reminder of the format. */
async function reviewCall(req: Request, auth: Authed, model: ModelInfo, messages: ChatMessage[], title: string): Promise<{ text: string; usage: Usage; calls: number }> {
  const maxOutputTokens = Math.min(4500, (await planLimits(auth)).maxOutputTokens);
  const run = async (msgs: ChatMessage[], first: boolean) => {
    await enforceLimits(req, auth, 1, [model], { purpose: "code_review", inputTokens: estimateTokens(msgs), maxOutputTokens });
    const started = performance.now();
    try {
      const r = await getProvider(model.provider).generate({ model, messages: msgs, maxOutputTokens, temperature: 0, signal: withTimeout(MODEL_TIMEOUT_MS, req.signal) });
      const usage = r.usage.inputTokens === null ? { inputTokens: estimateTokens(msgs), outputTokens: estimateTokens(r.text), estimated: true } : r.usage;
      await recordRun(auth, {
        model,
        prompt: `[code review${first ? "" : " retry"}] ${title}`.slice(0, 400),
        response: r.text,
        latencyMs: performance.now() - started,
        usage,
        status: "success",
        purpose: "code_review",
        category: "coding",
        servedModel: r.servedModel ?? null,
      });
      return { text: r.text, usage };
    } catch (err) {
      await recordRun(auth, {
        model,
        prompt: `[code review] ${title}`.slice(0, 400),
        response: "",
        latencyMs: performance.now() - started,
        usage: { inputTokens: null, outputTokens: null, estimated: true },
        status: "error",
        purpose: "code_review",
        error: (err as Error).message,
      });
      throw err;
    }
  };
  const a = await run(messages, true);
  if (/"findings"\s*:/.test(a.text) && a.text.lastIndexOf("}") > a.text.indexOf("{")) return { ...a, calls: 1 };
  const b = await run(
    [
      ...messages,
      { role: "assistant", content: a.text.slice(0, 4000) },
      { role: "user", content: 'That wasn\'t valid JSON. Reply with JSON only, in the format {"findings":[...]} — an empty list is fine.' },
    ],
    false,
  );
  const sum = (x: number | null, y: number | null) => (x ?? 0) + (y ?? 0);
  return {
    text: b.text,
    usage: { inputTokens: sum(a.usage.inputTokens, b.usage.inputTokens), outputTokens: sum(a.usage.outputTokens, b.usage.outputTokens), estimated: a.usage.estimated || b.usage.estimated },
    calls: 2,
  };
}

/** Run the next part of the review. Returns the review as it stands (unchanged if another step holds the lock). */
export async function stepReview(req: Request, auth: Authed, id: string, modelId: string | null): Promise<ReviewRow> {
  const until = new Date(Date.now() + STEP_LOCK_MS).toISOString();
  const { data: locked, error } = await auth.supabase
    .from("code_reviews")
    .update({ locked_until: until })
    .eq("id", id)
    .eq("status", "running")
    .or(`locked_until.is.null,locked_until.lt.${now()}`)
    .select("*")
    .maybeSingle();
  if (error) throw new ApiError("internal", "Couldn't start the next step.");
  if (!locked) return getReview(auth, id);
  const row = locked as ReviewRow;
  const usage = { ...row.usage };
  try {
    if (row.next_chunk >= row.chunks.length) return await update(auth, id, { status: "completed", locked_until: null, log: [...row.log, entry("info", "Review finished.")] });
    const paths = new Set(row.chunks[row.next_chunk]);
    const files = row.files.filter((f) => paths.has(f.path));
    const messages = reviewMessages({ files, focus: row.focus, diff: row.diff, allPaths: row.files.map((f) => f.path) });
    const label = `Part ${row.next_chunk + 1} of ${row.chunks.length}`;
    let log = row.log;
    try {
      const model = await chooseModel(auth, row, modelId);
      const r = await reviewCall(req, auth, model, messages, row.title);
      const parsed = parseFindings(r.text, files, row.diff ? addedLines(row.diff) : null, `a${row.next_chunk + 1}-`);
      const findings = rank([...row.findings, ...parsed.findings]);
      Object.assign(usage, {
        modelCalls: (usage.modelCalls ?? 0) + r.calls,
        inputTokens: (usage.inputTokens ?? 0) + (r.usage.inputTokens ?? 0),
        outputTokens: (usage.outputTokens ?? 0) + (r.usage.outputTokens ?? 0),
        failures: 0,
        modelName: model.displayName,
      });
      log = [
        ...log,
        parsed.invalid
          ? entry("warning", `${label}: ${model.displayName} didn't return usable results for ${files.length} file${files.length === 1 ? "" : "s"}; this part was skipped.`)
          : entry(
              "step",
              `${label}: ${model.displayName} reviewed ${files.length} file${files.length === 1 ? "" : "s"} — ${parsed.findings.length} finding${parsed.findings.length === 1 ? "" : "s"} kept${parsed.rejected ? `, ${parsed.rejected} discarded (quoted code not found or incomplete)` : ""}.`,
            ),
      ];
      const next = row.next_chunk + 1;
      const done = next >= row.chunks.length;
      return await update(auth, id, {
        findings,
        next_chunk: next,
        model_id: model.id,
        usage,
        log: done ? [...log, entry("info", "Review finished.")] : log,
        status: done ? "completed" : "running",
        locked_until: null,
      });
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      // Limits and missing configuration end the review with a clear reason; other failures get one more try.
      const fatal = !!e && ["quota_exceeded", "not_configured", "forbidden", "payment_required", "plan_required"].includes(e.code);
      const failures = (usage.failures ?? 0) + 1;
      const message = e?.message ?? "The AI model call failed.";
      if (fatal || failures >= MAX_FAILURES_PER_CHUNK) {
        return await update(auth, id, { status: "failed", error: message.slice(0, 2000), usage: { ...usage, failures }, log: [...log, entry("error", `${label}: ${message}`)], locked_until: null });
      }
      return await update(auth, id, { usage: { ...usage, failures }, log: [...log, entry("warning", `${label}: ${message} Trying again.`)], locked_until: null });
    }
  } catch (err) {
    await auth.supabase.from("code_reviews").update({ locked_until: null }).eq("id", id);
    throw err;
  }
}

export async function cancelReview(auth: Authed, id: string): Promise<ReviewRow> {
  const row = await getReview(auth, id);
  if (row.status !== "running") return row;
  return update(auth, id, { status: "cancelled", locked_until: null, log: [...row.log, entry("info", "You stopped the review. Findings so far are kept.")] });
}

/** Continue a failed or stopped review from the part where it stopped. */
export async function retryReview(auth: Authed, id: string): Promise<ReviewRow> {
  const row = await getReview(auth, id);
  if (row.status === "running" || row.status === "completed") return row;
  return update(auth, id, { status: "running", error: null, usage: { ...row.usage, failures: 0 }, log: [...row.log, entry("info", "Continuing the review.")] });
}

export async function setFindingStatus(auth: Authed, id: string, findingId: string, status: Finding["status"]): Promise<ReviewRow> {
  const row = await getReview(auth, id);
  if (!row.findings.some((f) => f.id === findingId)) throw new ApiError("not_found", "Finding not found.");
  return update(auth, id, { findings: row.findings.map((f) => (f.id === findingId ? { ...f, status } : f)) });
}

export async function deleteReview(auth: Authed, id: string): Promise<void> {
  const { error } = await auth.supabase.from("code_reviews").delete().eq("id", id);
  if (error) throw new ApiError("internal", "Couldn't delete the review.");
}

/** A code project to fix a finding in: the project the review came from, or a new one from the reviewed files. */
export async function projectForFix(auth: Authed, id: string): Promise<{ projectId: string; created: boolean }> {
  const row = await getReview(auth, id);
  if (row.source.kind === "project" && row.source.projectId) return { projectId: row.source.projectId, created: false };
  if (row.files.some((f) => f.lineNos))
    throw new ApiError("bad_request", "This review only has diff hunks, not whole files, so there's no project to fix it in. Review the repository or the pull request from GitHub instead.");
  const limits = projectLimits(await isAdmin(auth));
  let total = 0;
  const files = row.files
    .filter((f) => validProjectPath(f.path))
    .filter((f) => (total += f.content.length) <= limits.bytes)
    .slice(0, limits.files)
    .map((f) => ({ path: f.path, content: f.content }));
  if (!files.length) throw new ApiError("bad_request", "None of the reviewed files can go into a code project.");
  const project = await createProject(auth, { name: `Fix: ${row.title}`.slice(0, 80), template: "blank", runCommand: "", sourceRepo: null, files });
  return { projectId: project.id, created: true };
}
