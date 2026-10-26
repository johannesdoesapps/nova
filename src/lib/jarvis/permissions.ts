import { TOOLS, type JarvisToolName, type RiskClass } from "./tools";

/**
 * Jarvis Mode's permission rules: what may run straight away, what needs the user's approval first, and what is
 * refused. The user chooses an autonomy level; some limits apply at every level.
 *
 * 1 Observe: only looks (folders the user allowed, system information); everything else is refused.
 * 2 Assist: looks freely; every action is shown for approval first.
 * 3 Supervised: opens apps, pages and files freely; changes, private reads and spending need approval.
 * 4 Trusted: also makes single reversible file changes and private reads; spending, and batches larger than the
 *   limit, still need approval.
 *
 * At every level: nothing runs while automation is stopped, desktop tools need the Desktop Agent, and there is no
 * level that skips these rules.
 */

export type Autonomy = 1 | 2 | 3 | 4;

export const AUTONOMY_LEVELS: { level: Autonomy; name: string; text: string }[] = [
  { level: 1, name: "Observe", text: "Looks only. Recommends, but makes no changes and opens nothing." },
  { level: 2, name: "Assist", text: "Prepares every action and waits for your approval." },
  { level: 3, name: "Supervised", text: "Opens apps, pages and files on its own; asks before changing files, reading private content or spending allowance." },
  { level: 4, name: "Trusted", text: "Also makes single, reversible file changes on its own. Still asks before spending allowance or large batches." },
];

/** The largest batch (e.g. files moved at once) that level 4 may apply without asking. */
export const TRUSTED_BATCH_LIMIT = 25;

export type Decision = { kind: "allow"; reason: string } | { kind: "confirm"; reason: string } | { kind: "deny"; reason: string };

export interface DecisionContext {
  autonomy: Autonomy;
  /** The Desktop Agent is connected and paired. */
  desktopConnected: boolean;
  /** Emergency stop is on. */
  halted: boolean;
  /** How many changes a batch tool would make, once known. */
  batchSize?: number;
}

const ALLOWED_AT: Record<RiskClass, Autonomy | null> = { read: 1, act: 3, private: 4, write: 4, spend: null };
const NEEDS_APPROVAL: Record<RiskClass, string> = {
  read: "It only looks.",
  act: "It opens something on your computer or in your browser.",
  private: "It reads private content (your clipboard or screen).",
  write: "It changes files (reversibly; nothing is deleted).",
  spend: "It uses your plan's allowance or stores something with Orbis.",
};

export function decide(name: JarvisToolName, ctx: DecisionContext): Decision {
  const tool = TOOLS[name];
  if (ctx.halted) return { kind: "deny", reason: "Automation is stopped. Resume it before Jarvis acts again." };
  if (tool.runner === "desktop" && !ctx.desktopConnected) return { kind: "deny", reason: "The Orbis Desktop Agent isn't connected, so Jarvis can't reach your computer." };
  if (ctx.autonomy === 1 && tool.risk !== "read") return { kind: "deny", reason: "Autonomy is set to Observe: Jarvis only looks and makes no changes." };

  const auto = ALLOWED_AT[tool.risk];
  if (tool.batch && (ctx.batchSize === undefined || ctx.batchSize > TRUSTED_BATCH_LIMIT || ctx.autonomy < 4))
    return { kind: "confirm", reason: `${NEEDS_APPROVAL[tool.risk]} Review the full list first.` };
  if (auto !== null && ctx.autonomy >= auto) return { kind: "allow", reason: NEEDS_APPROVAL[tool.risk] };
  return { kind: "confirm", reason: NEEDS_APPROVAL[tool.risk] };
}

export function isAutonomy(v: unknown): v is Autonomy {
  return v === 1 || v === 2 || v === 3 || v === 4;
}
