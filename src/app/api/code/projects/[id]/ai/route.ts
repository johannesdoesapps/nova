import { NextResponse } from "next/server";
import { z } from "zod";
import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { autoIdFor } from "@/lib/ai/platform";
import { applyAiEdits, EDITOR_SYSTEM_PROMPT, editorUserMessage, parseEditorReply, pickContext } from "@/lib/code/ai-edits";
import { codeContext, getFiles, getProjectRow } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { enforceLimits, planLimits, recordRunLater, releaseUsage } from "@/lib/usage";

export const maxDuration = 120;

const body = z.object({
  instruction: z.string().trim().min(1).max(8_000),
  activePath: z.string().max(300).nullable().optional(),
  modelId: z.string().max(120).nullable().optional(),
  requestId: z.string().uuid().optional(),
});

/**
 * POST /api/code/projects/[id]/ai — ask the AI to change the project. Returns
 * proposed changes (before/after per file) for the user to accept or reject;
 * nothing is saved here. Counted like a chat message on the user's plan.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/projects/[id]/ai">) {
  try {
    const auth = await codeContext("code-ai", 20);
    const id = requireUuid((await ctx.params).id);
    const input = await parseJsonBody(req, body, 20_000);
    await getProjectRow(auth, id);
    const files = await getFiles(auth, id);
    const limits = await planLimits(auth);
    const choice = await resolveModelChoice(input.modelId ?? autoIdFor("coding"), { prompt: input.instruction, mode: "coding", tiers: limits.tiers });
    const model = choice.model;
    if (model.provider === "demo") throw new ApiError("not_configured", "No AI model is set up on this site, so the AI editor can't run.");

    const activePath = input.activePath && files.some((f) => f.path === input.activePath) ? input.activePath : null;
    const { shown, hidden } = pickContext(files, input.instruction, activePath, Math.max(12_000, limits.historyChars));
    const messages = [
      { role: "system" as const, content: EDITOR_SYSTEM_PROMPT },
      { role: "user" as const, content: editorUserMessage(input.instruction, shown, hidden, activePath) },
    ];
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    await enforceLimits(req, auth, 1, [model], {
      requestId: input.requestId,
      purpose: "code_ai",
      inputTokens: Math.ceil(promptChars / 4) + 200,
      maxOutputTokens: limits.maxOutputTokens,
    });

    const started = performance.now();
    let text: string;
    try {
      const r = await getProvider(model.provider).generate({ model, messages, maxOutputTokens: limits.maxOutputTokens, temperature: 0.2, signal: withTimeout(100_000, req.signal) });
      text = r.text;
      recordRunLater(auth, {
        model,
        prompt: `[code editor] ${input.instruction.slice(0, 500)}`,
        response: r.text.slice(0, 2000),
        latencyMs: performance.now() - started,
        usage: r.usage,
        status: "success",
        purpose: "code_ai",
        category: "coding",
        servedModel: r.servedModel ?? null,
        requestedModel: input.modelId ?? "auto:coding",
        routingReason: choice.routing?.reason ?? "Chosen by the user.",
      });
    } catch (err) {
      await releaseUsage(auth);
      if (req.signal.aborted) throw new ApiError("bad_request", "Cancelled.");
      reportError(err, { where: "code.ai" });
      throw new ApiError("upstream_error", `${model.displayName} didn't answer. This request wasn't counted. Please try again.`);
    }

    const parsed = parseEditorReply(text);
    if (!parsed.ok) {
      return NextResponse.json({
        ok: false,
        model: model.displayName,
        message: `${parsed.error} Try asking for a smaller change, or one file at a time.`,
        changes: [],
      });
    }
    const applied = applyAiEdits(files, parsed.data.edits);
    if (!applied.ok) {
      return NextResponse.json({
        ok: false,
        model: model.displayName,
        summary: parsed.data.summary,
        message: `The AI's changes didn't fit your files, so none were made: ${applied.errors.slice(0, 4).join(" ")} Try again, or describe the change more precisely.`,
        changes: [],
      });
    }
    return NextResponse.json({ ok: true, model: model.displayName, summary: parsed.data.summary, changes: applied.changes });
  } catch (err) {
    return errorResponse(err);
  }
}
