import { getProvider, resolveModel, withTimeout } from "@/lib/ai";
import { estimateCost, estimateTokens } from "@/lib/ai/cost";
import { systemPromptFor } from "@/lib/ai/modes";
import { trimHistory } from "@/lib/ai/trim";
import type { ChatMessage, Usage } from "@/lib/ai/types";
import { requireUserIfConfigured } from "@/lib/auth";
import { addMessages, createConversation, getConversation, updateConversation } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { ApiError, errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { stripInvalidCitations } from "@/lib/search/grounding";
import type { SearchSource } from "@/lib/search/types";
import { webSearch } from "@/lib/search/web";
import { enforceLimits, recordRun } from "@/lib/usage";
import { chatRequest } from "@/lib/validation";

export const maxDuration = 60;

function titleFrom(message: string): string {
  const t = message.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || "New conversation";
}

function escapeDoc(s: string) {
  return s.replace(/<\/?\s*(document|source|system)\b[^>]*>/gi, "[tag removed]");
}

/**
 * POST /api/chat — streams NDJSON: meta → (sources) → delta… → done | error.
 * Authenticated users get history persisted; guests send their own history.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, chatRequest, 220_000);
    const auth = await requireUserIfConfigured();
    const model = await resolveModel(body.modelId);
    await enforceLimits(req, auth, 1, [model]);

    // Conversation + history
    let conversationId: string | null = null;
    let history: ChatMessage[] = [];
    if (auth.mode === "authenticated") {
      if (body.conversationId) {
        const { conversation, messages } = await getConversation(auth.supabase, auth.user.id, body.conversationId);
        if (conversation.agent_id || conversation.builtin_agent) {
          throw new ApiError("bad_request", "This conversation belongs to an agent. Continue it from the Agents workspace.");
        }
        conversationId = conversation.id;
        history = messages
          .filter((m) => m.role !== "system")
          .slice(-30)
          .map((m) => ({ role: m.role, content: m.content }));
        if (conversation.mode !== body.mode) {
          await updateConversation(auth.supabase, auth.user.id, conversation.id, { mode: body.mode });
        }
      } else {
        const c = await createConversation(auth.supabase, auth.user.id, {
          title: titleFrom(body.message),
          mode: body.mode,
          projectId: body.projectId,
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
      });

      let system = systemPromptFor(body.mode);

      // Optional web grounding in Research mode
      let sources: SearchSource[] = [];
      if (body.mode === "research" && body.useWeb) {
        const env = serverEnv();
        try {
          const r = await webSearch(body.message.slice(0, 400), { provider: env.searchProvider, apiKey: env.searchKey }, withTimeout(15_000, signal));
          sources = r.sources;
          send({ type: "sources", sources });
          if (sources.length) {
            system += `\n\nWeb sources for the latest message (cite as [n]):\n<sources>\n${sources
              .map((s) => `<source id="${s.index}" url="${s.url}">${escapeDoc(s.title)} — ${escapeDoc(s.snippet)}</source>`)
              .join("\n")}\n</sources>`;
          }
        } catch (err) {
          send({
            type: "notice",
            level: "warning",
            message: `Web sources could not be retrieved (${err instanceof ApiError ? err.message : "search failed"}). Answering without live evidence.`,
          });
        }
      }

      let userContent = body.message;
      if (body.attachments?.length) {
        const docs = body.attachments
          .map((a) => `<document name="${a.name.replace(/"/g, "'")}">\n${escapeDoc(a.content)}\n</document>`)
          .join("\n");
        userContent = `${docs}\n\n${body.message}`;
      }

      const messages: ChatMessage[] = [{ role: "system", content: system }, ...trimHistory(history), { role: "user", content: userContent }];
      const started = performance.now();
      let text = "";
      let usage: Usage | null = null;
      let servedModel: string | null = null;
      let status: "success" | "error" = "success";
      try {
        for await (const ev of getProvider(model.provider).stream({
          model,
          messages,
          maxOutputTokens: 2400,
          signal: withTimeout(50_000, signal),
        })) {
          if (ev.type === "delta") {
            text += ev.text;
            send({ type: "delta", text: ev.text });
          } else if (ev.type === "usage") usage = ev.usage;
          else servedModel = ev.servedModel;
        }
      } catch (err) {
        status = "error";
        throw err;
      } finally {
        usage ??= { inputTokens: estimateTokens(messages), outputTokens: estimateTokens(text), estimated: true };
        void recordRun(auth, {
          model,
          prompt: body.message,
          response: text,
          latencyMs: performance.now() - started,
          usage,
          status,
          conversationId,
          purpose: "chat",
          servedModel,
        });
      }

      if (sources.length) text = stripInvalidCitations(text, sources);

      let assistantMessageId: string | null = null;
      if (auth.mode === "authenticated" && conversationId) {
        try {
          const usageMeta = { ...usage, estimatedCost: estimateCost(model, usage), sources: sources.map(({ index, url, title }) => ({ index, url, title })), attachments: body.attachments?.map((a) => a.name) ?? [] };
          const rows = await addMessages(auth.supabase, conversationId, [
            { role: "user", content: body.message, usage_metadata: { attachments: body.attachments?.map((a) => a.name) ?? [] } },
            { role: "assistant", content: text, model_id: model.id, usage_metadata: usageMeta },
          ]);
          assistantMessageId = rows.find((r) => r.role === "assistant")?.id ?? null;
        } catch (err) {
          reportError(err, { where: "chat.addMessages" });
          send({ type: "notice", level: "warning", message: "The reply could not be saved to your history." });
        }
      }

      send({
        type: "done",
        text,
        assistantMessageId,
        simulated: model.provider === "demo",
        usage,
        estimatedCost: estimateCost(model, usage),
      });
    }, req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}
