/**
 * Trusted context shared by every chat and agent turn: the time context and
 * time-tool results for this message, and an honest note when the message
 * asks for live information that no tool fetched. Built fresh per request.
 */
import { timeContext, timePrompt } from "../time/context";

/** A tool NOVA ran on the server for this turn, as shown under the reply. */
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
      label: `Checked NOVA's clock · ${ctx.timeZone ?? "UTC"}`,
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
