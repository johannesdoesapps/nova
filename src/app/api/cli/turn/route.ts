import { NextResponse } from "next/server";
import { z } from "zod";
import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { autoIdFor } from "@/lib/ai/platform";
import type { ToolMessage, ToolSpec } from "@/lib/ai/types";
import { agentSuspended } from "@/lib/bastion/server";
import { requireCliUser } from "@/lib/cli-auth";
import { AGENT_OUTPUT_TOKENS, usesNativeTools } from "@/lib/code/agent/engine";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { enforceLimits, planLimits, recordRunLater, releaseUsage } from "@/lib/usage";

export const maxDuration = 300;

/** The terminal app's agent counts as Orbis Code's coding agent for Bastion (suspending one suspends both). */
const CLI_AGENT = "engineer";
const MAX_BODY = 1_500_000;
const MODEL_TIMEOUT_MS = 240_000;

const text = (max: number) => z.string().max(max);
const toolResult = z.object({ id: z.string().min(1).max(200), ok: z.boolean(), text: text(200_000) });
const toolCall = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(128), args: z.record(z.string(), z.unknown()).nullable() });
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), text: text(400_000), results: z.array(toolResult).max(64).optional() }),
  z.object({ role: z.literal("assistant"), text: text(400_000), calls: z.array(toolCall).max(64).optional() }),
]);
const tool = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Tool names are letters, digits, _ and - (at most 64)."),
  description: text(8_000),
  parameters: z.record(z.string(), z.unknown()),
});
const body = z.object({
  model: z.string().min(1).max(120).nullable().optional(),
  system: text(200_000),
  messages: z.array(message).min(1).max(4_000),
  tools: z.array(tool).min(1).max(64),
  maxOutputTokens: z.number().int().min(256).max(64_000).optional(),
});

/** The text of the conversation's last user message, for Auto's routing. */
function lastUserText(messages: ToolMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && m.text.trim()) return m.text.slice(0, 4_000);
  }
  return "";
}

/**
 * POST /api/cli/turn — one model turn for the Orbis terminal app. The agent loop and its tools run on the user's
 * computer; this route only calls the model, with the same model choice, plan limits and metering as an Orbis Code
 * step (enforceLimits before, recordRunLater after, releaseUsage when the call fails).
 */
export async function POST(req: Request) {
  try {
    const auth = await requireCliUser(req, "cli-turn", 60);
    const b = await parseJsonBody(req, body, MAX_BODY);
    const names = new Set(b.tools.map((t) => t.name));
    if (names.size !== b.tools.length) throw new ApiError("bad_request", "Tool names must be unique.");

    // Orbis Bastion: a suspended or paused coding agent doesn't run here either.
    const suspended = await agentSuspended(CLI_AGENT, { db: auth.supabase, ownerId: auth.user.id });
    if (suspended) throw new ApiError(suspended.kind === "unavailable" ? "provider_unavailable" : "forbidden", `Stopped by Orbis Bastion: ${suspended.message}`);

    const limits = await planLimits(auth);
    const messages = b.messages as ToolMessage[];
    const tools = b.tools as ToolSpec[];
    const choice = await resolveModelChoice(b.model ?? autoIdFor("coding"), { prompt: lastUserText(messages), mode: "coding", tiers: limits.tiers });
    const model = choice.model;
    if (model.provider === "demo") throw new ApiError("not_configured", "No AI model is set up on this site, so the agent can't run.");
    if (!usesNativeTools(model)) throw new ApiError("bad_request", `${model.displayName} can't call tools, which the terminal app needs. Choose another model with /model.`);

    const maxOutputTokens = Math.min(b.maxOutputTokens ?? AGENT_OUTPUT_TOKENS, Math.max(limits.maxOutputTokens, AGENT_OUTPUT_TOKENS));
    const promptChars = b.system.length + JSON.stringify(messages).length + JSON.stringify(tools).length;
    await enforceLimits(req, auth, 1, [model], { purpose: "code_agent", inputTokens: Math.ceil(promptChars / 3.5) + 200, maxOutputTokens });

    const started = performance.now();
    let r;
    try {
      r = await getProvider(model.provider).toolTurn!({ model, system: b.system, messages, tools, maxOutputTokens, signal: withTimeout(MODEL_TIMEOUT_MS, req.signal) });
    } catch (err) {
      await releaseUsage(auth);
      reportError(err, { where: "cli.turn.model" });
      // Provider messages from ApiError are already safe to show; anything else gets a generic one.
      if (err instanceof ApiError) throw err;
      throw new ApiError("upstream_error", `${model.displayName} didn't answer. This turn wasn't counted; try again.`);
    }
    recordRunLater(auth, {
      model,
      prompt: `[orbis cli] ${lastUserText(messages).slice(0, 400)}`,
      response: `${r.text}\n${JSON.stringify(r.calls)}`.slice(0, 2000),
      latencyMs: performance.now() - started,
      usage: r.usage,
      status: "success",
      purpose: "code_agent",
      category: "coding",
      servedModel: r.servedModel,
      requestedModel: b.model ?? "auto:coding",
      routingReason: choice.routing?.reason ?? "Chosen by the user.",
      tools: [],
    });
    return NextResponse.json({ text: r.text, calls: r.calls, usage: r.usage, stop: r.stop, model: model.displayName, modelId: model.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
