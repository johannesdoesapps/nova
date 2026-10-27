import "server-only";
import { getAllModels, getProvider } from "../ai";
import { estimateCost } from "../ai/cost";
import { PROVIDER_INFO } from "../ai/provider-info";
import { KEY_VARS } from "../ai/registry";
import type { ModelInfo, ModelWithStatus, ProviderId, ToolCall, ToolMessage, ToolSpec, Usage } from "../ai/types";
import type { Authed } from "../code/server";
import { enforceLimits, recordRunLater, releaseUsage } from "../usage";
import { OrchError } from "./errors";

/**
 * The orchestrator's provider layer. Every model call an agent makes goes through a ModelGateway: it resolves the
 * agent's provider + model to a registered model (never switching to another one silently), meters the call
 * against the task owner's plan (the usage ledger's atomic reservation), calls the provider through its adapter,
 * and records the run. Credentials stay in server environment variables and are never returned or logged.
 *
 * Adapters: Orbis's existing providers (Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Hugging Face) are wrapped
 * by orbisAdapter(); another provider is added by registering a ProviderAdapter (and its models in the model
 * registry), without touching the scheduler or the executor.
 */

export interface ModelCapabilities {
  /** Native tool calling (needed for agents with tools). */
  toolCalling: boolean;
  vision: boolean;
  reasoning: boolean;
  longContext: boolean;
  /** Has a known price, so its cost can be estimated and limited. */
  priced: boolean;
}

export interface ResolvedModel {
  id: string;
  provider: string;
  name: string;
  capabilities: ModelCapabilities;
  /** The registry entry (prices, provider model id) for the adapter. */
  info: ModelInfo;
}

export interface ModelCall {
  system: string;
  messages: ToolMessage[];
  /** Empty: a plain answer. Only sent to models with native tool calling. */
  tools: ToolSpec[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface ModelReply {
  text: string;
  calls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; estimated: boolean };
  costUsd: number | null;
  stop: "tool_use" | "end_turn" | "max_tokens" | "refusal" | "other";
  servedModel: string | null;
}

export interface ModelGateway {
  resolve(provider: string, modelId: string): Promise<ResolvedModel>;
  call(owner: Authed, model: ResolvedModel, req: ModelCall, meta: { taskId: string; purpose: string }): Promise<ModelReply>;
}

/** One provider: whether it's usable here and how to make one call. */
export interface ProviderAdapter {
  id: string;
  label: string;
  /** The environment variable holding its credential (names only; never values). */
  envVar: string | null;
  configured(): boolean;
  supportsToolCalling(model: ModelInfo): boolean;
  call(model: ModelInfo, req: ModelCall): Promise<{ text: string; calls: ToolCall[]; usage: Usage; stop: ModelReply["stop"]; servedModel: string | null }>;
}

const toChat = (system: string, messages: ToolMessage[]) => [
  { role: "system" as const, content: system },
  ...messages.map((m) => ({ role: m.role, content: m.role === "user" && m.results?.length ? `${m.text}\n${m.results.map((r) => r.text).join("\n\n")}`.trim() : m.text })),
];

/** An adapter over one of Orbis's built-in providers (src/lib/ai). */
export function orbisAdapter(id: Exclude<ProviderId, "demo">): ProviderAdapter {
  const p = () => getProvider(id);
  return {
    id,
    label: PROVIDER_INFO[id].label,
    envVar: KEY_VARS[id],
    configured: () => p().isConfigured(),
    // Native tool calling is wired for Anthropic and OpenAI (as in the coding agent); other providers answer plainly.
    supportsToolCalling: () => (id === "anthropic" || id === "openai") && typeof p().toolTurn === "function",
    async call(model, req) {
      if (req.tools.length) {
        const r = await p().toolTurn!({ model, system: req.system, messages: req.messages, tools: req.tools, maxOutputTokens: req.maxOutputTokens, signal: req.signal });
        return { text: r.text, calls: r.calls, usage: r.usage, stop: r.stop, servedModel: r.servedModel };
      }
      const r = await p().generate({ model, messages: toChat(req.system, req.messages), maxOutputTokens: req.maxOutputTokens, temperature: 0.2, signal: req.signal });
      if (r.simulated) throw new OrchError("model_unavailable", "This model is a demo stand-in, not a real AI model.");
      return { text: r.text, calls: [], usage: r.usage, stop: "end_turn", servedModel: r.servedModel ?? null };
    },
  };
}

const adapters = new Map<string, ProviderAdapter>((["anthropic", "openai", "google", "xai", "deepseek", "huggingface"] as const).map((id) => [id, orbisAdapter(id)]));

/** Add (or replace) a provider adapter. Its models must also be in the model registry. */
export function registerProviderAdapter(a: ProviderAdapter): void {
  adapters.set(a.id, a);
}
export const providerAdapter = (id: string) => adapters.get(id) ?? null;
export const providerIds = () => [...adapters.keys()];

export function capabilitiesOf(m: Pick<ModelInfo, "capabilities" | "inputPrice" | "outputPrice">, toolCalling: boolean): ModelCapabilities {
  return {
    toolCalling,
    vision: m.capabilities.includes("vision"),
    reasoning: m.capabilities.includes("reasoning"),
    longContext: m.capabilities.includes("long-context"),
    priced: m.inputPrice !== null && m.outputPrice !== null,
  };
}

function toResolved(m: ModelWithStatus, a: ProviderAdapter): ResolvedModel {
  return { id: m.id, provider: m.provider, name: m.displayName, capabilities: capabilitiesOf(m, a.supportsToolCalling(m)), info: m };
}

/**
 * Check a profile's provider and model. Errors make the profile invalid (unknown provider or model); warnings
 * don't block saving but explain what will happen (no credentials yet: its tasks fail until they're added).
 */
export async function checkProfileModel(provider: string, modelId: string, allowedTools: string[] = []): Promise<{ errors: string[]; warnings: string[]; capabilities: ModelCapabilities | null }> {
  const a = providerAdapter(provider);
  if (!a) return { errors: [`Unknown provider "${provider}". Available: ${providerIds().join(", ")}.`], warnings: [], capabilities: null };
  const m = (await getAllModels()).find((x) => x.id === modelId && x.provider === provider);
  if (!m) return { errors: [`"${modelId}" isn't a registered ${a.label} model.`], warnings: [], capabilities: null };
  const caps = capabilitiesOf(m, a.supportsToolCalling(m));
  const warnings: string[] = [];
  if (!a.configured()) warnings.push(`${a.label} has no credentials on this server (${a.envVar}), so this agent's tasks will fail until it's set.`);
  if (allowedTools.length && !caps.toolCalling) warnings.push(`${m.displayName} can't call tools here, so this agent will answer without reading the project.`);
  if (!caps.priced) warnings.push(`${m.displayName} has no known price, so its cost is counted in tokens only.`);
  return { errors: [], warnings, capabilities: caps };
}

/** Providers and their models, for the API: whether credentials are configured (never the credentials). */
export async function providerStatus() {
  const models = await getAllModels();
  return [...adapters.values()].map((a) => ({
    id: a.id,
    label: a.label,
    configured: a.configured(),
    credentialEnvVar: a.envVar,
    models: models
      .filter((m) => m.provider === a.id)
      .map((m) => ({ id: m.id, name: m.displayName, available: m.available && a.configured(), capabilities: capabilitiesOf(m, a.supportsToolCalling(m)), contextWindow: m.contextWindow })),
  }));
}

/** Production gateway: Orbis's model registry, the usage ledger and the provider adapters. */
export const orbisGateway: ModelGateway = {
  async resolve(provider, modelId) {
    const a = providerAdapter(provider);
    if (!a) throw new OrchError("model_unavailable", `Unknown provider "${provider}".`);
    const m = (await getAllModels()).find((x) => x.id === modelId && x.provider === provider);
    // Never another model instead: the profile says which one runs.
    if (!m) throw new OrchError("model_unavailable", `"${modelId}" isn't a registered ${a.label} model (it may have been retired). Update the agent's model.`);
    if (!a.configured()) throw new OrchError("not_configured", `${a.label} isn't configured on this server: set ${a.envVar}.`);
    return toResolved(m, a);
  },
  async call(owner, model, req, meta) {
    const a = providerAdapter(model.provider)!;
    const promptChars = req.system.length + JSON.stringify(req.messages).length;
    // Meter against the owner's plan first (atomic reservation); a refusal is a "quota" error, not retried.
    await enforceLimits(new Request("https://orbis.internal/orchestrator"), owner, 1, [model.info], { purpose: "orchestrator", inputTokens: Math.ceil(promptChars / 3.5) + 200, maxOutputTokens: req.maxOutputTokens });
    const t0 = performance.now();
    try {
      const r = await a.call(model.info, { ...req, tools: model.capabilities.toolCalling ? req.tools : [] });
      const usage = { inputTokens: r.usage.inputTokens ?? Math.ceil(promptChars / 4), outputTokens: r.usage.outputTokens ?? Math.ceil(r.text.length / 4), estimated: r.usage.estimated || r.usage.inputTokens === null || r.usage.outputTokens === null };
      recordRunLater(owner, {
        model: model.info,
        prompt: `[orchestrator:${meta.purpose}] task ${meta.taskId}`,
        response: r.text.slice(0, 1000),
        latencyMs: performance.now() - t0,
        usage: { ...r.usage, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimated: usage.estimated },
        status: "success",
        purpose: "orchestrator",
        category: "engineering",
        servedModel: r.servedModel,
        requestedModel: model.id,
        routingReason: "Orchestrator agent profile (fixed model).",
        tools: r.calls.map((c) => c.name),
      });
      return { text: r.text, calls: r.calls, usage, costUsd: estimateCost(model.info, usage), stop: r.stop, servedModel: r.servedModel };
    } catch (err) {
      await releaseUsage(owner);
      throw err;
    }
  },
};
