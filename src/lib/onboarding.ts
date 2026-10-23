import { z } from "zod";
import { SITE_EXAMPLES } from "./code/site-examples";

/**
 * First-run onboarding: four starting points, each a real workflow in Orbis,
 * shown once to a new account (no onboarding record, no chats, no code
 * projects). Choosing one or skipping is saved in the account's preferences
 * (profiles.preferences.onboarding), so it isn't shown again on any device;
 * "Getting started" on Home brings it back on request.
 */

export const START_PATHS = ["website", "project", "bug", "question"] as const;
export type StartPath = (typeof START_PATHS)[number];

export interface OnboardingState {
  status: "chosen" | "skipped";
  path: StartPath | null;
  at: string;
}

export const onboardingPatch = z.object({ status: z.enum(["chosen", "skipped"]), path: z.enum(START_PATHS).nullable().optional() });

/** The saved state, or null when there's none (or it isn't valid). */
export function readOnboarding(prefs: unknown): OnboardingState | null {
  const o = (prefs as { onboarding?: unknown } | null)?.onboarding as Partial<OnboardingState> | undefined;
  if (!o || (o.status !== "chosen" && o.status !== "skipped")) return null;
  return { status: o.status, path: START_PATHS.includes(o.path as StartPath) ? (o.path as StartPath) : null, at: typeof o.at === "string" ? o.at : "" };
}

/** A new account: never onboarded, and nothing made yet (people who used Orbis before onboarding existed don't see it). */
export function isFirstRun(i: { onboarding: OnboardingState | null; conversations: number; codeProjects: number }): boolean {
  return !i.onboarding && i.conversations === 0 && i.codeProjects === 0;
}

/** What an option does: open a page, fill the home's prompt box (to edit, then send), or start the example project. */
export type StartAction = { kind: "link"; href: string } | { kind: "draft"; prompt: string; mode?: "coding" | "research" };

export interface StartOption {
  label: string;
  action: StartAction;
}

export interface StartPathInfo {
  id: StartPath;
  title: string;
  text: string;
  /** What it needs and why, said before anything is asked for. */
  needs: string | null;
  primary: StartOption;
  examples: StartOption[];
}

/** Where a starting point leads; "from=welcome" lets the page give first-time guidance. */
export const START: StartPathInfo[] = [
  {
    id: "website",
    title: "Build a website",
    text: "Describe a site. The coding agent writes it, runs it and checks it in a real browser, then reports what it verified.",
    needs: "Runs on a private computer for your project, which uses workspace minutes from your plan. Nothing is published.",
    primary: { label: "Describe your site", action: { kind: "link", href: "/code?from=welcome" } },
    examples: SITE_EXAMPLES.slice(0, 3).map((x) => ({ label: x.label, action: { kind: "link" as const, href: `/code?idea=${x.id}&from=welcome` } })),
  },
  {
    id: "project",
    title: "Improve an existing project",
    text: "Bring your code in from GitHub, then ask the agent for a change. It plans first and asks before running unfamiliar commands.",
    needs: "Importing asks GitHub for read access to the repositories you pick, only when you import. Changes stay in Orbis until you push them.",
    primary: { label: "Import from GitHub", action: { kind: "link", href: "/code?start=github" } },
    examples: [{ label: "Start from a template instead", action: { kind: "link", href: "/code?new=1" } }],
  },
  {
    id: "bug",
    title: "Investigate a bug",
    text: "Try it on a small example project whose tests fail: the agent finds the cause, fixes it and runs the tests. Or paste an error into chat.",
    needs: null,
    primary: { label: "Try the example project", action: { kind: "link", href: "/code?start=example" } },
    examples: [{ label: "Paste an error into chat", action: { kind: "draft", mode: "coding", prompt: "I'm getting this error. What's causing it, and how do I fix it?\n\n" } }],
  },
  {
    id: "question",
    title: "Ask Orbis a question",
    text: "Chat with Claude and GPT models. Auto picks one for each message and every reply says which answered.",
    needs: null,
    primary: { label: "Ask your own question", action: { kind: "draft", prompt: "" } },
    examples: [
      { label: "Explain a concept", action: { kind: "draft", mode: "research", prompt: "Explain how retrieval-augmented generation (RAG) works, with a practical example." } },
      { label: "Draft an email", action: { kind: "draft", prompt: "Draft a short, friendly email to my team saying our launch moves to next Monday, and why that's good news." } },
    ],
  },
];

/** The starting points that work on this site: importing a project needs GitHub set up here. */
export function startPathsFor(site: { github: boolean }): StartPathInfo[] {
  return START.filter((p) => p.id !== "project" || site.github);
}

export function startPath(id: string | null | undefined): StartPathInfo | undefined {
  return START.find((p) => p.id === id);
}
