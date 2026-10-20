/**
 * Trusted context shared by every chat and agent turn: the time context and
 * time-tool results for this message, and an honest note when the message
 * asks for live information that no tool fetched. Built fresh per request.
 */
import { timeContext, timePrompt, timeSystemBlock } from "../time/context";
import type { ChatMessage } from "./types";

/** A tool Orbis ran on the server for this turn, as shown under the reply. */
export interface TurnTool {
  name: string;
  label: string;
  status: "ok" | "error";
  detail?: string;
}

const LIVE_INFO =
  /\b(latest|breaking|news|headlines?|weather|forecast|temperature outside|score|scores|results? of (?:the )?(?:game|match|election)|stock price|share price|exchange rate|bitcoin price|price of|currently|right now|this week|recent(?:ly)?|just released|new release|who won|is .* open)\b/i;

/** Whether a message asks about things that change over time (news, weather, prices, scores…). */
export function needsLiveInfo(message: string): boolean {
  return LIVE_INFO.test(message);
}

export interface TurnContext {
  /** Text appended to the system prompt. */
  system: string;
  tools: TurnTool[];
}

export function buildTurnContext(message: string, opts: { timeZone?: string | null; now?: Date; liveSources: boolean }): TurnContext {
  const ctx = timeContext(opts.timeZone, opts.now);
  const time = timePrompt(message, ctx);
  const parts = [time.system];
  const tools: TurnTool[] = [];
  if (time.calls.length) {
    tools.push({
      name: "time",
      label: `Checked Orbis's clock · ${ctx.timeZone ?? "UTC"}`,
      status: "ok",
      detail: time.calls.map((c) => `${c.call} → ${c.result}`).join("\n"),
    });
  }
  if (!opts.liveSources && needsLiveInfo(message)) {
    parts.push(
      "Live data: no web search or live data tool ran for this message. If the answer depends on current events, prices, weather, scores or recent releases, say you can't check live information here, give what you know with its likely date, and suggest where to check. Never present remembered information as current.",
    );
  }
  return { system: parts.join("\n\n"), tools };
}

/** The user's time zone as their browser reported it (body field first, then the X-NOVA-Time-Zone header). */
export function requestTimeZone(req: Request, bodyTimeZone?: string | null): string | null {
  return bodyTimeZone ?? req.headers.get("x-nova-time-zone");
}

/**
 * Add trusted time context to a feature's own prompt (Council, Arena, Mission
 * Control, search answers…), so every model call knows today's date. Appended
 * to the first system message, or added as one.
 */
export function withTimeContext(messages: ChatMessage[], req: Request, now?: Date): ChatMessage[] {
  const block = timeSystemBlock(timeContext(requestTimeZone(req), now));
  const i = messages.findIndex((m) => m.role === "system");
  if (i === -1) return [{ role: "system", content: block }, ...messages];
  return messages.map((m, j) => (j === i ? { ...m, content: `${m.content}\n\n${block}` } : m));
}
