/**
 * First-run onboarding: who sees it (new accounts only, once), what each
 * starting point leads to (real pages and real example requests), what is
 * saved (the choice, never text), and the welcome as rendered on Home.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const search = { value: "" };
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(search.value) }));
vi.mock("@vercel/analytics", () => ({ track: vi.fn() }));

const { START, isFirstRun, onboardingPatch, readOnboarding, startPath } = await import("@/lib/onboarding");
const { siteExample } = await import("@/lib/code/site-examples");
const { afterSignIn } = await import("@/lib/auth-flow");
const { FirstRun } = await import("@/components/studio/first-run");
const { Home } = await import("@/components/studio/home");

const home = (o: { firstRun?: boolean; signedIn?: boolean }) =>
  renderToStaticMarkup(
    createElement(Home, {
      name: "Sam",
      composer: createElement("textarea", { id: "studio-input" }),
      onAction: () => {},
      starter: { active: null, onChoose: () => {}, env: { search: false, autoOn: true } },
      ...o,
    }),
  );

describe("who sees onboarding", () => {
  it("is shown to a new account only: no onboarding record, no chats, no code projects", () => {
    expect(isFirstRun({ onboarding: null, conversations: 0, codeProjects: 0 })).toBe(true);
    expect(isFirstRun({ onboarding: null, conversations: 2, codeProjects: 0 })).toBe(false);
    expect(isFirstRun({ onboarding: null, conversations: 0, codeProjects: 1 })).toBe(false);
    expect(isFirstRun({ onboarding: { status: "skipped", path: null, at: "" }, conversations: 0, codeProjects: 0 })).toBe(false);
    expect(isFirstRun({ onboarding: { status: "chosen", path: "website", at: "" }, conversations: 0, codeProjects: 0 })).toBe(false);
  });

  it("reads the saved state from the account's preferences and ignores anything malformed", () => {
    expect(readOnboarding({ onboarding: { status: "chosen", path: "bug", at: "2026-10-23T10:00:00Z" } })).toEqual({ status: "chosen", path: "bug", at: "2026-10-23T10:00:00Z" });
    expect(readOnboarding({ onboarding: { status: "skipped" } })).toEqual({ status: "skipped", path: null, at: "" });
    expect(readOnboarding({ onboarding: { status: "done" } })).toBeNull();
    expect(readOnboarding({ onboarding: { status: "chosen", path: "<script>" } })?.path).toBeNull();
    expect(readOnboarding({})).toBeNull();
    expect(readOnboarding(null)).toBeNull();
  });

  it("saves only the choice: a status and one of four starting points, nothing typed", () => {
    expect(onboardingPatch.safeParse({ status: "chosen", path: "website" }).success).toBe(true);
    expect(onboardingPatch.safeParse({ status: "skipped" }).success).toBe(true);
    expect(onboardingPatch.safeParse({ status: "chosen", path: "anything" }).success).toBe(false);
    expect(onboardingPatch.safeParse({ status: "chosen", path: "website", prompt: "secret" }).data).toEqual({ status: "chosen", path: "website" });
  });
});

describe("starting points", () => {
  it("offers the four supported workflows", () => {
    expect(START.map((p) => p.title)).toEqual(["Build a website", "Improve an existing project", "Investigate a bug", "Ask Orbis a question"]);
  });

  it("leads only to real pages, real example requests and the real example project", () => {
    const pages = new Set(["/code", "/chat", "/home"]);
    for (const p of START) {
      for (const o of [p.primary, ...p.examples]) {
        if (o.action.kind !== "link") continue;
        const u = new URL(o.action.href, "https://tryorbis.app");
        expect(pages.has(u.pathname), o.action.href).toBe(true);
        const idea = u.searchParams.get("idea");
        if (idea) expect(siteExample(idea), idea).toBeDefined();
        const start = u.searchParams.get("start");
        if (start) expect(["example", "github"]).toContain(start);
      }
    }
    expect(startPath("bug")!.primary.action).toEqual({ kind: "link", href: "/code?start=example" });
  });

  it("explains what a starting point needs before asking for it (GitHub access, computer time)", () => {
    expect(startPath("project")!.needs).toContain("read access to the repositories you pick, only when you import");
    expect(startPath("website")!.needs).toContain("workspace minutes");
  });

  it("keeps the starting point through sign-up", () => {
    expect(afterSignIn("/code?start=example")).toBe("/code?start=example");
    expect(afterSignIn("/home?welcome=1")).toBe("/home?welcome=1");
    expect(afterSignIn("//evil.example")).toBe("/home");
  });
});

describe("the welcome on Home", () => {
  it("greets a new account with the four starting points, a way to skip, and the prompt box", () => {
    const html = renderToStaticMarkup(createElement(FirstRun, { name: "Sam", onAction: () => {}, onClose: () => {} }));
    expect(html).toContain("Welcome to Orbis, Sam");
    for (const p of START) expect(html).toContain(p.title);
    expect(html).toContain("Skip, I&#x27;ll explore on my own");
    const page = home({ firstRun: true, signedIn: true });
    expect(page).toContain("Welcome to Orbis, Sam");
    expect(page).toContain("Or ask anything");
    expect(page).toContain('id="studio-input"');
  });

  it("isn't shown to returning users, who get the usual start screen and a way back to the guide", () => {
    const page = home({ firstRun: false, signedIn: true });
    expect(page).not.toContain("Welcome to Orbis");
    expect(page).toContain("What do you want to accomplish?");
    expect(page).toContain('href="/home?welcome=1"');
  });

  it("opens on request for returning users, and never for guests", () => {
    search.value = "welcome=1";
    expect(home({ firstRun: false, signedIn: true })).toContain("Welcome to Orbis");
    expect(home({ firstRun: true, signedIn: false })).not.toContain("Welcome to Orbis");
    search.value = "";
  });
});

describe("first-task counts", () => {
  it("counts each step of a new account's first task once, with the kind and outcome only", async () => {
    const { track } = await import("@vercel/analytics");
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const { countFirstTask } = await import("@/lib/first-task");
    countFirstTask("started", { kind: "code" });
    countFirstTask("started", { kind: "chat" });
    countFirstTask("succeeded", { kind: "code", state: "verified" });
    expect(vi.mocked(track).mock.calls).toEqual([
      ["first_task_started", { kind: "code" }],
      ["first_task_succeeded", { kind: "code", state: "verified" }],
    ]);
    vi.unstubAllGlobals();
  });
});
