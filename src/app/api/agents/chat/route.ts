import { fallbackChain, resolveModelChoice, type ModelChoice } from "@/lib/ai";
import { estimateCost, estimateTokens } from "@/lib/ai/cost";
import type { ChatMessage, ModelWithStatus } from "@/lib/ai/types";
import { builtinAgent } from "@/lib/agents/builtins";
import { capabilityStatus } from "@/lib/agents/capabilities";
import { authorizeTurn, runAgentTurn } from "@/lib/agents/execute";
import { agentChatRequest } from "@/lib/agents/schema";
import { isBuiltinId, type AgentConfig } from "@/lib/agents/types";
import { requireUserIfConfigured, type AuthContext } from "@/lib/auth";
import { addMessages, createConversation, getConversation } from "@/lib/db";
import { conversationIsFor, getAgent } from "@/lib/db/agents";
import { ApiError, errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { enforceLimits, planLimits, recordRun, releaseUsage, shouldSaveAllowance } from "@/lib/usage";
import { isAutoId } from "@/lib/ai/platform";

export const maxDuration = 60;

function titleFrom(message: string): string {
  const t = message.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || "New conversation";
}

/**
 * POST /api/agents/chat — one turn with an agent, streamed as NDJSON:
 * meta → (notice | sources | tool)* → delta… → done | error.
 * 1. identify the agent, 2. load its config and history, 3–5. run it through
 * the shared execution service (authorised tools only, streamed), 6. save.
 */
export async function POST(req: Request) {
  let caller: AuthContext | null = null;
  try {
    const body = await parseJsonBody(req, agentChatRequest, 240_000);
    const auth = await requireUserIfConfigured();
    caller = auth;

    // 1–2. Identify the agent and load its configuration.
    let agent: AgentConfig;
    if (isBuiltinId(body.agentId)) agent = builtinAgent(body.agentId);
    else if (auth.mode === "authenticated") agent = await getAgent(auth.supabase, auth.user.id, body.agentId);
    else if (body.agent) {
      // Guest mode (no accounts configured): the agent lives in the browser and is sent with the request.
      agent = { ...body.agent, id: body.agentId, kind: "custom", category: "Custom", modelPreference: null, temperature: null, createdAt: null, updatedAt: null };
    } else throw new ApiError("not_found", "Agent not found.");

    const attachments = body.attachments ?? [];
    authorizeTurn(agent, { attachments, useWeb: !!body.useWeb });

    // Model: the user's pick for this conversation, else the agent's saved model,
    // else a model with the agent's preferred capability, else the site default.
    // Instructions and tools don't change with the model.
    // Near the limit (and always on Free) Auto and agent defaults keep to low-cost models.
    const preferLowCost = await shouldSaveAllowance(auth);
    const limits = await planLimits(auth);
    const ctx = { prompt: body.message, preferLowCost, tiers: limits.tiers };
    let choice: ModelChoice;
    let modelNotice: string | null = null;
    if (body.modelId) choice = await resolveModelChoice(body.modelId, ctx);
    else if (agent.modelId) {
      try {
        choice = await resolveModelChoice(agent.modelId, ctx);
      } catch {
        choice = await resolveModelChoice(null, ctx);
        modelNotice = `${agent.name}'s preferred model isn't available, so ${choice.model.displayName} answered instead.`;
      }
    } else {
      // No model chosen by the user or the agent's owner: the site default, which is the lowest-cost available model.
      choice = await resolveModelChoice(null, ctx);
      choice = { ...choice, routing: { auto: true, mode: "balanced", reason: choice.model.isDefault ? `${choice.model.displayName} answered: the site's default model.` : `${choice.model.displayName} answered: the lowest-cost available model (the default when no model is chosen).` } };
    }
    let model: ModelWithStatus = choice.model;
    const requestedModel = body.modelId ?? agent.modelId ?? `agent-default:${agent.modelPreference ?? "none"}`;
    const routingReason = choice.routing?.reason ?? modelNotice ?? (body.modelId ? "Chosen by the user." : agent.modelId ? `${agent.name}'s saved model.` : "Site default model.");
    const promptChars = body.message.length + attachments.reduce((n, a) => n + a.content.length, 0);
    await enforceLimits(req, auth, 1, [model], {
      requestId: body.requestId,
      purpose: "agent",
      inputTokens: Math.ceil((promptChars + limits.historyChars) / 4) + 2000,
      maxOutputTokens: limits.maxOutputTokens,
    });
    // A model the user (or the agent's owner) picked is never swapped for another provider's.
    const fallbacks = await fallbackChain(model, choice.settings, !!body.allowFallback, { sameProvider: !!(body.modelId ?? agent.modelId) && !isAutoId(body.modelId ?? agent.modelId), tiers: limits.tiers });

    // Conversation and history.
    let conversationId: string | null = null;
    let history: ChatMessage[] = [];
    if (auth.mode === "authenticated") {
      if (body.conversationId) {
        const { conversation, messages } = await getConversation(auth.supabase, auth.user.id, body.conversationId);
        if (!conversationIsFor(conversation, agent.id)) throw new ApiError("not_found", "Conversation not found for this agent.");
        conversationId = conversation.id;
        history = messages
          .filter((m) => m.role !== "system")
          .slice(-30)
          .map((m) => ({ role: m.role, content: m.content }));
      } else {
        const c = await createConversation(auth.supabase, auth.user.id, {
          title: titleFrom(body.message),
          mode: "research",
          ...(agent.kind === "builtin" ? { builtinAgent: agent.id } : { agentId: agent.id }),
        });
        conversationId = c.id;
      }
    } else {
      history = body.history ?? [];
    }

    return ndjsonStream(async (send, signal) => {
      send({
        type: "meta",
        conversationId,
        persisted: auth.mode === "authenticated",
        model: { id: model.id, displayName: model.displayName, provider: model.provider },
        agent: { id: agent.id, name: agent.name },
        routing: choice.routing,
      });
      if (modelNotice) send({ type: "notice", level: "info", message: modelNotice });
      // Web search is counted per plan; when it's set up but the plan's searches are used, say so and answer without it.
      const searchesUsed = !!body.useWeb && limits.webSearchesLeft === 0 && capabilityStatus().web_search.available;
      if (searchesUsed) send({ type: "notice", level: "info", message: "Your plan's web searches for this month are used up, so this answer comes from the model's own knowledge." });

      // 3–5. Shared execution service: tools, prompt, streaming.
      let result;
      // Text already streamed is charged even if the request is stopped or fails part-way (the provider bills it).
      let partial = "";
      const relay = (event: Record<string, unknown>) => {
        if (event.type === "delta" && typeof event.text === "string") partial += event.text;
        send(event);
      };
      const started = performance.now();
      try {
        result = await runAgentTurn({ agent, model, fallbacks, history, message: body.message, attachments, useWeb: !!body.useWeb && !searchesUsed, timeZone: body.timeZone, maxOutputTokens: limits.maxOutputTokens, historyChars: limits.historyChars, signal, send: relay });
        model = result.model;
      } catch (err) {
        await recordRun(auth, {
          model,
          prompt: body.message,
          response: partial,
          latencyMs: performance.now() - started,
          usage: partial
            ? { inputTokens: estimateTokens([...history, { role: "user", content: body.message }]) + estimateTokens(attachments.map((a) => a.content).join("\n")), outputTokens: estimateTokens(partial), estimated: true }
            : { inputTokens: null, outputTokens: null, estimated: true },
          status: "error",
          conversationId,
          purpose: "agent",
          requestedModel,
          routingReason,
          error: err instanceof Error ? err.message : "failed",
        });
        throw err;
      }
      await recordRun(auth, {
        model,
        prompt: body.message,
        response: result.text,
        latencyMs: result.latencyMs,
        usage: result.usage,
        status: "success",
        conversationId,
        purpose: "agent",
        servedModel: result.servedModel,
        requestedModel,
        routingReason: model.id === choice.model.id ? routingReason : `Fallback from ${choice.model.displayName}. ${routingReason}`,
        tools: result.tools.map((t) => t.name),
      });

      // 6. Save both messages (signed-in users).
      let assistantMessageId: string | null = null;
      if (auth.mode === "authenticated" && conversationId) {
        try {
          const rows = await addMessages(auth.supabase, conversationId, [
            { role: "user", content: body.message, usage_metadata: { attachments: attachments.map((a) => a.name) } },
            {
              role: "assistant",
              content: result.text,
              model_id: model.id,
              usage_metadata: {
                ...result.usage,
                estimatedCost: estimateCost(model, result.usage),
                agent: agent.id,
                tools: result.tools,
                sources: result.sources.map(({ index, url, title }) => ({ index, url, title })),
              },
            },
          ]);
          assistantMessageId = rows.find((r) => r.role === "assistant")?.id ?? null;
        } catch (err) {
          reportError(err, { where: "agents.chat.addMessages" });
          send({ type: "notice", level: "warning", message: "The reply could not be saved to this agent's history." });
        }
      }

      send({
        type: "done",
        text: result.text,
        assistantMessageId,
        simulated: model.provider === "demo",
        usage: result.usage,
        estimatedCost: estimateCost(model, result.usage),
      });
    }, req.signal);
  } catch (err) {
    // The request failed before any model ran: give back its reservation.
    if (caller) await releaseUsage(caller);
    return errorResponse(err);
  }
}
