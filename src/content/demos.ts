/**
 * The homepage's product captures. Every image in public/product is a real
 * screenshot of tryorbis.app, taken by a script that signs in with a test
 * account and runs the feature for real (see docs/WEBSITE.md). The coding
 * agent's steps below are copied from the activity log of the run shown in
 * the screenshots. Retake both together when the interface changes.
 */

export interface DemoStep {
  kind: "inspect" | "plan" | "approval" | "command" | "edit" | "summary";
  text: string;
  result?: "pass" | "fail";
}

export interface Demo {
  id: string;
  label: string;
  title: string;
  text: string;
  image: { src: string; alt: string; width: number; height: number };
  caption: string;
  points: string[];
  steps?: DemoStep[];
  href: string;
  cta: string;
}

const CAPTURED = "Captured on tryorbis.app on 20 October 2026";

const CAPTURED_21 = "Captured on tryorbis.app on 21 October 2026";

export const HERO_SHOT = {
  wide: {
    src: "/product/code-website.webp",
    alt: "Orbis Code after building a website from one prompt: the agent's report — what it built, the browser check that found no problems at desktop and phone sizes, the development server answering, the production build not run, the files it changed — beside the live preview of the Nova landing page it made.",
    width: 2400,
    height: 1458,
  },
  narrow: {
    src: "/product/code-website-panel.webp",
    alt: "The coding agent's report on a phone: Done, checked in a browser with no problems, what it built and which checks ran.",
    width: 780,
    height: 1227,
  },
  caption: `The coding agent after building a landing page from one prompt, with the live preview beside it. ${CAPTURED_21}.`,
};

export const DEMOS: Demo[] = [
  {
    id: "code",
    label: "Code",
    title: "A website from one prompt, checked in a real browser",
    text: "Asked for a SaaS landing page for an AI productivity platform called Nova, the agent wrote the site, started it on the project's own computer and opened it in a browser at desktop and phone sizes before calling it done. Every step below is from that run's activity log.",
    image: {
      src: "/product/website-nova.webp",
      alt: "The Nova landing page the agent built: a dark hero reading “Turn scattered work into finished work.” with Start free trial and See how it works buttons, under a sticky navigation bar.",
      width: 2000,
      height: 1250,
    },
    caption: `The page the agent built, from its live preview. ${CAPTURED_21}.`,
    points: [],
    steps: [
      { kind: "inspect", text: "Read the starter files and inspected the project" },
      { kind: "edit", text: "Wrote index.html, style.css and script.js (+252, +803 and +63 lines)" },
      { kind: "command", text: "Started the preview: python3 -m http.server 3000", result: "pass" },
      { kind: "command", text: "Checked the page in a browser at desktop and phone sizes: no problems found", result: "pass" },
      { kind: "edit", text: "Pointed three placeholder plan buttons at real targets, and checked again" },
      { kind: "summary", text: "Summary: what it built, the checks that passed, and what isn't connected (no signup or checkout)" },
    ],
    href: "/features/ai-coding-assistant",
    cta: "How the coding agent works",
  },
  {
    id: "chat",
    label: "Chat",
    title: "Ask once, see who answered",
    text: "Leave the model on Auto and Orbis picks one for the question; every reply names the model that wrote it, so you know where your answer came from.",
    image: { src: "/product/chat.webp", alt: "Orbis Chat answering a question about row-level security versus permission checks in application code; the reply is labelled Claude Haiku 5.5 with an Auto badge.", width: 2400, height: 1500 },
    caption: `A real reply. ${CAPTURED}.`,
    points: ["Claude and GPT models in one conversation history", "Edit a question, regenerate a reply, or switch models", "Run code from a reply in an isolated computer"],
    href: "/features/ai-assistant",
    cta: "More about Chat",
  },
  {
    id: "compare",
    label: "Compare",
    title: "Where models agree — and where they don't",
    text: "Council asks several models the same question, then a chair model writes one answer that lists agreements, disagreements and what still needs checking.",
    image: { src: "/product/council.webp", alt: "Orbis Council: Claude Haiku 5.5, Claude Sonnet 5.5 and GPT-5.6 Luna answered a question about monoliths and microservices; Claude Sonnet 5.5's synthesis recommends starting with a modular monolith, with its time, tokens and cost shown.", width: 2400, height: 1500 },
    caption: `A real Council session. ${CAPTURED}.`,
    points: ["Each model answers independently", "A synthesis lists agreements and disagreements", "Every step shows its model, time and cost"],
    href: "/features/multi-model",
    cta: "More about Council & Arena",
  },
  {
    id: "plan",
    label: "Plan",
    title: "From a goal to a plan you can work through",
    text: "Describe a goal and Mission Control proposes milestones and tasks. You edit them before anything is saved, and AI drafts the tasks it can help with.",
    image: { src: "/product/missions.webp", alt: "Mission Control: a plan drafted by Claude Sonnet 5.5 for launching a design studio's newsletter in six weeks — weekly milestones with prioritised tasks, some marked “AI can draft”, before it is saved.", width: 2400, height: 1500 },
    caption: `A real proposed plan, before saving. ${CAPTURED}.`,
    points: ["Milestones and tasks with priorities", "Nothing is saved until you press Create", "Only you mark tasks done"],
    href: "/features/mission-control",
    cta: "More about Mission Control",
  },
];
