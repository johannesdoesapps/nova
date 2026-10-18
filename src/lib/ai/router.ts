import { estimateTokens } from "./cost";
import type { ModelWithStatus } from "./types";

export type TaskKind = "summary" | "analysis" | "coding" | "long-document" | "general";

export interface TaskSignal {
  kind: TaskKind;
  reasons: string[];
  estimatedTokens: number;
}

const CODE_HINTS =
  /```|\b(function|class|const|let|def|import|export|SELECT|INSERT|stack ?trace|TypeError|exception|compile|bug|debug|refactor|regex|typescript|javascript|python|rust|golang|sql|api endpoint)\b/i;
const SUMMARY_HINTS = /\b(summari[sz]e|summary|tl;?dr|shorten|key points|bullet points|recap|condense)\b/i;
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
  opts: { mode?: string; costSensitive?: boolean } = {},
): Recommendation {
  const task = classifyTask(prompt, opts.mode);
  const disclaimer =
    "Recommendations follow simple, published rules (task type, capabilities, context window and known price). They are estimates, not quality guarantees.";
  const pool = models.filter((m) => m.available);
  if (pool.length === 0) {
    return { model: null, task, explanation: ["No models are currently available. Add an API key in .env.local."], disclaimer };
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
