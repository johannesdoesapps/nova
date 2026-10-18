import type { AIProvider, GenerateParams, GenerateResult, StreamEvent } from "../types";
import { estimateTokens } from "../cost";

export const DEMO_NOTICE =
  "**Demo mode — simulated response.** No AI provider is configured, so this text was generated locally from a template and is not a real model output.";

function demoText(params: GenerateParams): string {
  const last = [...params.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const question =
    last.match(/Question:\s*(.+)/)?.[1]?.slice(0, 200) ??
    last.replace(/<document[\s\S]*?<\/document>/g, "").split("\n").find((l) => l.trim())?.trim().slice(0, 200) ??
    "your request";
  const hasSources = params.messages.some((m) => m.content.includes("<source "));
  return [
    DEMO_NOTICE,
    "",
    `You asked: “${question}”.`,
    "",
    hasSources
      ? "Real web sources were retrieved for this question and are listed alongside this message, but no model was available to read and summarise them. Open the sources directly, or add `OPENAI_API_KEY` to get a grounded answer."
      : "To get a real answer, add `OPENAI_API_KEY` (or `HUGGINGFACE_API_KEY` for open models) to `.env.local` and restart the server.",
  ].join("\n");
}

export const demoProvider: AIProvider = {
  id: "demo",
  isConfigured: () => true,
  missingConfig: () => null,
  async generate(params): Promise<GenerateResult> {
    const text = demoText(params);
    return {
      text,
      usage: { inputTokens: estimateTokens(params.messages), outputTokens: estimateTokens(text), estimated: true },
      simulated: true,
    };
  },
  async *stream(params): AsyncGenerator<StreamEvent> {
    const text = demoText(params);
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 24) chunks.push(text.slice(i, i + 24));
    for (const chunk of chunks) {
      if (params.signal?.aborted) return;
      yield { type: "delta", text: chunk };
      await new Promise((r) => setTimeout(r, 12));
    }
    yield {
      type: "usage",
      usage: { inputTokens: estimateTokens(params.messages), outputTokens: estimateTokens(text), estimated: true },
    };
  },
};
