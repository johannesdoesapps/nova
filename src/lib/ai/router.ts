import { estimateTokens } from "./cost";
import type { RouterMode } from "./platform";
import type { Capability, ModelWithStatus } from "./types";

export type TaskKind = "summary" | "analysis" | "coding" | "writing" | "long-document" | "general";

export interface TaskSignal {
  kind: TaskKind;
  /** Whether the request needs a stronger model; simple requests go to low-cost models. */
  complexity: "simple" | "complex";
  reasons: string[];
  estimatedTokens: number;
}

const CODE_HINTS =
  /```|\b(function|class|const|let|def|import|export|SELECT|INSERT|stack ?trace|TypeError|SyntaxError|exception|compile|compiler|bug|debug|refactor|regex|typescript|javascript|python|rust|golang|java|kotlin|swift|php|ruby|c\+\+|c#|html|css|react|next\.js|node(?:\.js)?|npm|git|docker|kubernetes|bash|shell script|sql|json|yaml|api endpoint|endpoint|variable|array|for loop|algorithm|unit tests?|code|codebase|repository|programming)\b/i;
/** Signals that a request is genuinely hard, so a stronger model is worth its cost. */
const COMPLEX_HINTS =
  /\b(step[- ]by[- ]step|in[- ]depth|thorough(?:ly)?|rigorous|prove|proof|derive|derivation|architecture|system design|design a (?:system|service|database)|trade-?offs?|optimi[sz]e|race condition|deadlock|memory leak|concurrency|security (?:audit|review)|threat model|refactor (?:the|this|my) (?:whole|entire)|multi-?step|research report|literature review|complex|edge cases|strategy|business plan)\b/i;
const SUMMARY_HINTS = /\b(summari[sz]e|summary|tl;?dr|shorten|key points|bullet points|recap|condense)\b/i;
const WRITING_HINTS =
  /\b(write|draft|rewrite|redraft|proofread|edit (?:this|my)|essay|article|blog post|cover letter|email|newsletter|story|poem|tone|copywriting|press release)\b/i;
const ANALYSIS_HINTS =
  /\b(analy[sz]e|compare|trade-?offs?|pros and cons|evaluate|strategy|why|reason|implications|assess|plan|decide|critique)\b/i;

/** How hard a request is, from its length, the amount of code and explicit signals. No model call. */
export function assessComplexity(prompt: string, estimatedTokens = estimateTokens(prompt)): { complexity: "simple" | "complex"; reason: string } {
  const codeLines = (prompt.match(/```[\s\S]*?```/g) ?? []).reduce((n, b) => n + b.split("\n").length - 2, 0);
  if (estimatedTokens > 1500) return { complexity: "complex", reason: "it's a long request" };
  if (codeLines > 40) return { complexity: "complex", reason: "it includes a lot of code" };
  const m = prompt.match(COMPLEX_HINTS);
  if (m) return { complexity: "complex", reason: `it asks for ${m[0].toLowerCase()}` };
  return { complexity: "simple", reason: "a fast, low-cost model can handle it" };
}

/**
 * Transparent, rule-based task classification. No hidden scoring and no extra
 * model call. The Coding chat mode makes code questions coding tasks, but a
 * message that isn't about code is still classified by what it asks.
 */
export function classifyTask(prompt: string, mode?: string): TaskSignal {
  const estimatedTokens = estimateTokens(prompt);
  const reasons: string[] = [];
  const { complexity, reason } = assessComplexity(prompt, estimatedTokens);
  const done = (kind: TaskKind, why: string): TaskSignal => {
    reasons.push(why, complexity === "complex" ? `Needs a stronger model: ${reason}.` : `Simple request: ${reason}.`);
    return { kind, complexity: kind === "long-document" ? "complex" : complexity, reasons, estimatedTokens };
  };
  if (estimatedTokens > 24_000) return done("long-document", `Prompt is long (~${estimatedTokens.toLocaleString()} tokens), so context window matters most.`);
  if (CODE_HINTS.test(prompt)) return done("coding", mode === "coding" ? "Coding mode is on and the message is about code." : "The prompt contains code or programming terms.");
  if (SUMMARY_HINTS.test(prompt)) return done("summary", "The prompt asks for a summary, which a fast, inexpensive model usually handles well.");
  if (WRITING_HINTS.test(prompt)) return done("writing", "The prompt asks for writing or editing, which suits a model tagged for writing.");
  if (mode === "analyst" || mode === "critic" || ANALYSIS_HINTS.test(prompt)) return done("analysis", "The prompt asks for analysis or comparison.");
  return done("general", mode === "coding" ? "Coding mode is on, but this message isn't about code." : "General question.");
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
        if (has(m, "reasoning")) s += task.complexity === "complex" ? 5 : 1;
        break;
      case "coding":
        if (has(m, "coding")) s += 4;
        if (has(m, "reasoning") && task.complexity === "complex") s += 3;
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
    // Simple requests (and cost-sensitive routing) go to low-cost models; complex ones may use stronger models.
    if (opts.costSensitive || task.complexity === "simple") {
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
  complexity: "simple" | "complex";
  /** Short, user-facing reason for the choice. */
  reason: string;
}


/**
 * Expected price of a typical message, in USD per 1M tokens: chats resend their
 * history, so input outweighs output about 3 to 1. Null when either price is
 * unknown (unverified prices are never guessed).
 */
export function blendedPrice(m: Pick<ModelWithStatus, "inputPrice" | "outputPrice">): number | null {
  if (m.inputPrice === null || m.outputPrice === null) return null;
  return (3 * m.inputPrice + m.outputPrice) / 4;
}

/**
 * The cheapest available model that has the required capabilities and enough
 * context, compared on the current registry prices (admin overrides and the
 * model_registry table included). Models with a known price come first; among
 * unpriced ones, models tagged low-cost are preferred. Demo models only when
 * nothing real is configured.
 */
export function cheapestModel(models: ModelWithStatus[], opts: { needs?: Capability[]; minContext?: number; strict?: boolean } = {}): ModelWithStatus | null {
  const available = models.filter((m) => m.available);
  const real = available.filter((m) => m.provider !== "demo");
  // strict: only real models that have every needed capability (no demo stand-ins).
  if (opts.strict && !real.some((m) => (opts.needs ?? []).every((c) => m.capabilities.includes(c)))) return null;
  let pool = (real.length ? real : available).filter((m) => (opts.needs ?? []).every((c) => m.capabilities.includes(c)));
  if (opts.minContext) {
    const fits = pool.filter((m) => m.contextWindow !== null && m.contextWindow >= opts.minContext!);
    if (fits.length) pool = fits;
  }
  if (!pool.length) return null;
  return [...pool].sort((a, b) => {
    const pa = blendedPrice(a);
    const pb = blendedPrice(b);
    if (pa !== null && pb !== null && pa !== pb) return pa - pb;
    if (pa !== null && pb === null) return -1;
    if (pa === null && pb !== null) return 1;
    return Number(b.capabilities.includes("low-cost")) - Number(a.capabilities.includes("low-cost"));
  })[0]!;
}

const priceNote = (m: ModelWithStatus) =>
  m.inputPrice !== null && m.outputPrice !== null ? ` ($${m.inputPrice} in / $${m.outputPrice} out per 1M tokens)` : "";

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
  // Plain Auto is cost-first: the menu names the model it uses, and the reasoning model it escalates to for hard tasks.
  if (routerMode === "balanced" && !preferLowCost) {
    const cheapest = cheapestModel(pool);
    const strong = cheapestModel(pool, { needs: ["reasoning"], strict: true });
    return cheapest ? [cheapest, ...(strong && strong.id !== cheapest.id ? [strong] : [])] : pool;
  }
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
  // Plain Auto (the default for everyone): the least expensive model that can
  // reasonably do the job. Everyday requests get the cheapest model; a request
  // that is genuinely hard (complex coding, analysis or reasoning) gets the
  // cheapest model tagged for reasoning — unless the allowance is running low.
  // Long prompts still need a model whose context window fits them. The pool
  // is already limited to the user's plan.
  if (routerMode === "balanced") {
    const signal = classifyTask(prompt, opts.mode);
    const needs = [...(opts.needs ?? []), ...(opts.mode === "coding" ? (["coding"] as Capability[]) : [])];
    const minContext = signal.kind === "long-document" ? Math.ceil(signal.estimatedTokens * 1.3) : undefined;
    const hard = signal.complexity === "complex" && signal.kind !== "long-document" && signal.kind !== "summary" && !opts.preferLowCost;
    const strong = hard ? cheapestModel(models, { needs: [...needs, "reasoning"], minContext, strict: true }) : null;
    const model = strong ?? cheapestModel(models, { needs, minContext }) ?? (opts.mode === "coding" ? cheapestModel(models, { needs: opts.needs, minContext }) : null);
    if (!model) return null;
    const reason = strong
      ? `Auto chose ${model.displayName}, the lowest-cost reasoning model, because this looks like a harder ${signal.kind === "coding" ? "coding" : "reasoning"} task (${signal.reasons.at(-1)?.replace(/^Needs a stronger model: /, "").replace(/\.$/, "")})${priceNote(model)}.`
      : `Auto chose ${model.displayName}, the lowest-cost available model${opts.mode === "coding" && model.capabilities.includes("coding") ? " for coding" : ""}${minContext ? " with a large enough context window" : ""}${hard === false && signal.complexity === "complex" && opts.preferLowCost ? " (saving your allowance)" : ""}${priceNote(model)}.`;
    return { model, task: signal.kind, complexity: signal.complexity, reason };
  }
  // The Smart Router modes the user picks (Quick, Deep, Research, Coding) narrow
  // the pool, then the usual rules choose within it.
  const pool = routerPool(models, routerMode, opts.preferLowCost);
  const signal = classifyTask(prompt, routerMode === "coding" ? "coding" : opts.mode);
  const task = signal.kind;
  const costSensitive = opts.preferLowCost || routerMode === "quick";
  const r = recommendModel(pool, prompt, { mode: routerMode === "coding" ? "coding" : opts.mode, costSensitive, needs: opts.needs });
  if (!r.model) return null;
  const why =
    routerMode === "quick"
        ? "for a fast reply (Quick mode)"
        : routerMode === "deep"
          ? "for deeper reasoning (Deep mode)"
          : routerMode === "research"
            ? "for research (Research mode)"
            : "for programming (Coding mode)";
  return {
    model: r.model,
    task,
    complexity: signal.complexity,
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
