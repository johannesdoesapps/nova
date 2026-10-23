import { PLANS, chargeUsd } from "@/lib/plans";
import { DEMOS } from "./demos";

/**
 * The homepage's words, led by the coding agent: what it does, a real run,
 * and what it checked. Screenshots and run steps are the real captures in
 * demos.ts; figures come from the enforced plan settings, so they can't
 * drift from what Orbis actually allows.
 */

/** The real run on the homepage, as five stages. Steps are the activity log entries in demos.ts. */
export interface RunStage {
  id: "prompt" | "work" | "launch" | "inspect" | "report";
  label: string;
  /** What kind of evidence this stage is, so a browser check is never mistaken for a test suite. */
  kind: string;
  text: string;
  steps: string[];
}

const codeDemo = DEMOS.find((d) => d.id === "code")!;
const step = (i: number) => codeDemo.steps![i]!.text;

export const RUN_STAGES: RunStage[] = [
  { id: "prompt", label: "Prompt", kind: "Your request", text: "A request for a SaaS landing page for an AI productivity platform called Nova (summarised here).", steps: [] },
  { id: "work", label: "Work", kind: "File changes", text: "The agent read the starter project, then wrote the page. Every file change is listed and can be undone.", steps: [step(0), step(1)] },
  { id: "launch", label: "Launch", kind: "Command", text: "It started the site on the project's own short-lived computer, and the server answered.", steps: [step(2)] },
  {
    id: "inspect",
    label: "Browser check",
    kind: "Inspection, not a test suite",
    text: "It opened the page in a real headless browser at desktop and phone sizes, found nothing wrong, tidied three placeholder buttons and checked again.",
    steps: [step(3), step(4)],
  },
  { id: "report", label: "Report", kind: "Summary", text: "It finished with a report of what it built, which checks ran, and what isn't connected.", steps: [step(5)] },
];

/** From that run's report: what was checked, and what wasn't. */
export const RUN_CHECKED = ["The site started and answered on the project's computer", "Browser check at desktop and phone sizes: no problems found", "Checked again after its last change"];
export const RUN_NOT_CHECKED = ["A production build wasn't run", "Signup and checkout aren't connected; the report says so"];

/** What the browser check looks at (src/lib/code/preview-check.ts). */
export const BROWSER_CHECKS = [
  "Errors in the browser console and on the page",
  "Broken links, images and in-page anchors",
  "Sideways scrolling and elements wider than the screen",
  "Whether the phone menu opens",
  "Leftover placeholder text, missing image descriptions and form validation",
];

export interface Differentiator {
  id: string;
  title: string;
  text: string;
}

export const DIFFERENTIATORS: Differentiator[] = [
  {
    id: "executes",
    title: "It does the work, not just suggests it",
    text: "The agent writes and edits files, installs packages, runs commands and starts your site on the project's own short-lived computer. You get a working project, not a snippet to paste.",
  },
  {
    id: "inspectable",
    title: "You can see what it did and what it checked",
    text: "Every step is in the activity log, with each command, its exit code and its output. Websites get a browser check at desktop, tablet and phone sizes, and the final report says what it couldn't verify.",
  },
  {
    id: "control",
    title: "You stay in control",
    text: "Choose how it works: ask first, review every change, work on its own, or read-only. Beyond tests, builds and installs it asks before running commands, it never pushes or deploys, and any session or single file can be reverted.",
  },
  {
    id: "flexible",
    title: "Claude or GPT, and more than code",
    text: "Pick the model for the agent or leave it on Auto. The same account has Chat, side-by-side model comparison, templates and project plans.",
  },
];

export interface UseCase {
  id: string;
  title: string;
  text: string;
  /** A website idea id (src/lib/code/site-examples.ts) to start from after signing up; otherwise a page to read. */
  idea?: string;
  href?: string;
  cta: string;
}

export const USE_CASES: UseCase[] = [
  {
    id: "landing",
    title: "Launch a landing page",
    text: "Describe the product and what the page needs. The agent builds it, starts it and checks it in a browser at desktop, tablet and phone sizes.",
    idea: "saas",
    cta: "Start from this idea",
  },
  {
    id: "small-business",
    title: "A site for a small business",
    text: "A restaurant with a reservation form, a portfolio, a storefront with a cart. Start from an example request and edit it before you send it.",
    idea: "restaurant",
    cta: "Start from this idea",
  },
  {
    id: "fix",
    title: "Fix a bug and run the tests",
    text: "Import a GitHub repository or upload files. The agent finds the cause, makes the fix and runs your tests, showing the results.",
    href: "/features/ai-coding-assistant",
    cta: "How the coding agent works",
  },
  {
    id: "beyond",
    title: "Research, compare and plan",
    text: "Ask several models the same question and see where they agree, check claims against sources, or turn a goal into a plan.",
    href: "/features/multi-model",
    cta: "Council and Arena",
  },
];

/** Real captures beyond the coding agent, shown small as evidence; captions carry their capture dates. */
export const PROOF_SHOTS = ["chat", "compare", "plan"].map((id) => {
  const d = DEMOS.find((x) => x.id === id)!;
  return { id, title: d.title, image: d.image, caption: d.caption, href: d.href };
});

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
    text: "The coding agent runs tests, builds and installs on its own but asks before other commands, and never deploys or pushes. Actions in connected apps always wait for your confirmation.",
  },
  { title: "Changes you can undo", text: "Each coding session lists the files it changed. Revert a whole session or a single file." },
  { title: "Code runs in isolation", text: "Code runs on a short-lived computer for your project, with internet limited to package registries and none of Orbis's keys inside." },
  { title: "Your data, your controls", text: "Delete or archive any chat, choose what each project shares with its chats, disconnect apps, and turn off usage events in Settings." },
];
