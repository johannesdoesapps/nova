import { NextResponse } from "next/server";
import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { estimateCost, estimateTokens } from "@/lib/ai/cost";
import { autoIdFor, isAutoId } from "@/lib/ai/platform";
import { withTimeContext } from "@/lib/ai/turn-context";
import type { ChatMessage, ToolMessage, Usage } from "@/lib/ai/types";
import { requireUserIfConfigured } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { cleanSpeech, JARVIS_MODES, parseJsonReply, systemPrompt, turnRequest, vetCalls } from "@/lib/jarvis/planner";
import { offeredTools, toolSpecs } from "@/lib/jarvis/tools";
import { enforceLimits, planLimits, recordRunLater, shouldSaveAllowance } from "@/lib/usage";

export const maxDuration = 60;

const MAX_OUTPUT = 1500;

/**
 * POST /api/jarvis/turn — one Jarvis turn: what to say, and the tool calls the model proposes. Nothing runs here;
 * the browser checks each call against the user's permission settings and runs it (desktop calls through the
 * Desktop Agent). Uses the plan's allowance like a chat message.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, turnRequest, 100_000);
    const auth = await requireUserIfConfigured();
    const limits = await planLimits(auth);
    const offered = body.answerOnly ? [] : offeredTools(body.desktop.connected);
    const requested = body.modelId ?? autoIdFor(JARVIS_MODES.find((m) => m.id === body.mode)!.router);
    const { model, routing } = await resolveModelChoice(requested, {
      prompt: body.message.slice(0, 4000),
      mode: body.mode === "developer" ? "coding" : undefined,
      preferLowCost: isAutoId(requested) ? await shouldSaveAllowance(auth) : false,
      tiers: limits.tiers,
    });
    if (model.provider === "demo") throw new ApiError("not_configured", "Jarvis needs a real AI model. An administrator can add one in Admin.");
    const provider = getProvider(model.provider);
    const native = offered.length > 0 && (model.provider === "anthropic" || model.provider === "openai") && typeof provider.toolTurn === "function";
    // Without tools (answer only), the reply is plain speech; with tools but no native tool calling, it's JSON.
    const json = !native && offered.length > 0;
    const maxOutputTokens = Math.min(MAX_OUTPUT, limits.maxOutputTokens);
    const system = systemPrompt(body, offered, json);
    const inputChars = system.length + body.message.length + body.history.reduce((n, h) => n + h.text.length, 0);
    await enforceLimits(req, auth, 1, [model], { requestId: body.requestId, purpose: "jarvis", inputTokens: Math.ceil(inputChars / 4) + 500, maxOutputTokens });

    const started = performance.now();
    const run = { model, prompt: "[jarvis]", purpose: "jarvis", requestedModel: requested, routingReason: routing?.reason ?? null, tools: [] as string[] };
    let say = "";
    let raw: { name: unknown; args: unknown }[] = [];
    let usage: Usage | null = null;
    const signal = withTimeout(50_000, req.signal);
    try {
      if (native) {
        const messages: ToolMessage[] = [
          ...body.history.map((h): ToolMessage => (h.role === "user" ? { role: "user", text: h.text } : { role: "assistant", text: h.text })),
          { role: "user", text: body.message },
        ];
        // The provider needs the conversation to start with the user.
        while (messages.length && messages[0]!.role !== "user") messages.shift();
        const r = await provider.toolTurn!({ model, system, messages, tools: toolSpecs(offered), maxOutputTokens, signal });
        say = r.text;
        raw = r.calls.map((c) => ({ name: c.name, args: c.args }));
        usage = r.usage;
      } else {
        const messages: ChatMessage[] = withTimeContext(
          [{ role: "system", content: system }, ...body.history.map((h): ChatMessage => ({ role: h.role, content: h.text })), { role: "user", content: body.message }],
          req,
        );
        let text = "";
        for await (const ev of provider.stream({ model, messages, maxOutputTokens, signal })) {
          if (ev.type === "delta") text += ev.text;
          else if (ev.type === "usage") usage = ev.usage;
        }
        if (json) ({ say, raw } = parseJsonReply(text));
        else say = text;
      }
    } catch (err) {
      recordRunLater(auth, {
        ...run,
        response: say,
        latencyMs: performance.now() - started,
        usage: usage ?? { inputTokens: Math.ceil(inputChars / 4), outputTokens: 0, estimated: true },
        status: "error",
        error: req.signal.aborted ? "cancelled" : err instanceof Error ? err.message : "failed",
      });
      throw err;
    }
    const { calls, rejected } = vetCalls(raw, offered);
    say = cleanSpeech(say);
    if (!say && !calls.length) throw new ApiError("upstream_error", "The model returned an empty reply. Try again.");
    usage ??= { inputTokens: Math.ceil(inputChars / 4), outputTokens: estimateTokens([{ role: "assistant", content: say }]), estimated: true };
    recordRunLater(auth, { ...run, tools: calls.map((c) => c.tool), response: JSON.stringify({ say, calls: calls.map((c) => c.tool) }), latencyMs: performance.now() - started, usage, status: "success" });
    return NextResponse.json({
      say,
      calls,
      rejected,
      model: { id: model.id, displayName: model.displayName },
      usage,
      estimatedCost: estimateCost(model, usage),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
