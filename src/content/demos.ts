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

export const HERO_SHOT = {
  wide: {
    src: "/product/code-agent.webp",
    alt: "Orbis Code: a small Python shop-cart project open in the editor, with the coding agent's panel showing its finished run — reading the files, the approved plan, the one-line fix to cart.py, the test run that passed and its summary.",
    width: 2400,
    height: 1457,
  },
  narrow: {
    src: "/product/code-agent-panel.webp",
    alt: "The coding agent's panel after a run: each step it took, the plan you approved, the one-line fix, the test run that passed, and its summary.",
    width: 780,
    height: 1227,
  },
  caption: `The coding agent after fixing a bug and running the project's tests. ${CAPTURED}.`,
};

export const DEMOS: Demo[] = [
  {
    id: "code",
    label: "Code",
    title: "An agent that checks its own work",
    text: "Asked to fix a project's failing tests, the agent read the code, found the cause, proposed a plan, made a one-line fix and ran the tests on the project's own computer. Every step below is from that run's activity log.",
    image: { src: "/product/code-changes.webp", alt: "The Changes panel for the agent's run: its request, its summary, and a diff of cart.py where `return price` is replaced by `return price * quantity`, with Revert buttons.", width: 2400, height: 1457 },
    caption: `The run's change as a diff, ready to keep or revert. ${CAPTURED}.`,
    points: [],
    steps: [
      { kind: "inspect", text: "Read cart.py and test_cart.py" },
      { kind: "plan", text: "Proposed a plan: make line_total multiply price by quantity, then run the unit tests" },
      { kind: "approval", text: "You approved the plan, and started the project's computer when it asked" },
      { kind: "edit", text: "Edited cart.py (+1 −1)" },
      { kind: "command", text: "python -m unittest -v test_cart.py", result: "pass" },
      { kind: "summary", text: "Summary: the bug was in line_total; one line changed; all 3 tests pass" },
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
