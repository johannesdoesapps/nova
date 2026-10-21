import { z } from "zod";

/**
 * Project memory: what the agent should know about a project before it
 * works on it. Notes are written by the user, or suggested by the agent and
 * used only once the user approves them. Shared by the API, the agent and
 * the Memory panel (no server code here).
 */

export const MEMORY_KINDS = ["instruction", "architecture", "decision", "preference", "workflow"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_KIND_LABELS: Record<MemoryKind, { label: string; hint: string }> = {
  instruction: { label: "Instruction", hint: "Rules for every task in this project, e.g. “Run npm test before finishing”." },
  architecture: { label: "Architecture", hint: "How the project is put together: folders, data flow, key modules." },
  decision: { label: "Decision", hint: "Something decided and why, so it isn't undone later." },
  preference: { label: "Preference", hint: "How you like things done: style, naming, libraries." },
  workflow: { label: "Workflow", hint: "Steps you ask for often; start them from the Memory panel." },
};

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  /** Given to the agent on every task. */
  always: boolean;
  status: "active" | "proposed";
  source: "user" | "agent";
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const MEMORY_LIMIT = 100;
export const MAX_CONTENT = 4000;

const title = z.string().trim().min(1).max(120);
const content = z.string().trim().min(1).max(MAX_CONTENT);

export const memoryInput = z.object({ kind: z.enum(MEMORY_KINDS), title, content, always: z.boolean().optional() }).strict();
export const memoryPatch = z
  .object({ kind: z.enum(MEMORY_KINDS).optional(), title: title.optional(), content: content.optional(), always: z.boolean().optional(), status: z.literal("active").optional() })
  .strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update.");

/** What the agent may suggest remembering (it can't mark anything "always"; the user decides that). */
export const memoryProposal = z.object({ kind: z.enum(MEMORY_KINDS), title, content, reason: z.string().trim().min(1).max(500).describe("Why this is worth remembering for future tasks.") });

// ---------------------------------------------------------------- choosing what a task needs

const STOP = new Set(
  "the and for with that this from into your you are was were have has had not but all any can our out use using when then than them they its it's also only each per via about should would could please make sure add fix update change file files code project new".split(
    " ",
  ),
);

/** Words worth matching on: lower-case, 3+ letters, common words left out. */
export function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? [])].map((w) => w.replace(/[.-]+$/, "")).filter((w) => w.length > 2 && !STOP.has(w));
}

/** How well a note matches a task: shared words, title words counting double. */
export function relevance(entry: Pick<MemoryEntry, "title" | "content">, taskTerms: string[]): number {
  if (!taskTerms.length) return 0;
  const t = new Set(terms(entry.title));
  const c = new Set(terms(entry.content));
  let score = 0;
  for (const w of taskTerms) score += (t.has(w) ? 2 : 0) + (c.has(w) ? 1 : 0);
  return score;
}

export const MEMORY_BUDGET = 6_000;

/**
 * The notes to give the agent for a task: approved ones only; instructions and
 * "always" notes first, then the rest by relevance to the request (notes that
 * share no words with it are left out — the agent can search for them). Stays
 * within a character budget so memory never crowds out the project itself.
 */
export function selectMemory(entries: MemoryEntry[], request: string, budget = MEMORY_BUDGET): MemoryEntry[] {
  const active = entries.filter((e) => e.status === "active");
  const q = terms(request);
  const always = active.filter((e) => e.always || e.kind === "instruction").sort((a, b) => Number(b.always) - Number(a.always) || b.updatedAt.localeCompare(a.updatedAt));
  const rest = active
    .filter((e) => !e.always && e.kind !== "instruction")
    .map((e) => ({ e, s: relevance(e, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.e.updatedAt.localeCompare(a.e.updatedAt))
    .map((x) => x.e);
  const out: MemoryEntry[] = [];
  let used = 0;
  for (const e of [...always, ...rest]) {
    const size = e.title.length + e.content.length + 40;
    if (used + size > budget) continue;
    out.push(e);
    used += size;
  }
  return out;
}

/** The notes as the agent sees them in the task's first message. */
export function memoryBlock(selected: MemoryEntry[], total: number): string {
  if (!selected.length) return total ? `Project memory: ${total} note${total === 1 ? "" : "s"} saved, none matched this request (search_memory finds them).` : "";
  const lines = selected.map((e) => `- [${MEMORY_KIND_LABELS[e.kind].label}] ${e.title}: ${e.content.replace(/\s*\n\s*/g, " / ")}`);
  const more = total > selected.length ? `\n(${total - selected.length} more saved; search_memory finds them.)` : "";
  return `Project memory (written or approved by the user for this project; follow it unless this request says otherwise):\n${lines.join("\n")}${more}`;
}

/** Notes matching a search, for the agent's search_memory tool. */
export function searchMemory(entries: MemoryEntry[], query: string, limit = 8): MemoryEntry[] {
  const q = terms(query);
  const needle = query.trim().toLowerCase();
  return entries
    .filter((e) => e.status === "active")
    .map((e) => ({ e, s: relevance(e, q) + (needle && `${e.title}\n${e.content}`.toLowerCase().includes(needle) ? 3 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e);
}

/** A workflow as a request for the agent. */
export function workflowRequest(e: Pick<MemoryEntry, "title" | "content">): string {
  return `${e.title}\n\n${e.content}`;
}
