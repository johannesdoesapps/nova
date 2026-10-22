import type { ChatMode } from "./ai/modes";
import { AUTO_MODEL_ID, ROUTER_MODES, type RouterMode } from "./ai/router-modes";

/**
 * The first-run starter: "What do you want to accomplish?" Each task suggests
 * a chat setup (mode, Auto routing preference, web sources) or a workspace,
 * says why in a sentence, and offers example prompts to start from. Nothing
 * here is applied until the user picks a task, and everything stays
 * changeable in the prompt box.
 */

export type StarterTaskId = "research" | "writing" | "coding" | "planning" | "compare" | "chat";

export interface StarterExample {
  label: string;
  /** send: ask now; draft: fill the box to finish; link: open a page. */
  action: "send" | "draft" | "link";
  prompt?: string;
  href?: string;
  /** A different chat mode for this example only (e.g. Critic for feedback on a draft). */
  mode?: ChatMode;
  /** Special: Home builds "Plan my day" from the user's day. */
  special?: "plan-day";
  /** Open the file picker after filling the box. */
  attach?: boolean;
}

export interface StarterTask {
  id: StarterTaskId;
  label: string;
  /** Under the label when chosen: what this is for. */
  short: string;
  /** The chat setup suggested; null when a workspace fits better than chat. */
  setup: { mode: ChatMode; router: RouterMode; web: boolean } | null;
  /** One sentence: why this setup or workspace. */
  why: string;
  /** A workspace that does this better for bigger jobs. */
  next?: { href: string; label: string };
  examples: StarterExample[];
}

const blurb = (id: RouterMode) => ROUTER_MODES.find((m) => m.id === id)!.blurb;

export const STARTER_TASKS: StarterTask[] = [
  {
    id: "research",
    label: "Research",
    short: "Find facts, explain topics and compare options.",
    setup: { mode: "research", router: "research", web: true },
    why: `Research mode separates established facts from interpretation and cites web sources when they're available. Auto · Research: ${blurb("research")}`,
    examples: [
      { label: "Explain a concept", action: "send", prompt: "Explain how retrieval-augmented generation (RAG) works, with a practical example." },
      {
        label: "Weigh up options",
        action: "send",
        prompt: "Compare heat pumps and gas boilers for a typical home: running costs, upfront cost and drawbacks. Say what I should check for my own situation.",
      },
      { label: "Summarise a document…", action: "draft", prompt: "Summarise the key points of the attached document, and list anything that needs checking.", attach: true },
    ],
  },
  {
    id: "writing",
    label: "Writing",
    short: "Draft, rewrite and polish emails, posts and documents.",
    setup: { mode: "research", router: "balanced", web: false },
    why: `Auto picks a capable, low-cost model for everyday writing: ${blurb("balanced")} For feedback on your own text, try “Improve my writing”, which uses Critic mode. The Writing Agent is set up for drafting and editing, with its own instructions you can adjust.`,
    next: { href: "/agents/writing", label: "Open the Writing Agent" },
    examples: [
      { label: "Draft an email", action: "send", prompt: "Draft a short, friendly email to my team saying our product launch moves to next Monday, and why that's good news." },
      { label: "Write a post…", action: "draft", prompt: "Write a short LinkedIn post about " },
      { label: "Improve my writing…", action: "draft", prompt: "Edit this for clarity and concision, and explain your main changes:\n\n", mode: "critic" },
    ],
  },
  {
    id: "coding",
    label: "Coding",
    short: "Write, explain and debug code.",
    setup: { mode: "coding", router: "coding", web: false },
    why: `Coding mode answers with working code, edge cases and how to test it. Auto · Coding: ${blurb("coding")} For a whole project the agent can edit, run and test, use Code.`,
    next: { href: "/code", label: "Open Code" },
    examples: [
      { label: "Write a function", action: "send", prompt: "Write a TypeScript function that debounces another function, with a few tests." },
      { label: "Find bugs in my code…", action: "draft", prompt: "Find bugs in this code and explain each fix:\n\n" },
      { label: "Build a website", action: "link", href: "/code" },
    ],
  },
  {
    id: "planning",
    label: "Planning",
    short: "Turn goals into plans, schedules and task lists.",
    setup: { mode: "analyst", router: "balanced", web: false },
    why: `Analyst mode structures the problem and compares options before a clear takeaway. For plans you want to track, Missions turns a goal into milestones and tasks.`,
    next: { href: "/missions", label: "Open Missions" },
    examples: [
      { label: "Plan my day", action: "draft", prompt: "Help me plan my day. My priorities are: ", special: "plan-day" },
      { label: "Turn a goal into a plan", action: "send", prompt: "Turn this goal into a step-by-step plan with milestones: launch a weekly newsletter within six weeks." },
      { label: "Break down a project…", action: "draft", prompt: "Break this project into tasks with rough time estimates: " },
    ],
  },
  {
    id: "compare",
    label: "Compare AI models",
    short: "See how different models answer the same question.",
    setup: null,
    why: "Arena sends one question to several models side by side, with the names hidden until you pick the best answer. Council combines several models' answers into one reply.",
    next: { href: "/council", label: "Open Council" },
    examples: [
      { label: "Explain something simply", action: "link", href: `/arena?q=${encodeURIComponent("Explain how vaccines train the immune system, in simple terms.")}` },
      { label: "Write a tagline", action: "link", href: `/arena?q=${encodeURIComponent("Write three taglines for a cosy neighbourhood bookshop.")}` },
      { label: "Open Arena", action: "link", href: "/arena" },
    ],
  },
  {
    id: "chat",
    label: "Just chat",
    short: "Ask anything, brainstorm or talk an idea through.",
    setup: { mode: "research", router: "balanced", web: false },
    why: `Auto picks the model for each message: ${blurb("balanced")} The model it used is shown under every reply.`,
    next: { href: "/agents", label: "Browse agents" },
    examples: [
      { label: "Brainstorm ideas", action: "send", prompt: "Brainstorm ten name ideas for a small coffee shop, each with a one-line reason." },
      { label: "Explain it simply…", action: "draft", prompt: "Explain this simply, as if I'm twelve: " },
      { label: "Challenge my idea…", action: "draft", prompt: "Challenge this idea and tell me its weakest points: ", mode: "critic" },
    ],
  },
];

export function starterTask(id: string | null | undefined): StarterTask | undefined {
  return STARTER_TASKS.find((t) => t.id === id);
}

/** The model id a task's setup asks for: Auto with its routing preference. */
export function starterModelId(task: StarterTask): string | null {
  return task.setup ? (task.setup.router === "balanced" ? AUTO_MODEL_ID : `${AUTO_MODEL_ID}:${task.setup.router}`) : null;
}

/** A request typed (or picked) before signing up, carried through sign-up for up to an hour. */
export const PENDING_START_KEY = "orbis:pending-start";
export const PENDING_START_TTL_MS = 60 * 60_000;

export interface PendingStart {
  prompt: string;
  task: StarterTaskId | null;
  at: number;
}

export function readPendingStart(raw: string | null, now = Date.now()): PendingStart | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PendingStart>;
    if (typeof p.prompt !== "string" || !p.prompt.trim() || typeof p.at !== "number" || now - p.at > PENDING_START_TTL_MS || now < p.at - 60_000) return null;
    return { prompt: p.prompt.slice(0, 8000), task: starterTask(p.task ?? null)?.id ?? null, at: p.at };
  } catch {
    return null;
  }
}

/** What a chosen example does, as a Home/Chat action (with the task's model and web choice). */
export function exampleAction(
  task: StarterTask,
  ex: StarterExample,
  env: { search: boolean; autoOn: boolean; home?: boolean },
):
  | { kind: "send"; prompt: string; mode: ChatMode; web?: boolean; modelId?: string }
  | { kind: "draft"; prompt: string; mode: ChatMode; web?: boolean; attach?: boolean }
  | { kind: "link"; href: string } {
  if (ex.action === "link") return { kind: "link", href: ex.href! };
  const mode = ex.mode ?? task.setup?.mode ?? "research";
  const web = !!task.setup?.web && env.search;
  // Home plans the day from what it knows (priorities, tasks, calendar); elsewhere it's a draft to finish.
  if (ex.special === "plan-day" && env.home) return { kind: "send", prompt: "", mode };
  if (ex.action === "draft") return { kind: "draft", prompt: ex.prompt!, mode, web, ...(ex.attach ? { attach: true } : {}) };
  const modelId = env.autoOn ? (starterModelId(task) ?? undefined) : undefined;
  return { kind: "send", prompt: ex.prompt!, mode, web, ...(modelId ? { modelId } : {}) };
}
