import { getProvider, resolveModel, withTimeout } from "@/lib/ai";
import { estimateCost, estimateTokens } from "@/lib/ai/cost";
import type { Usage } from "@/lib/ai/types";
import { requireUserIfConfigured } from "@/lib/auth";
import { saveSearchSession } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { ApiError, errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { buildSearchMessages, splitFollowUps, stripInvalidCitations, usedCitations } from "@/lib/search/grounding";
import type { SearchSource } from "@/lib/search/types";
import { webSearch } from "@/lib/search/web";
import { enforceLimits, planLimits, recordRun } from "@/lib/usage";
import { searchRequest } from "@/lib/validation";
import { withTimeContext } from "@/lib/ai/turn-context";

export const maxDuration = 60;

/**
 * POST /api/search — web search + grounded answer, streamed as NDJSON events:
 *   {type:"meta"} {type:"sources"} {type:"notice"} {type:"delta"} {type:"done"} | {type:"error"}
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, searchRequest, 48_000);
    const auth = await requireUserIfConfigured();
    const model = await resolveModel(body.modelId);
    await enforceLimits(req, auth, 1, [model], { purpose: "search", inputTokens: 4000 });
    // Signed-in plans have a monthly number of searches (guest demo mode has its own per-IP limits).
    const searchesLeft = auth.mode === "authenticated" ? (await planLimits(auth)).webSearchesLeft : null;
    const env = serverEnv();

    return ndjsonStream(async (send, signal) => {
      send({ type: "meta", model: { id: model.id, displayName: model.displayName, provider: model.provider } });

      // 1. Retrieve evidence. Failure is reported honestly, never papered over.
      let sources: SearchSource[] = [];
      let searchProvider: string | null = null;
      if (searchesLeft === 0) {
        send({ type: "notice", level: "warning", code: "quota_exceeded", message: "Your plan's web searches for this month are used up, so this answer is not grounded in live sources." });
      } else try {
        const result = await webSearch(
          body.query,
          { provider: env.searchProvider, apiKey: env.searchKey },
          withTimeout(15_000, signal),
        );
        sources = result.sources;
        searchProvider = result.provider;
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : "Web search failed.";
        send({
          type: "notice",
          level: "warning",
          code: err instanceof ApiError ? err.code : "upstream_error",
          message: `Reliable web evidence could not be retrieved (${msg}) The answer below is not grounded in live sources.`,
        });
      }
      send({ type: "sources", provider: searchProvider, sources });
      if (searchProvider && sources.length === 0) {
        send({ type: "notice", level: "warning", code: "no_results", message: "The search returned no usable sources for this query." });
      }

      // 2. Generate a grounded answer.
      const messages = withTimeContext(buildSearchMessages(body.query, sources, body.history), req);
      const provider = getProvider(model.provider);
      const started = performance.now();
      let raw = "";
      let usage: Usage | null = null;
      let servedModel: string | null = null;
      let status: "success" | "error" = "success";
      try {
        for await (const ev of provider.stream({
          model,
          messages,
          maxOutputTokens: 1600,
          temperature: 0.2,
          signal: withTimeout(45_000, signal),
        })) {
          if (ev.type === "delta") {
            raw += ev.text;
            send({ type: "delta", text: ev.text });
          } else if (ev.type === "usage") usage = ev.usage;
          else if (ev.type === "served") servedModel = ev.servedModel;
        }
      } catch (err) {
        status = "error";
        throw err;
      } finally {
        const latencyMs = performance.now() - started;
        usage ??= { inputTokens: estimateTokens(messages), outputTokens: estimateTokens(raw), estimated: true };
        // The search is billed and counted against the plan's monthly searches.
        await recordRun(auth, { model, prompt: body.query, response: raw, latencyMs, usage, status, purpose: "search", category: "research", servedModel, tools: searchProvider ? ["web_search"] : [] });
      }

      const cleaned = stripInvalidCitations(raw, sources);
      const { body: answer, followUps } = splitFollowUps(cleaned);
      const cited = usedCitations(answer, sources);

      let searchId: string | null = null;
      if (auth.mode === "authenticated") {
        try {
          searchId = await saveSearchSession(auth.supabase, auth.user.id, {
            query: body.query,
            answer,
            modelId: model.id,
            projectId: body.projectId,
            sources,
          });
        } catch (err) {
          reportError(err, { where: "saveSearchSession" });
        }
      }

      send({
        type: "done",
        answer,
        followUps,
        citedSources: cited,
        uncitedSources: sources.map((s) => s.index).filter((i) => !cited.includes(i)),
        grounded: sources.length > 0 && cited.length > 0,
        simulated: model.provider === "demo",
        usage,
        estimatedCost: usage ? estimateCost(model, usage) : null,
        searchId,
      });
    }, req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}
