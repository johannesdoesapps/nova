import { DEFAULT_BILLING, PLANS, chargeUsd } from "@/lib/plans";
import { DEMOS } from "./demos";

/**
 * The homepage's words, organised around what people get done. Screenshots
 * are the real captures in demos.ts; figures come from the enforced plan
 * settings, so they can't drift from what Orbis actually allows.
 */

export interface Outcome {
  id: string;
  eyebrow: string;
  title: string;
  text: string;
  points: string[];
  /** A real capture, or none (the usage section shows real figures instead). */
  image?: { src: string; alt: string; width: number; height: number };
  caption?: string;
  links: { href: string; label: string }[];
}

const demo = (id: string) => DEMOS.find((d) => d.id === id)!;

export const OUTCOMES: Outcome[] = [
  {
    id: "models",
    eyebrow: "Several leading models",
    title: "Get help from the right model for each task",
    text: "Leave the model on Auto and Orbis picks one for every request: a fast, low-cost model for everyday questions, a stronger one only when the task needs it. Or choose the model yourself. Every reply names the model that wrote it.",
    points: ["Claude and GPT models in one conversation history", "Search your chats by title and message text", "Run code from a reply on an isolated computer"],
    image: demo("chat").image,
    caption: demo("chat").caption,
    links: [
      { href: "/features/ai-assistant", label: "How Chat works" },
      { href: "/docs/choosing-a-model", label: "Choosing a model" },
    ],
  },
  {
    id: "compare",
    eyebrow: "Compare and check",
    title: "Compare answers before you rely on one",
    text: "Council asks several models the same question and a chair model writes one answer listing where they agree and disagree. Arena puts answers side by side. Verify checks an answer's claims against sources and says which it couldn't confirm.",
    points: ["See each model's answer, time and cost", "An estimate before anything runs", "Claims labelled by what the sources reviewed say, never just “verified”"],
    image: demo("compare").image,
    caption: demo("compare").caption,
    links: [
      { href: "/features/multi-model", label: "Council and Arena" },
      { href: "/verify", label: "Try Verify" },
    ],
  },
  {
    id: "agents",
    eyebrow: "Agents and templates",
    title: "Hand over whole tasks to specialised agents",
    text: "The coding agent builds and fixes software on a private computer, runs the tests and checks websites in a real browser before it calls a task done. Ready-made templates run common jobs step by step: research a topic, summarise a document, review code, plan your week.",
    points: ["Every step of the agent's work is listed, and every change can be undone", "Templates show their steps, estimated usage and progress", "Create your own agents with your instructions"],
    image: DEMOS.find((d) => d.id === "code")!.image,
    caption: DEMOS.find((d) => d.id === "code")!.caption,
    links: [
      { href: "/features/ai-coding-assistant", label: "The coding agent" },
      { href: "/templates", label: "Browse templates" },
      { href: "/features/ai-agents", label: "Agents" },
    ],
  },
  {
    id: "projects",
    eyebrow: "Ongoing work",
    title: "Keep ongoing work together in projects",
    text: "Turn a goal into milestones and tasks, keep a project's chats and notes in one place, and give it instructions its chats follow. You choose what a project shares with its chats; nothing crosses over to other projects.",
    points: ["Plans you edit before anything is saved", "Turn a reply into a note, task or milestone", "Pick up where you left off from Home"],
    image: demo("plan").image,
    caption: demo("plan").caption,
    links: [{ href: "/features/mission-control", label: "Mission Control" }],
  },
];

const tu = DEFAULT_BILLING.tierUnits;

/** "What a unit is", with the real per-model figures. */
export const UNIT_EXAMPLES: { task: string; units: string }[] = [
  { task: "A question to a fast model (such as Claude Haiku or GPT Luna)", units: `${tu.standard} unit` },
  { task: "The same question to an advanced model (Pro and Max)", units: `${tu.advanced} units` },
  { task: "The same question to a premium model (Max)", units: `${tu.premium} units` },
  { task: "A Council of three fast models in Quick mode (three answers and a summary)", units: `${tu.standard * 4} units` },
  { task: "A three-step template with a fast model", units: `${tu.standard * 3} units` },
];

export const PLAN_LIMITS = (["free", "pro", "max"] as const).map((id) => {
  const p = PLANS[id];
  return {
    id,
    name: p.label,
    price: p.priceUsd,
    yearly: p.priceUsd > 0 ? chargeUsd(p, "year") : 0,
    discount: p.annualDiscountPct,
    lines: [
      `${p.windowUnits.toLocaleString("en-US")} units per 5 hours, ${p.weeklyUnits.toLocaleString("en-US")} per week`,
      p.dailyMessages > 0 ? `Up to ${p.dailyMessages} messages a day` : null,
      id === "free" ? "Fast, low-cost models" : id === "pro" ? "Adds advanced models (Claude Sonnet, GPT Terra)" : "Adds premium models (Claude Opus, GPT Sol)",
      `Code workspace: ${p.codeProjects} projects, ${p.workspaceMinutesPerPeriod.toLocaleString("en-US")} computer minutes a month`,
    ].filter((x): x is string => !!x),
  };
});

/** What Orbis does with data, in the same words as the Privacy Policy and the app. */
export const TRUST_POINTS = [
  { title: "You see who answered", text: "Before you send, the message box shows which provider your message goes to; every reply names the model that wrote it." },
  {
    title: "Not used for training",
    text: "Orbis doesn't use your conversations, files or code to train AI models. Under the providers' API terms, data sent through their APIs isn't used to train their models by default.",
  },
  {
    title: "Agents ask before acting",
    text: "The coding agent runs tests and builds on its own but asks before other commands, and never deploys or pushes. Actions in connected apps always wait for your confirmation.",
  },
  { title: "Changes you can undo", text: "Each coding session lists the files it changed. Revert a whole session or a single file." },
  { title: "Code runs in isolation", text: "Code runs on a short-lived computer for your project, with internet limited to package registries and none of Orbis's keys inside." },
  { title: "Your data, your controls", text: "Delete or archive any chat, choose what each project shares with its chats, disconnect apps, and turn off usage events in Settings." },
];
