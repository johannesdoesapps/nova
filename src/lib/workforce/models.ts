import type { z } from "zod";
import type { ChatMessage } from "../ai/types";
import { parseModelJson } from "./schemas";

/**
 * Model access for agents. The runtime never talks to providers directly:
 * it goes through this interface, which the production adapter implements
 * with Orbis's existing provider registry, routing and usage records.
 */
export interface ResolvedModel {
  id: string;
  displayName: string;
  provider: string;
  /** USD per 1M tokens, or null when not known. */
  inputPrice: number | null;
  outputPrice: number | null;
  simulated: boolean;
}

export interface ModelRunner {
  resolve(choice: string, prompt: string): Promise<ResolvedModel>;
  generate(model: ResolvedModel, messages: ChatMessage[], opts: { maxOutputTokens: number; signal?: AbortSignal; purpose: string }): Promise<{ text: string; inputTokens: number; outputTokens: number; estimated: boolean }>;
}

export class BudgetError extends Error {
  constructor(
    message: string,
    readonly kind: "cost" | "tokens" | "unpriced",
  ) {
    super(message);
  }
}
export class ModelUnavailableError extends Error {}
export class OutputInvalidError extends Error {}

export const estimateTokens = (messages: ChatMessage[] | string) => Math.ceil((typeof messages === "string" ? messages : messages.map((m) => m.content).join("\n")).length / 4);

export function costOf(model: ResolvedModel, inputTokens: number, outputTokens: number): number | null {
  if (model.inputPrice === null || model.outputPrice === null) return null;
  return (inputTokens * model.inputPrice + outputTokens * model.outputPrice) / 1_000_000;
}

export interface Ledger {
  spentUsd: number;
  budgetUsd: number;
  tokensUsed: number;
  tokenBudget: number;
  allowUnpriced: boolean;
}

export interface CallResult<T> {
  data: T;
  modelId: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  estimated: boolean;
  calls: number;
}

/**
 * One structured agent call: checks the budget before calling, validates the
 * output against the schema, and gives the model one chance to fix invalid
 * output. Throws BudgetError before spending anything that would exceed the
 * task's limits.
 */
export async function structuredCall<T extends z.ZodType>(
  runner: ModelRunner,
  opts: { choice: string; messages: ChatMessage[]; schema: T; maxOutputTokens: number; ledger: Ledger; signal?: AbortSignal; purpose: string; validate?: (data: z.infer<T>) => string | null },
): Promise<CallResult<z.infer<T>>> {
  const model = await runner.resolve(opts.choice, opts.messages.at(-1)?.content.slice(0, 2000) ?? "");
  if (model.simulated) throw new ModelUnavailableError("No real AI model is configured, so this agent can't run. Add an AI provider key.");
  if ((model.inputPrice === null || model.outputPrice === null) && !opts.ledger.allowUnpriced) {
    throw new BudgetError(`${model.displayName} has no known price, so its cost can't be limited. Choose a priced model or allow unpriced models in Workforce settings.`, "unpriced");
  }
  let messages = opts.messages;
  let totalIn = 0;
  let totalOut = 0;
  let estimated = false;
  let calls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const projectedIn = estimateTokens(messages);
    const projectedCost = costOf(model, projectedIn, opts.maxOutputTokens) ?? 0;
    const spentSoFar = costOf(model, totalIn, totalOut) ?? 0;
    if (opts.ledger.spentUsd + spentSoFar + projectedCost > opts.ledger.budgetUsd) {
      throw new BudgetError(`This call could cost up to $${projectedCost.toFixed(4)}, which would exceed the task budget ($${opts.ledger.budgetUsd.toFixed(2)}; $${(opts.ledger.spentUsd + spentSoFar).toFixed(4)} used).`, "cost");
    }
    if (opts.ledger.tokensUsed + totalIn + totalOut + projectedIn + opts.maxOutputTokens > opts.ledger.tokenBudget) {
      throw new BudgetError(`This call could exceed the task's token budget (${opts.ledger.tokenBudget.toLocaleString("en-US")} tokens).`, "tokens");
    }
    const r = await runner.generate(model, messages, { maxOutputTokens: opts.maxOutputTokens, signal: opts.signal, purpose: opts.purpose });
    calls++;
    totalIn += r.inputTokens;
    totalOut += r.outputTokens;
    estimated ||= r.estimated;
    const parsed = parseModelJson(r.text, opts.schema);
    const problem = parsed.ok ? (opts.validate?.(parsed.data) ?? null) : parsed.error;
    if (parsed.ok && !problem) {
      return { data: parsed.data, modelId: model.id, modelName: model.displayName, inputTokens: totalIn, outputTokens: totalOut, costUsd: costOf(model, totalIn, totalOut), estimated, calls };
    }
    if (attempt === 1) {
      const err = new OutputInvalidError(`The model's output was rejected: ${problem}`);
      Object.assign(err, { usage: { modelId: model.id, inputTokens: totalIn, outputTokens: totalOut, costUsd: costOf(model, totalIn, totalOut) } });
      throw err;
    }
    messages = [...opts.messages, { role: "assistant", content: r.text.slice(0, 20000) }, { role: "user", content: `Your reply was rejected: ${problem}\nReply again with one corrected JSON object only.` }];
  }
  throw new OutputInvalidError("unreachable");
}
