/**
 * Jarvis's "Build a website": once approved, it creates a website project and starts the coding agent on it (as
 * Code's start page does), then opens the build; a blocked tab or a refused start is reported as it happened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "@/lib/jarvis/executors";
import type { Step } from "@/lib/jarvis/mission";
import { decide } from "@/lib/jarvis/permissions";
import { TOOLS } from "@/lib/jarvis/tools";

const step = (description: string): Step => ({ id: "s1", tool: "build_website", args: { description }, status: "running" });

let calls: { url: string; body: Record<string, unknown> }[];
let opened: string[];
let popupsBlocked: boolean;
let agentStatus: number;

beforeEach(() => {
  calls = [];
  opened = [];
  popupsBlocked = false;
  agentStatus = 201;
  vi.stubGlobal("window", { open: (url: string) => (popupsBlocked ? null : (opened.push(url), {})) });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (url === "/api/code/projects") return new Response(JSON.stringify({ project: { id: "p1" } }), { status: 201 });
    if (url === "/api/code/projects/p1/agent")
      return agentStatus < 300 ? new Response(JSON.stringify({ run: { id: "r1" } }), { status: agentStatus }) : new Response(JSON.stringify({ error: { message: "You've used this week's coding allowance." } }), { status: agentStatus });
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Jarvis building a website", () => {
  it("uses the plan's allowance, so it always asks first", () => {
    expect(TOOLS.build_website.risk).toBe("spend");
    for (const autonomy of [2, 3, 4] as const) expect(decide("build_website", { autonomy, desktopConnected: false, halted: false }).kind).toBe("confirm");
    expect(decide("build_website", { autonomy: 1, desktopConnected: false, halted: false }).kind).toBe("deny");
  });

  it("creates a website project, starts the agent on the request, and opens the build", async () => {
    const r = await executeStep(step("A one-page site for a bakery called Crumbs"), new AbortController().signal);
    expect(calls.map((c) => c.url)).toEqual(["/api/code/projects", "/api/code/projects/p1/agent"]);
    expect(calls[0]!.body).toMatchObject({ template: "website" });
    expect(calls[1]!.body).toMatchObject({ request: "A one-page site for a bakery called Crumbs", options: { approvePlans: false, readOnly: false, commands: "safe" } });
    expect(opened).toEqual(["/code/p1"]);
    expect(r).toMatchObject({ outcome: "success", details: { kind: "link", href: "/code/p1" } });
    expect(r.summary).toMatch(/Started building your website/);
  });

  it("still gives a link to the build when the browser blocks the new tab", async () => {
    popupsBlocked = true;
    const r = await executeStep(step("A portfolio site for a photographer"), new AbortController().signal);
    expect(r).toMatchObject({ outcome: "partial", details: { kind: "link", href: "/code/p1" } });
    expect(r.summary).toMatch(/blocked the new tab/);
  });

  it("says when the build couldn't start, with the reason, and doesn't open anything", async () => {
    agentStatus = 429;
    const r = await executeStep(step("A site for my band"), new AbortController().signal);
    expect(r.outcome).toBe("failure");
    expect(r.summary).toMatch(/the build didn't start: You've used this week's coding allowance/);
    expect(opened).toEqual([]);
  });
});
