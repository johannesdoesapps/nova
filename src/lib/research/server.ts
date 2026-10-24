import "server-only";
import { getModels, getProvider, withTimeout } from "../ai";
import { estimateTokens } from "../ai/cost";
import { getPlatformSettings } from "../ai/settings";
import type { ModelWithStatus } from "../ai/types";
import type { Authed } from "../code/server";
import { ApiError } from "../http";
import { modelTier } from "../plans";
import { reportError } from "../observability";
import { enforceLimits, planLimits, recordRun } from "../usage";
import { checkReport, collectNotes, DEPTHS, parsePlan, planMessages, researchSystem, writerMessages, type Depth, type QuestionNotes, type ReportCheck, type Source } from "./research";

/**
 * Deep Research runs in steps the page asks for: plan → one step per research question (Claude with its
 * web search) → write the report. Each step is one metered model call, under a short lock so two tabs
 * can't run the same step; a closed tab just pauses it. Web searches count against the plan's monthly
 * web-search allowance like chat's do.
 */

const STEP_LOCK_MS = 290_000;
const SEARCH_TIMEOUT_MS = 240_000;
const MODEL_TIMEOUT_MS = 150_000;
const MAX_FAILURES = 2;

export interface ResearchRow {
  id: string;
  question: string;
  depth: Depth;
  context: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: "planning" | "researching" | "writing" | "done";
  plan: { approach: string; questions: string[] } | null;
  next_question: number;
  notes: QuestionNotes[];
  sources: Source[];
  report: string | null;
  report_check: Omit<ReportCheck, "report"> | null;
  log: { at: string; kind: "info" | "step" | "warning" | "error"; text: string }[];
  model_id: string | null;
  usage: { modelCalls?: number; inputTokens?: number; outputTokens?: number; searches?: number; failures?: number; modelName?: string; searchModelName?: string };
  error: string | null;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export type ResearchView = Omit<ResearchRow, "context" | "locked_until"> & { hasContext: boolean; busy: boolean };

export function toView(r: ResearchRow): ResearchView {
  const { context, locked_until, ...rest } = r;
  return { ...rest, hasContext: !!context, busy: !!locked_until && Date.parse(locked_until) > Date.now() };
}

const now = () => new Date().toISOString();
const entry = (kind: ResearchRow["log"][number]["kind"], text: string) => ({ at: now(), kind, text: text.slice(0, 600) });

/**
 * The Claude models for a run (web search with citations is Claude's for now), within the plan:
 * - "search" — the research questions — uses the fastest, lowest-cost one: those steps read tens of
 *   thousands of tokens of search results, and on Sonnet one question used more than Pro's 5-hour allowance
 *   (measured 24 Oct 2026: 68k input tokens, 264 units);
 * - "write" — the plan and the report, which need judgement and read only the notes — uses the strongest.
 */
export async function researchModel(auth: Authed, role: "search" | "write"): Promise<ModelWithStatus> {
  const tiers = (await planLimits(auth)).tiers;
  const models = (await getModels(await getPlatformSettings())).filter(
    (m) => m.provider === "anthropic" && m.available && !m.locked && tiers.includes(modelTier(m)) && !!getProvider("anthropic").webResearch,
  );
  const strength = (m: ModelWithStatus) => (/opus/.test(m.id) ? 3 : /sonnet/.test(m.id) ? 2 : /haiku/.test(m.id) ? 1 : 0);
  // The writer is Sonnet when the plan has it (Opus costs far more for little gain on a report); the searcher the cheapest.
  const pick = role === "search" ? [...models].sort((a, b) => strength(a) - strength(b))[0] : (models.find((m) => /sonnet/.test(m.id)) ?? [...models].sort((a, b) => strength(b) - strength(a))[0]);
  if (!pick) throw new ApiError("not_configured", "Deep Research uses Claude's web search, and no Claude model your plan includes is available on this site.");
  return pick;
}

export async function createResearch(auth: Authed, input: { question: string; depth: Depth; context: string | null }): Promise<ResearchView> {
  const limits = await planLimits(auth);
  if (limits.webSearchesLeft === 0)
    throw new ApiError("quota_exceeded", "Deep Research searches the web, and your plan has no web searches left this month (Free doesn't include web search). Upgrade or wait until it renews.", {
      scope: "web_search",
    });
  const [writer, searcher] = await Promise.all([researchModel(auth, "write"), researchModel(auth, "search")]);
  const { data, error } = await auth.supabase
    .from("research_runs")
    .insert({
      question: input.question,
      depth: input.depth,
      status: "running",
      phase: "planning",
      context: input.context,
      model_id: writer.id,
      log: [entry("info", `Started: ${DEPTHS[input.depth].label} research. ${searcher.displayName} searches; ${writer.displayName} plans and writes the report.`)],
      usage: { modelName: writer.displayName, searchModelName: searcher.displayName },
    })
    .select("*")
    .single();
  if (error) {
    reportError(error, { where: "research.create" });
    throw new ApiError("internal", "Couldn't save the research.");
  }
  return toView(data as ResearchRow);
}

export async function getResearch(auth: Authed, id: string): Promise<ResearchRow> {
  const { data, error } = await auth.supabase.from("research_runs").select("*").eq("id", id).maybeSingle();
  if (error) throw new ApiError("internal", "Couldn't load the research.");
  if (!data) throw new ApiError("not_found", "Research not found.");
  return data as ResearchRow;
}

export async function listResearch(auth: Authed): Promise<Pick<ResearchView, "id" | "question" | "depth" | "status" | "phase" | "created_at" | "usage">[]> {
  const { data, error } = await auth.supabase.from("research_runs").select("id, question, depth, status, phase, created_at, usage").order("created_at", { ascending: false }).limit(60);
  if (error) throw new ApiError("internal", "Couldn't load your research.");
  return data as never;
}

async function update(auth: Authed, id: string, patch: Partial<ResearchRow>): Promise<ResearchRow> {
  const { data, error } = await auth.supabase
    .from("research_runs")
    .update({ ...patch, updated_at: now() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new ApiError("internal", "Couldn't save the research.");
  return data as ResearchRow;
}

type Usage = ResearchRow["usage"];
const addUsage = (u: Usage, x: { inputTokens: number | null; outputTokens: number | null }, searches = 0): Usage => ({
  ...u,
  modelCalls: (u.modelCalls ?? 0) + 1,
  inputTokens: (u.inputTokens ?? 0) + (x.inputTokens ?? 0),
  outputTokens: (u.outputTokens ?? 0) + (x.outputTokens ?? 0),
  searches: (u.searches ?? 0) + searches,
  failures: 0,
});

/** Run the next step. Returns the research as it stands (unchanged if another step holds the lock). */
export async function stepResearch(req: Request, auth: Authed, id: string): Promise<ResearchRow> {
  const { data: locked, error } = await auth.supabase
    .from("research_runs")
    .update({ locked_until: new Date(Date.now() + STEP_LOCK_MS).toISOString() })
    .eq("id", id)
    .eq("status", "running")
    .or(`locked_until.is.null,locked_until.lt.${now()}`)
    .select("*")
    .maybeSingle();
  if (error) throw new ApiError("internal", "Couldn't start the next step.");
  if (!locked) return getResearch(auth, id);
  const row = locked as ResearchRow;
  try {
    try {
      const model = await researchModel(auth, row.phase === "researching" ? "search" : "write");
      const provider = getProvider(model.provider);
      const maxOut = (await planLimits(auth)).maxOutputTokens;
      if (row.phase === "planning") {
        const messages = planMessages(row.question, row.depth, row.context);
        await enforceLimits(req, auth, 1, [model], { purpose: "deep_research", inputTokens: estimateTokens(messages), maxOutputTokens: 1200 });
        const t = performance.now();
        const r = await provider.generate({ model, messages, maxOutputTokens: Math.min(1200, maxOut), temperature: 0, signal: withTimeout(MODEL_TIMEOUT_MS, req.signal) });
        await recordRun(auth, {
          model,
          prompt: `[research plan] ${row.question}`.slice(0, 400),
          response: r.text,
          latencyMs: performance.now() - t,
          usage: r.usage,
          status: "success",
          purpose: "deep_research",
          category: "research",
          servedModel: r.servedModel ?? null,
        });
        const plan = parsePlan(r.text, row.depth) ?? { approach: "", questions: [row.question.slice(0, 400)] };
        return await update(auth, id, {
          plan,
          phase: "researching",
          usage: addUsage(row.usage, r.usage),
          log: [...row.log, entry("step", `Planned ${plan.questions.length} research question${plan.questions.length === 1 ? "" : "s"}.`)],
          locked_until: null,
        });
      }

      if (row.phase === "researching" && row.plan) {
        const i = row.next_question;
        const question = row.plan.questions[i]!;
        const left = (await planLimits(auth)).webSearchesLeft;
        if (left === 0) {
          // No searches left: write up what was found so far rather than fail.
          return await update(auth, id, {
            phase: "writing",
            log: [...row.log, entry("warning", `Your plan's web searches for this month ran out after ${i} of ${row.plan.questions.length} questions; the report covers those.`)],
            locked_until: null,
          });
        }
        const prompt = `Research question ${i + 1} of ${row.plan.questions.length}: ${question}`;
        await enforceLimits(req, auth, 1, [model], { purpose: "deep_research", inputTokens: 70_000, maxOutputTokens: 3000 });
        const t = performance.now();
        const r = await provider.webResearch!({
          model,
          system: researchSystem(row.question),
          prompt,
          maxSearches: DEPTHS[row.depth].searches,
          maxOutputTokens: Math.min(3000, maxOut),
          signal: withTimeout(SEARCH_TIMEOUT_MS, req.signal),
        });
        await recordRun(auth, {
          model,
          prompt: `[research] ${question}`.slice(0, 400),
          response: r.segments
            .map((s) => s.text)
            .join("")
            .slice(0, 2000),
          latencyMs: performance.now() - t,
          usage: r.usage,
          status: "success",
          purpose: "deep_research",
          category: "research",
          servedModel: r.servedModel ?? null,
          // One entry per search: each is billed (and counted) like chat's web searches.
          tools: Array.from({ length: Math.max(1, r.searches) }, () => "web_search"),
        });
        const { notes, sources } = collectNotes(question, r, row.sources);
        const next = i + 1;
        const cites = (notes.text.match(/\[\d+\]/g) ?? []).length;
        return await update(auth, id, {
          notes: [...row.notes, notes],
          sources,
          next_question: next,
          phase: next >= row.plan.questions.length ? "writing" : "researching",
          usage: addUsage(row.usage, r.usage, r.searches),
          log: [
            ...row.log,
            entry(
              r.stop === "paused" || r.stop === "length" ? "warning" : "step",
              `Question ${next}: ${r.searches} search${r.searches === 1 ? "" : "es"}, ${cites} cited passage${cites === 1 ? "" : "s"} from ${new Set(notes.text.match(/\[(\d+)\]/g) ?? []).size} source${new Set(notes.text.match(/\[(\d+)\]/g) ?? []).size === 1 ? "" : "s"}${notes.seen ? `, ${notes.seen} other page${notes.seen === 1 ? "" : "s"} read` : ""}.${r.stop === "length" ? " The answer hit the length limit." : r.stop === "paused" ? " The search was cut short." : ""}`,
            ),
          ],
          locked_until: null,
        });
      }

      if (row.phase === "writing") {
        if (!row.sources.length && !row.context) {
          return await update(auth, id, {
            status: "failed",
            phase: "done",
            error: "No sources were found, so there's nothing to write a supported report from. Try rephrasing the objective.",
            log: [...row.log, entry("error", "No cited sources were found.")],
            locked_until: null,
          });
        }
        const messages = writerMessages(row.question, row.plan ?? { approach: "", questions: [] }, row.notes, row.sources, row.context);
        const maxOutputTokens = Math.min(6000, maxOut);
        await enforceLimits(req, auth, 1, [model], { purpose: "deep_research", inputTokens: estimateTokens(messages), maxOutputTokens });
        const t = performance.now();
        const r = await provider.generate({ model, messages, maxOutputTokens, temperature: 0.2, signal: withTimeout(MODEL_TIMEOUT_MS, req.signal) });
        await recordRun(auth, {
          model,
          prompt: `[research report] ${row.question}`.slice(0, 400),
          response: r.text,
          latencyMs: performance.now() - t,
          usage: r.usage,
          status: "success",
          purpose: "deep_research",
          category: "research",
          servedModel: r.servedModel ?? null,
        });
        const checked = checkReport(r.text, row.sources.length, !!row.context);
        const { report, ...check } = checked;
        return await update(auth, id, {
          report,
          report_check: check,
          status: "completed",
          phase: "done",
          usage: addUsage(row.usage, r.usage),
          log: [
            ...row.log,
            entry(
              "step",
              `Report written: cites ${check.cited.length} of ${row.sources.length} sources${check.invalidRemoved ? `; ${check.invalidRemoved} citation${check.invalidRemoved === 1 ? "" : "s"} to sources that don't exist removed` : ""}${check.uncitedParagraphs ? `; ${check.uncitedParagraphs} paragraph${check.uncitedParagraphs === 1 ? "" : "s"} of findings without a citation` : ""}.`,
            ),
          ],
          locked_until: null,
        });
      }
      return await update(auth, id, { status: "completed", phase: "done", locked_until: null });
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      const fatal = !!e && ["quota_exceeded", "not_configured", "forbidden", "payment_required", "plan_required"].includes(e.code);
      const failures = (row.usage.failures ?? 0) + 1;
      const message = e?.message ?? "The AI model call failed.";
      if (!(err instanceof ApiError)) reportError(err, { where: "research.step" });
      if (fatal || failures >= MAX_FAILURES)
        return await update(auth, id, { status: "failed", error: message.slice(0, 2000), usage: { ...row.usage, failures }, log: [...row.log, entry("error", message)], locked_until: null });
      return await update(auth, id, { usage: { ...row.usage, failures }, log: [...row.log, entry("warning", `${message} Trying again.`)], locked_until: null });
    }
  } catch (err) {
    await auth.supabase.from("research_runs").update({ locked_until: null }).eq("id", id);
    throw err;
  }
}

export async function cancelResearch(auth: Authed, id: string): Promise<ResearchRow> {
  const row = await getResearch(auth, id);
  if (row.status !== "running") return row;
  return update(auth, id, { status: "cancelled", locked_until: null, log: [...row.log, entry("info", "You stopped the research. What was found so far is kept.")] });
}

/** Continue a failed or stopped run from where it stopped; "write now" skips the remaining questions. */
export async function resumeResearch(auth: Authed, id: string, writeNow: boolean): Promise<ResearchRow> {
  const row = await getResearch(auth, id);
  if (row.status === "completed" || (row.status === "running" && !writeNow)) return row;
  // A step in progress would overwrite the change; the page asks again when it's done.
  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) throw new ApiError("conflict", "A step is in progress. Try again when it finishes.");
  const phase = writeNow && row.notes.length ? "writing" : row.phase === "done" ? "writing" : row.phase;
  return update(auth, id, {
    status: "running",
    phase,
    error: null,
    usage: { ...row.usage, failures: 0 },
    log: [...row.log, entry("info", writeNow ? "Writing the report from what was found so far." : "Continuing.")],
  });
}

export async function deleteResearch(auth: Authed, id: string): Promise<void> {
  const { error } = await auth.supabase.from("research_runs").delete().eq("id", id);
  if (error) throw new ApiError("internal", "Couldn't delete the research.");
}
