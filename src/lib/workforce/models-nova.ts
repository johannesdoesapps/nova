import "server-only";
import { getProvider, resolveModelChoice, withTimeout } from "../ai";
import type { ChatMessage } from "../ai/types";
import type { AuthContext } from "../auth";
import { recordRunLater } from "../usage";
import { estimateTokens, type ModelRunner, type ResolvedModel } from "./models";

/** Production model access: Orbis's provider registry, Auto routing and usage records. */
export function novaModelRunner(auth: AuthContext): ModelRunner {
  const cache = new Map<string, Awaited<ReturnType<typeof resolveModelChoice>>["model"]>();
  return {
    async resolve(choice: string, prompt: string): Promise<ResolvedModel> {
      const r = await resolveModelChoice(choice, { prompt });
      cache.set(r.model.id, r.model);
      return { id: r.model.id, displayName: r.model.displayName, provider: r.model.provider, inputPrice: r.model.inputPrice, outputPrice: r.model.outputPrice, simulated: r.model.provider === "demo" };
    },
    async generate(model: ResolvedModel, messages: ChatMessage[], opts) {
      const info = cache.get(model.id);
      if (!info) throw new Error("Model not resolved.");
      const started = performance.now();
      const r = await getProvider(info.provider).generate({ model: info, messages, maxOutputTokens: opts.maxOutputTokens, temperature: 0.2, signal: withTimeout(170_000, opts.signal) });
      const estimated = r.usage.inputTokens === null || r.usage.outputTokens === null;
      const inputTokens = r.usage.inputTokens ?? estimateTokens(messages);
      const outputTokens = r.usage.outputTokens ?? estimateTokens(r.text);
      recordRunLater(auth, {
        model: info,
        prompt: `[workforce:${opts.purpose}]`,
        response: r.text.slice(0, 2000),
        latencyMs: performance.now() - started,
        usage: { inputTokens, outputTokens, estimated },
        status: "success",
        purpose: "workforce",
        category: "engineering",
        servedModel: r.servedModel ?? null,
      });
      return { text: r.text, inputTokens, outputTokens, estimated };
    },
  };
}
