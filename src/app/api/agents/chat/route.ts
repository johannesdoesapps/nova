import { resolveModel } from "@/lib/ai";
import { estimateCost } from "@/lib/ai/cost";
import type { ChatMessage, ModelWithStatus } from "@/lib/ai/types";
import { builtinAgent } from "@/lib/agents/builtins";
import { authorizeTurn, runAgentTurn } from "@/lib/agents/execute";
import { agentChatRequest } from "@/lib/agents/schema";
import { isBuiltinId, type AgentConfig } from "@/lib/agents/types";
import { requireUserIfConfigured } from "@/lib/auth";
import { addMessages, createConversation, getConversation } from "@/lib/db";
import { conversationIsFor, getAgent } from "@/lib/db/agents";
import { ApiError, errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { enforceLimits, recordRun } from "@/lib/usage";

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
  try {
    const body = await parseJsonBody(req, agentChatRequest, 240_000);
    const auth = await requireUserIfConfigured();

    // 1–2. Identify the agent and load its configuration.
    let agent: AgentConfig;
    if (isBuiltinId(body.agentId)) agent = builtinAgent(body.agentId);
    else if (auth.mode === "authenticated") agent = await getAgent(auth.supabase, auth.user.id, body.agentId);
    else if (body.agent) {
      // Guest mode (no accounts configured): the agent lives in the browser and is sent with the request.
      agent = { ...body.agent, id: body.agentId, kind: "custom", category: "Custom", temperature: null, createdAt: null, updatedAt: null };
    } else throw new ApiError("not_found", "Agent not found.");

    const attachments = body.attachments ?? [];
    authorizeTurn(agent, { attachments, useWeb: !!body.useWeb });

    // Model: an explicit choice must be available; the agent's saved default falls back politely.
    let model: ModelWithStatus;
    let modelNotice: string | null = null;
    if (body.modelId) model = await resolveModel(body.modelId);
    else if (agent.modelId) {
      try {
        model = await resolveModel(agent.modelId);
      } catch {
        model = await resolveModel();
        modelNotice = `${agent.name}'s preferred model isn't available, so ${model.displayName} answered instead.`;
      }
    } else model = await resolveModel();
    await enforceLimits(req, auth, 1, [model]);

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
      });
      if (modelNotice) send({ type: "notice", level: "info", message: modelNotice });

      // 3–5. Shared execution service: tools, prompt, streaming.
      let result;
      try {
        result = await runAgentTurn({ agent, model, history, message: body.message, attachments, useWeb: !!body.useWeb, signal, send });
      } catch (err) {
        void recordRun(auth, {
          model,
          prompt: body.message,
          response: "",
          latencyMs: 0,
          usage: { inputTokens: null, outputTokens: null, estimated: true },
          status: "error",
          conversationId,
          purpose: "agent",
        });
        throw err;
      }
      void recordRun(auth, {
        model,
        prompt: body.message,
        response: result.text,
        latencyMs: result.latencyMs,
        usage: result.usage,
        status: "success",
        conversationId,
        purpose: "agent",
        servedModel: result.servedModel,
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
    return errorResponse(err);
  }
}
