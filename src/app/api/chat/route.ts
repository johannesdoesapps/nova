import { fallbackChain, resolveModelChoice, withTimeout } from "@/lib/ai";
import { streamWithFallback } from "@/lib/ai/fallback";
import { estimateCost, estimateTokens } from "@/lib/ai/cost";
import { systemPromptFor } from "@/lib/ai/modes";
import { trimHistory } from "@/lib/ai/trim";
import { isAutoId } from "@/lib/ai/platform";
import type { ChatMessage, Usage } from "@/lib/ai/types";
import { requireUserIfConfigured, type AuthContext } from "@/lib/auth";
import { addMessages, createConversation, deleteMessage, getConversation, regeneratedReply, updateConversation } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { ApiError, errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { stripInvalidCitations } from "@/lib/search/grounding";
import type { SearchSource } from "@/lib/search/types";
import { webSearch } from "@/lib/search/web";
import { buildTurnContext } from "@/lib/ai/turn-context";
import { enforceLimits, planLimits, recordRun, releaseUsage, shouldSaveAllowance } from "@/lib/usage";
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
  let caller: AuthContext | null = null;
  try {
    const body = await parseJsonBody(req, chatRequest, 220_000);
    const auth = await requireUserIfConfigured();
    caller = auth;
    const limits = await planLimits(auth);
    const choice = await resolveModelChoice(body.modelId, {
      prompt: body.message,
      mode: body.mode,
      preferLowCost: isAutoId(body.modelId) ? await shouldSaveAllowance(auth) : false,
      tiers: limits.tiers,
    });
    let model = choice.model;
    const promptChars = body.message.length + (body.attachments ?? []).reduce((n, a) => n + a.content.length, 0);
    await enforceLimits(req, auth, 1, [model], {
      requestId: body.requestId,
      purpose: "chat",
      inputTokens: Math.ceil((promptChars + limits.historyChars) / 4) + 1500,
      maxOutputTokens: limits.maxOutputTokens,
    });
    const requestedModel = body.modelId ?? "default";
    const routingReason = choice.routing?.reason ?? (body.modelId ? "Chosen by the user." : "Site default model.");
    // A model the user picked is never swapped for another provider's.
    const fallbacks = await fallbackChain(model, choice.settings, !!body.allowFallback, { sameProvider: !isAutoId(body.modelId) && !!body.modelId, tiers: limits.tiers });

    // Conversation + history
    let conversationId: string | null = null;
    let history: ChatMessage[] = [];
    // Regenerate: the saved reply this turn replaces (its question is reused, not saved again).
    let replacing: string | null = null;
    if (auth.mode === "authenticated") {
      if (body.conversationId) {
        const { conversation, messages } = await getConversation(auth.supabase, auth.user.id, body.conversationId);
        if (conversation.agent_id || conversation.builtin_agent) {
          throw new ApiError("bad_request", "This conversation belongs to an agent. Continue it from the Agents workspace.");
        }
        conversationId = conversation.id;
        const turns = messages.filter((m) => m.role !== "system");
        replacing = body.regenerate ? regeneratedReply(turns, body.message) : null;
        // The model sees neither the old answer nor the question twice.
        history = (replacing ? turns.slice(0, -2) : turns)
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
        routing: choice.routing,
      });

      let system = systemPromptFor(body.mode);
      const turnTools: string[] = [];

      // Optional web grounding in Research mode, or always when the Smart Router's Research mode is on.
      let sources: SearchSource[] = [];
      const routerResearch = choice.routing?.mode === "research";
      const searchReady = !!serverEnv().searchKey && ["tavily", "brave"].includes(serverEnv().searchProvider);
      if (routerResearch && !searchReady) {
        send({ type: "notice", level: "info", message: "Research mode uses web sources when search is set up. It isn't on this site, so this answer comes from the model's own knowledge and may be out of date." });
      }
      const wantsSearch = (body.mode === "research" && body.useWeb) || (routerResearch && searchReady);
      if (wantsSearch && limits.webSearchesLeft === 0) {
        send({ type: "notice", level: "info", message: "Your plan's web searches for this month are used up, so this answer comes from the model's own knowledge." });
      }
      if (wantsSearch && limits.webSearchesLeft !== 0) {
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

      // Fresh, trusted context for this turn: time, time-tool results, live-data honesty.
      const turn = buildTurnContext(body.message, { timeZone: body.timeZone, liveSources: sources.length > 0 });
      system += `\n\n${turn.system}`;
      for (const tool of turn.tools) send({ type: "tool", tool });
      turnTools.push(...turn.tools.map((t) => t.name));

      let userContent = body.message;
      if (body.attachments?.length) {
        const docs = body.attachments
          .map((a) => `<document name="${a.name.replace(/"/g, "'")}">\n${escapeDoc(a.content)}\n</document>`)
          .join("\n");
        userContent = `${docs}\n\n${body.message}`;
      }

      const messages: ChatMessage[] = [{ role: "system", content: system }, ...trimHistory(history, 40, limits.historyChars), { role: "user", content: userContent }];
      const started = performance.now();
      let text = "";
      let usage: Usage | null = null;
      let servedModel: string | null = null;
      let status: "success" | "error" = "success";
      let failure: string | null = null;
      try {
        for await (const ev of streamWithFallback(model, fallbacks, { messages, maxOutputTokens: limits.maxOutputTokens }, () => withTimeout(50_000, signal))) {
          if (ev.type === "delta") {
            text += ev.text;
            send({ type: "delta", text: ev.text });
          } else if (ev.type === "usage") usage = ev.usage;
          else if (ev.type === "fallback") {
            model = ev.to;
            send({ type: "model", model: { id: model.id, displayName: model.displayName, provider: model.provider } });
            send({ type: "notice", level: "info", message: `${ev.from.displayName} was unavailable, so ${ev.to.displayName} answered instead (you allowed fallback in Settings).` });
          } else servedModel = ev.servedModel;
        }
      } catch (err) {
        status = "error";
        failure = err instanceof Error ? err.message : "failed";
        throw err;
      } finally {
        usage ??= { inputTokens: estimateTokens(messages), outputTokens: estimateTokens(text), estimated: true };
        await recordRun(auth, {
          model,
          prompt: body.message,
          response: text,
          latencyMs: performance.now() - started,
          usage,
          status,
          conversationId,
          purpose: "chat",
          servedModel,
          requestedModel,
          routingReason: model.id === choice.model.id ? routingReason : `Fallback from ${choice.model.displayName}. ${routingReason}`,
          tools: [...turnTools, ...(sources.length ? ["web_search"] : [])],
          error: failure,
        });
      }

      if (sources.length) text = stripInvalidCitations(text, sources);

      let assistantMessageId: string | null = null;
      if (auth.mode === "authenticated" && conversationId) {
        try {
          const usageMeta = { ...usage, estimatedCost: estimateCost(model, usage), sources: sources.map(({ index, url, title }) => ({ index, url, title })), attachments: body.attachments?.map((a) => a.name) ?? [] };
          const rows = await addMessages(auth.supabase, conversationId, [
            ...(replacing ? [] : [{ role: "user" as const, content: body.message, usage_metadata: { attachments: body.attachments?.map((a) => a.name) ?? [] } }]),
            { role: "assistant", content: text, model_id: model.id, usage_metadata: usageMeta },
          ]);
          assistantMessageId = rows.find((r) => r.role === "assistant")?.id ?? null;
          // Regenerate: the old reply goes only once the new one is saved after it.
          if (replacing) await deleteMessage(auth.supabase, conversationId, replacing).catch((err) => reportError(err, { where: "chat.regenerate" }));
        } catch (err) {
          reportError(err, { where: "chat.addMessages" });
          send({ type: "notice", level: "warning", message: "The reply could not be saved to your history." });
        }
      }

      send({
        type: "done",
        text,
        model: { id: model.id, displayName: model.displayName, provider: model.provider },
        assistantMessageId,
        simulated: model.provider === "demo",
        usage,
        estimatedCost: estimateCost(model, usage),
      });
    }, req.signal);
  } catch (err) {
    // The request failed before any model ran: give back its reservation.
    if (caller) await releaseUsage(caller);
    return errorResponse(err);
  }
}
