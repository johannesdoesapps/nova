import { estimateTokens } from "./cost";
import type { RouterMode } from "./platform";
import type { Capability, ModelWithStatus } from "./types";

export type TaskKind = "summary" | "analysis" | "coding" | "writing" | "long-document" | "general";

export interface TaskSignal {
  kind: TaskKind;
  reasons: string[];
  estimatedTokens: number;
}

const CODE_HINTS =
  /```|\b(function|class|const|let|def|import|export|SELECT|INSERT|stack ?trace|TypeError|exception|compile|bug|debug|refactor|regex|typescript|javascript|python|rust|golang|sql|api endpoint)\b/i;
const SUMMARY_HINTS = /\b(summari[sz]e|summary|tl;?dr|shorten|key points|bullet points|recap|condense)\b/i;
const WRITING_HINTS =
  /\b(write|draft|rewrite|redraft|proofread|edit (?:this|my)|essay|article|blog post|cover letter|email|newsletter|story|poem|tone|copywriting|press release)\b/i;
const ANALYSIS_HINTS =
  /\b(analy[sz]e|compare|trade-?offs?|pros and cons|evaluate|strategy|why|reason|implications|assess|plan|decide|critique)\b/i;

/** Transparent, rule-based task classification. No hidden scoring. */
export function classifyTask(prompt: string, mode?: string): TaskSignal {
  const estimatedTokens = estimateTokens(prompt);
  const reasons: string[] = [];
  if (estimatedTokens > 24_000) {
    reasons.push(`Prompt is long (~${estimatedTokens.toLocaleString()} tokens), so context window matters most.`);
    return { kind: "long-document", reasons, estimatedTokens };
  }
  if (mode === "coding" || CODE_HINTS.test(prompt)) {
    reasons.push(mode === "coding" ? "Coding mode is selected." : "The prompt contains code or programming terms.");
    return { kind: "coding", reasons, estimatedTokens };
  }
  if (SUMMARY_HINTS.test(prompt)) {
    reasons.push("The prompt asks for a summary, which a fast, inexpensive model usually handles well.");
    return { kind: "summary", reasons, estimatedTokens };
  }
  if (WRITING_HINTS.test(prompt)) {
    reasons.push("The prompt asks for writing or editing, which suits a model tagged for writing.");
    return { kind: "writing", reasons, estimatedTokens };
  }
  if (mode === "analyst" || mode === "critic" || ANALYSIS_HINTS.test(prompt)) {
    reasons.push("The prompt asks for analysis or comparison, which benefits from a reasoning model.");
    return { kind: "analysis", reasons, estimatedTokens };
  }
  reasons.push("General question — defaulting to a balanced choice.");
  return { kind: "general", reasons, estimatedTokens };
}

export interface Recommendation {
  model: ModelWithStatus | null;
  task: TaskSignal;
  explanation: string[];
  disclaimer: string;
}

function knownCost(m: ModelWithStatus): number {
  if (m.inputPrice === null || m.outputPrice === null) return Number.POSITIVE_INFINITY;
  return m.inputPrice + m.outputPrice;
}

/**
 * Pick a model using explicit rules. Recommendations are estimates, not guarantees.
 */
export function recommendModel(
  models: ModelWithStatus[],
  prompt: string,
  opts: { mode?: string; costSensitive?: boolean; needs?: Capability[] } = {},
): Recommendation {
  const task = classifyTask(prompt, opts.mode);
  const disclaimer =
    "Recommendations follow simple, published rules (task type, capabilities, context window and known price). They are estimates, not quality guarantees.";
  const needs = opts.needs ?? [];
  const pool = models.filter((m) => m.available && needs.every((c) => m.capabilities.includes(c)));
  if (pool.length === 0) {
    return {
      model: null,
      task,
      explanation: [needs.length ? `No configured model supports ${needs.join(", ")}.` : "No models are currently available. Add an API key in .env.local."],
      disclaimer,
    };
  }

  const explanation = [...task.reasons];
  const has = (m: ModelWithStatus, c: string) => m.capabilities.includes(c as never);
  const score = (m: ModelWithStatus): number => {
    let s = 0;
    switch (task.kind) {
      case "summary":
        if (has(m, "fast")) s += 3;
        if (has(m, "low-cost")) s += 3;
        break;
      case "analysis":
        if (has(m, "reasoning")) s += 5;
        break;
      case "coding":
        if (has(m, "coding")) s += 4;
        if (has(m, "reasoning")) s += 2;
        break;
      case "writing":
        if (has(m, "writing")) s += 4;
        if (has(m, "low-cost")) s += 1;
        break;
      case "long-document": {
        const needed = task.estimatedTokens * 1.3;
        if (m.contextWindow && m.contextWindow >= needed) s += 6;
        else if (m.contextWindow === null) s += 0;
        else s -= 10;
        if (has(m, "long-context")) s += 2;
        break;
      }
      default:
        if (has(m, "chat")) s += 2;
        if (has(m, "fast")) s += 1;
    }
    if (opts.costSensitive) {
      if (has(m, "low-cost")) s += 4;
      if (Number.isFinite(knownCost(m))) s += 1;
    }
    return s;
  };

  const ranked = [...pool].sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return knownCost(a) - knownCost(b);
  });
  const model = ranked[0]!;
  if (opts.costSensitive) explanation.push("Cost-sensitive: models tagged low-cost and with known prices are preferred.");
  explanation.push(`${model.displayName} best matches these rules among ${pool.length} available model(s).`);
  if (model.inputPrice === null) explanation.push("No verified price is configured for this model, so cost is shown as n/a.");
  return { model, task, explanation, disclaimer };
}

export interface AutoRoute {
  model: ModelWithStatus;
  task: TaskKind;
  /** Short, user-facing reason for the choice. */
  reason: string;
}

const TASK_LABEL: Record<TaskKind, string> = {
  summary: "summary",
  analysis: "analysis",
  coding: "coding",
  writing: "writing",
  "long-document": "long document",
  general: "everyday question",
};

/**
 * Auto mode: route one message with the published rules above. Everyday and
 * summary tasks prefer low-cost models; analysis and coding prefer capable
 * ones. When the user's allowance is nearly used up, low-cost models win.
 * Demo models are only used when nothing real is configured.
 */
/**
 * The models a Smart Router mode chooses from. Each mode narrows the pool when
 * it can; near the usage limit only low-cost models are considered. Shared by
 * the router and the model menu, so the menu names exactly these models.
 */
export function routerPool(models: ModelWithStatus[], routerMode: RouterMode = "balanced", preferLowCost = false): ModelWithStatus[] {
  const real = models.filter((m) => m.provider !== "demo");
  let pool = real.some((m) => m.available) ? real : models;
  const narrow = (pred: (m: ModelWithStatus) => boolean) => {
    const sub = pool.filter((m) => m.available && pred(m));
    if (sub.length) pool = sub;
  };
  const has = (c: Capability) => (m: ModelWithStatus) => m.capabilities.includes(c);
  if (routerMode === "quick") narrow((m) => has("fast")(m) || has("low-cost")(m));
  if (routerMode === "deep" || routerMode === "research") narrow(has("reasoning"));
  if (routerMode === "coding") narrow(has("coding"));
  if (preferLowCost) narrow(has("low-cost"));
  return pool;
}

export function autoRoute(
  models: ModelWithStatus[],
  prompt: string,
  opts: { mode?: string; needs?: Capability[]; preferLowCost?: boolean; routerMode?: RouterMode } = {},
): AutoRoute | null {
  const routerMode = opts.routerMode ?? "balanced";
  // Each mode narrows the pool, then the usual rules choose within it.
  const pool = routerPool(models, routerMode, opts.preferLowCost);
  const task = routerMode === "coding" ? "coding" : classifyTask(prompt, opts.mode).kind;
  const costSensitive = opts.preferLowCost || routerMode === "quick" || (routerMode === "balanced" && (task === "general" || task === "summary"));
  const r = recommendModel(pool, prompt, { mode: routerMode === "coding" ? "coding" : opts.mode, costSensitive, needs: opts.needs });
  if (!r.model) return null;
  const why =
    routerMode === "balanced"
      ? `for this ${TASK_LABEL[task]}`
      : routerMode === "quick"
        ? "for a fast reply (Quick mode)"
        : routerMode === "deep"
          ? "for deeper reasoning (Deep mode)"
          : routerMode === "research"
            ? "for research (Research mode)"
            : "for programming (Coding mode)";
  return {
    model: r.model,
    task,
    reason: `Auto chose ${r.model.displayName} ${why}${opts.preferLowCost ? ", saving your allowance" : ""}.`,
  };
}

/** The best available model with a capability, cheapest known price first (used for agent defaults). */
export function pickForCapability(models: ModelWithStatus[], capability: Capability | null): ModelWithStatus | null {
  if (!capability) return null;
  const pool = models.filter((m) => m.available && m.provider !== "demo" && m.capabilities.includes(capability));
  if (!pool.length) return null;
  return [...pool].sort((a, b) => {
    const lc = Number(b.capabilities.includes("low-cost")) - Number(a.capabilities.includes("low-cost"));
    if (capability !== "reasoning" && lc !== 0) return lc;
    return knownCost(a) - knownCost(b);
  })[0]!;
}
