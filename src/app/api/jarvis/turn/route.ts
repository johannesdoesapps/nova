import { NextResponse } from "next/server";
import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { estimateCost, estimateTokens } from "@/lib/ai/cost";
import { autoIdFor, isAutoId } from "@/lib/ai/platform";
import { withTimeContext } from "@/lib/ai/turn-context";
import type { ChatMessage, Usage } from "@/lib/ai/types";
import { requireUserIfConfigured } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import {
  callId,
  cleanSpeech,
  JARVIS_MODES,
  jsonRoundsText,
  MAX_ROUNDS,
  parseJsonReply,
  systemPrompt,
  toolConversation,
  turnRequest,
  vetCalls,
  type PlannedCall,
  type TraceRound,
} from "@/lib/jarvis/planner";
import { runServerTool } from "@/lib/jarvis/server-tools";
import { allSkills, findSkill } from "@/lib/jarvis/skills";
import { isServerTool, offeredTools, toolSpecs, type JarvisToolName } from "@/lib/jarvis/tools";
import { searchBackend } from "@/lib/search/live";
import { validTimeZone } from "@/lib/time/zones";
import { enforceLimits, planLimits, recordRunLater, shouldSaveAllowance } from "@/lib/usage";

export const maxDuration = 60;

const MAX_OUTPUT = 1500;
/** Model calls per request; between them, server tools run and their results go back to the model. */
const MAX_MODEL_CALLS = 3;
/** After this long, the next model call gets no more server tools, so it answers with what it has. */
const WRAP_UP_AFTER_MS = 30_000;

/**
 * POST /api/jarvis/turn — one Jarvis turn: what to say, and the actions the model proposes. Server tools (web
 * search, reading a page, calculator, time, memory, skills) run here, inside the turn, and the model continues with
 * their results. Browser and desktop actions don't run here: they're returned for the browser, which checks each
 * against the user's permission settings and runs it (desktop ones through the Desktop Agent). When their results
 * matter, the browser calls this again with them in `trace`, and the model continues from there.
 * Uses the plan's allowance like a chat message; every model call and search is recorded with its real usage.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, turnRequest, 250_000);
    const auth = await requireUserIfConfigured();
    const limits = await planLimits(auth);
    const skills = allSkills(body.skills);
    const picked = body.skill ? findSkill(body.skill, skills) : null;
    const search = searchBackend();
    const unavailable: JarvisToolName[] = [
      ...(!search || (search === "claude" && auth.mode !== "authenticated") ? (["web_search"] as const) : []),
      ...(auth.mode !== "authenticated" ? (["recall_memories", "remember"] as const) : []),
    ];
    const allOffered = body.answerOnly || body.trace.length >= MAX_ROUNDS ? [] : offeredTools(body.desktop.connected, unavailable);
    const requested = body.modelId ?? autoIdFor(JARVIS_MODES.find((m) => m.id === body.mode)!.router);
    const { model, routing } = await resolveModelChoice(requested, {
      prompt: body.message.slice(0, 4000),
      mode: body.mode === "developer" ? "coding" : undefined,
      preferLowCost: isAutoId(requested) ? await shouldSaveAllowance(auth) : false,
      tiers: limits.tiers,
    });
    if (model.provider === "demo") throw new ApiError("not_configured", "Jarvis needs a real AI model. An administrator can add one in Admin.");
    const provider = getProvider(model.provider);
    const canNative = (model.provider === "anthropic" || model.provider === "openai") && typeof provider.toolTurn === "function";
    const maxOutputTokens = Math.min(MAX_OUTPUT, limits.maxOutputTokens);
    const traceChars = body.trace.reduce((n, r) => n + r.say.length + r.results.reduce((m, x) => m + x.text.length, 0), 0);
    const inputChars = 6000 + body.message.length + body.history.reduce((n, h) => n + h.text.length, 0) + traceChars;
    await enforceLimits(req, auth, 1, [model], { requestId: body.requestId, purpose: "jarvis", inputTokens: Math.ceil(inputChars / 4) + 1500, maxOutputTokens });

    const timeZone = validTimeZone(body.timeZone ?? null);
    const signal = withTimeout(55_000, req.signal);
    const begun = performance.now();
    const rounds: TraceRound[] = [...body.trace];
    const activity: { tool: JarvisToolName; summary: string; ok: boolean }[] = [];
    const rejected: { tool: string; error: string }[] = [];
    let say = "";
    let clientCalls: PlannedCall[] = [];
    let pending: TraceRound | null = null;
    let total: Usage = { inputTokens: 0, outputTokens: 0, estimated: false };
    let cost = 0;

    for (let i = 0; i < MAX_MODEL_CALLS; i++) {
      const wrapUp = i === MAX_MODEL_CALLS - 1 || rounds.length >= MAX_ROUNDS - 1 || performance.now() - begun > WRAP_UP_AFTER_MS;
      // The last call gets no server tools, so it answers (or proposes actions) with what it has.
      const offered = wrapUp ? allOffered.filter((n) => !isServerTool(n)) : allOffered;
      const native = offered.length > 0 && canNative;
      const json = !native && offered.length > 0;
      const system = systemPrompt(body, offered, json, { all: skills, picked });
      const run = { model, prompt: "[jarvis]", purpose: "jarvis", requestedModel: requested, routingReason: routing?.reason ?? null, tools: [] as string[] };
      const started = performance.now();
      let text = "";
      let raw: { id?: string; name: unknown; args: unknown }[] = [];
      let usage: Usage | null = null;
      try {
        if (native) {
          const r = await provider.toolTurn!({ model, system, messages: toolConversation(body, rounds, skills), tools: toolSpecs(offered), maxOutputTokens, signal });
          text = r.text;
          raw = r.calls.map((c, k) => ({ id: callId(rounds.length, k), name: c.name, args: c.args }));
          usage = r.usage;
        } else {
          const messages: ChatMessage[] = withTimeContext(
            [
              { role: "system", content: system },
              ...body.history.map((h): ChatMessage => ({ role: h.role, content: h.text })),
              { role: "user", content: body.message },
              ...jsonRoundsText(rounds, skills).flatMap((r): ChatMessage[] => [
                { role: "assistant", content: r.assistant },
                { role: "user", content: r.user },
              ]),
            ],
            req,
          );
          for await (const ev of provider.stream({ model, messages, maxOutputTokens, signal })) {
            if (ev.type === "delta") text += ev.text;
            else if (ev.type === "usage") usage = ev.usage;
          }
          if (json) {
            const parsed = parseJsonReply(text);
            text = parsed.say;
            raw = parsed.raw.map((c, k) => ({ id: callId(rounds.length, k), ...c }));
          }
        }
      } catch (err) {
        recordRunLater(auth, {
          ...run,
          response: text,
          latencyMs: performance.now() - started,
          usage: usage ?? { inputTokens: Math.ceil(inputChars / 4), outputTokens: 0, estimated: true },
          status: "error",
          error: req.signal.aborted ? "cancelled" : err instanceof Error ? err.message : "failed",
        });
        // A later round that fails still has the earlier rounds' work to report.
        if (i > 0 && !req.signal.aborted) break;
        throw err;
      }
      usage ??= { inputTokens: Math.ceil(inputChars / 4), outputTokens: estimateTokens([{ role: "assistant", content: text }]), estimated: true };
      total = { inputTokens: (total.inputTokens ?? 0) + (usage.inputTokens ?? 0), outputTokens: (total.outputTokens ?? 0) + (usage.outputTokens ?? 0), estimated: total.estimated || !!usage.estimated };
      cost += estimateCost(model, usage) ?? 0;

      const vetted = vetCalls(raw, offered);
      rejected.push(...vetted.rejected);
      recordRunLater(auth, { ...run, tools: vetted.calls.map((c) => c.tool), response: JSON.stringify({ say: text.slice(0, 500), calls: vetted.calls.map((c) => c.tool) }), latencyMs: performance.now() - started, usage, status: "success" });
      say = text;
      if (!vetted.calls.length) break;

      // This round's calls, with results for the server tools; the browser fills in its own actions' results.
      const round: TraceRound = { say: text.slice(0, 2000), calls: vetted.calls.map((c) => ({ id: c.id!, tool: c.tool, args: c.args })), results: [] };
      for (const c of vetted.calls.filter((x) => isServerTool(x.tool))) {
        const r = await runServerTool(c.tool, c.args, { auth, skills, timeZone, signal });
        round.results.push({ id: c.id!, ok: r.ok, text: r.text.slice(0, 4000) });
        activity.push({ tool: c.tool, summary: r.summary, ok: r.ok });
      }
      const forBrowser = vetted.calls.filter((c) => !isServerTool(c.tool));
      if (forBrowser.length) {
        pending = round;
        clientCalls = forBrowser;
        break;
      }
      rounds.push(round);
    }

    say = cleanSpeech(say);
    if (!say && !clientCalls.length) {
      if (activity.length) say = "I looked into it but couldn't put an answer together. Try asking again, a little more specifically.";
      else throw new ApiError("upstream_error", "The model returned an empty reply. Try again.");
    }
    return NextResponse.json({
      say,
      calls: clientCalls,
      rejected,
      /** What Jarvis looked up on the server this turn, for the conversation. */
      activity,
      /** Present when actions are waiting in the browser: send it back, with their results, to continue. */
      trace: pending ? [...rounds, pending] : null,
      model: { id: model.id, displayName: model.displayName },
      usage: total,
      estimatedCost: cost,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
