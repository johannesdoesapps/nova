import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { estimateCost, estimateTokens } from "@/lib/ai/cost";
import { systemPromptFor } from "@/lib/ai/modes";
import { autoIdFor, isAutoId } from "@/lib/ai/platform";
import { withTimeContext } from "@/lib/ai/turn-context";
import type { ChatMessage, Usage } from "@/lib/ai/types";
import { requireUserIfConfigured } from "@/lib/auth";
import { ApiError, errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { enforceLimits, planLimits, recordRunLater, shouldSaveAllowance } from "@/lib/usage";
import { findWorkspaceTemplate, isWorkspaceKey, WORKSPACES } from "@/lib/workspaces/catalog";
import { findPrompt } from "@/lib/workspaces/prompts";
import { z } from "zod";

export const maxDuration = 60;

const body = z.object({
  /** A tool id in PROMPTS, or "template:<id>". */
  kind: z.string().min(1).max(80),
  input: z.string().trim().min(1).max(50_000),
  extra: z.string().trim().max(400).optional(),
  modelId: z.string().max(120).nullable().optional(),
  requestId: z.string().uuid().optional(),
});

/**
 * POST /api/workspaces/[workspace]/generate — one metered model call for a workspace AI tool or a template draft,
 * streamed as NDJSON (meta → delta… → done | error). Used by the Cybersecurity and Website Builder tool panels.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/workspaces/[workspace]/generate">) {
  try {
    const ws = (await ctx.params).workspace;
    if (!isWorkspaceKey(ws)) throw new ApiError("not_found", "Unknown workspace.");
    const b = await parseJsonBody(req, body, 80_000);
    const auth = await requireUserIfConfigured();
    if (!limiter("workspace-generate", 30, 60_000).check(auth.mode === "authenticated" ? `u:${auth.user.id}` : `ip:${req.headers.get("x-forwarded-for") ?? "?"}`, 1).ok)
      throw new ApiError("rate_limited", "Too many requests. Please wait a moment.");

    // Build the system and user prompts from either a tool prompt or a template.
    let mode: "coding" | "research" | "general" = "general";
    let system: string;
    let user: string;
    if (b.kind.startsWith("template:")) {
      const tpl = findWorkspaceTemplate(ws, b.kind.slice("template:".length));
      if (!tpl) throw new ApiError("not_found", "Unknown template.");
      mode = ws === "web" ? "coding" : "general";
      const guard =
        ws === "cyber"
          ? "You are a defensive security assistant; give general guidance, not legal advice, and don't invent CVEs or statistics."
          : "You write accessible, responsive, fast websites; use clearly marked placeholders for anything you don't know.";
      system = `${guard} You produce a polished "${tpl.name}" (${tpl.description}). Use clear Markdown with headings and fill in what the user provides; mark anything unknown as a placeholder in [brackets].`;
      user = `Create a ${tpl.name} from this brief:\n\n<brief>\n${b.input}\n</brief>${b.extra ? `\n\nExtra: ${b.extra}` : ""}`;
    } else {
      const p = findPrompt(ws, b.kind);
      if (!p) throw new ApiError("not_found", "Unknown tool.");
      mode = p.mode;
      system = p.system;
      user = p.user(b.input, b.extra ?? "");
    }

    const limits = await planLimits(auth);
    const requested = b.modelId ?? autoIdFor(mode === "coding" ? "coding" : mode === "research" ? "research" : "balanced");
    const { model, routing } = await resolveModelChoice(requested, {
      prompt: user.slice(0, 4000),
      mode,
      preferLowCost: isAutoId(requested) ? await shouldSaveAllowance(auth) : false,
      tiers: limits.tiers,
    });
    if (model.provider === "demo") throw new ApiError("not_configured", "This tool needs a real AI model. An administrator can add one in Admin.");
    const maxOutputTokens = Math.min(4000, limits.maxOutputTokens);
    await enforceLimits(req, auth, 1, [model], { requestId: b.requestId, purpose: "workspace", inputTokens: Math.ceil(user.length / 4) + 800, maxOutputTokens });

    return ndjsonStream(async (send, signal) => {
      send({ type: "meta", model: { id: model.id, displayName: model.displayName, provider: model.provider }, routing });
      const messages: ChatMessage[] = withTimeContext(
        [
          { role: "system", content: `${systemPromptFor(mode === "general" ? "analyst" : mode)}\n\n${system}\n\nYou are a tool in the Orbis ${WORKSPACES[ws].label} workspace.` },
          { role: "user", content: user },
        ],
        req,
      );
      const started = performance.now();
      const run = { model, prompt: `[workspace ${ws}/${b.kind}]`, purpose: "workspace", requestedModel: requested, routingReason: routing?.reason ?? null, tools: [] as string[] };
      let text = "";
      let usage: Usage | null = null;
      try {
        for await (const ev of getProvider(model.provider).stream({ model, messages, maxOutputTokens, signal: withTimeout(55_000, signal) })) {
          if (ev.type === "delta") {
            text += ev.text;
            send({ type: "delta", text: ev.text });
          } else if (ev.type === "usage") usage = ev.usage;
        }
      } catch (err) {
        recordRunLater(auth, { ...run, response: text, latencyMs: performance.now() - started, usage: usage ?? { inputTokens: estimateTokens(messages), outputTokens: estimateTokens(text), estimated: true }, status: "error", error: signal.aborted ? "cancelled" : err instanceof Error ? err.message : "failed" });
        throw err;
      }
      if (!text.trim()) throw new ApiError("upstream_error", "The model returned an empty reply. Try again or choose another model.");
      usage ??= { inputTokens: estimateTokens(messages), outputTokens: estimateTokens(text), estimated: true };
      recordRunLater(auth, { ...run, response: text, latencyMs: performance.now() - started, usage, status: "success" });
      send({ type: "done", text, usage, estimatedCost: estimateCost(model, usage) });
    }, req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}
