/**
 * Orbis Code extras: slash commands in the task box, read-only helper agents (delegate), and opening a pull request
 * after a push. Models and GitHub are faked.
 */
import { describe, expect, it, vi } from "vitest";
import type { ToolTurnResult } from "@/lib/ai/types";
import { systemPrompt } from "@/lib/code/agent/protocol";
import { HELPER_TURNS, MAX_HELPERS, runHelper, runHelpers } from "@/lib/code/agent/subagent";
import { toolSchemas } from "@/lib/code/agent/tool-specs";
import { runActions, type AgentEnv } from "@/lib/code/agent/tools";
import { parseSlash, SLASH_COMMANDS, slashSuggestions } from "@/lib/code/slash";
import { openPullRequest } from "@/lib/github/push";

describe("slash commands", () => {
  it("turn a command into the right task and mode", () => {
    expect(parseSlash("/plan add dark mode")).toEqual({ kind: "task", command: "plan", request: "add dark mode", mode: "plan" });
    expect(parseSlash("/auto  add dark mode ")).toMatchObject({ kind: "task", mode: "auto", request: "add dark mode" });
    expect(parseSlash("/review")).toMatchObject({ kind: "task", mode: "read" });
    expect((parseSlash("/review the auth code") as { request: string }).request).toContain("focusing on the auth code");
    const fix = parseSlash("/fix the total is wrong when the cart is empty") as { request: string; mode?: string };
    expect(fix.request).toContain("Fix this bug: the total is wrong when the cart is empty");
    expect(fix.request).toContain("reproduce it");
    expect(fix.mode).toBeUndefined();
    expect(parseSlash("/TEST")).toMatchObject({ kind: "task", command: "test" });
    expect(parseSlash("/explain how\nlogin works")).toMatchObject({ kind: "task", mode: "read" });
  });

  it("open a new task or the list, and explain mistakes", () => {
    expect(parseSlash("/new")).toEqual({ kind: "action", command: "new", action: "new", arg: "" });
    expect(parseSlash("/help")).toEqual({ kind: "action", command: "help", action: "help", arg: "" });
    expect(parseSlash("/deploy now")).toEqual({ kind: "error", message: "There's no /deploy command. Type / to see them." });
    expect(parseSlash("/plan")).toMatchObject({ kind: "error" });
    expect((parseSlash("/explain") as { message: string }).message).toContain("/explain how login works");
  });

  it("leave ordinary tasks alone", () => {
    expect(parseSlash("Add a /about page")).toBeNull();
    expect(parseSlash("fix /api/users")).toBeNull();
    expect(parseSlash("/api/users returns 500")).toBeNull();
  });

  it("are suggested while the command word is being typed", () => {
    expect(slashSuggestions("/").map((c) => c.name)).toEqual(SLASH_COMMANDS.map((c) => c.name));
    expect(slashSuggestions("/re").map((c) => c.name)).toEqual(["review", "rewind"]);
    expect(slashSuggestions("/review ")).toEqual([]);
    expect(slashSuggestions("hello")).toEqual([]);
  });
});

const files = [
  { path: "src/auth.ts", content: "export function checkSession(req) {\n  return req.cookies.sid === store.sid;\n}\n" },
  { path: "src/routes.ts", content: "import { checkSession } from './auth';\n" },
  { path: ".env", content: "SECRET=sk-live-xyz\n" },
];
function env(): AgentEnv & { saved: number } {
  const e = {
    saved: 0,
    files: async () => files,
    save: async () => {
      e.saved++;
    },
    computer: async () => false,
    exec: async () => {
      throw new Error("no commands");
    },
    changes: async () => [],
    checkpoints: { list: async () => [], create: async () => ({ id: "c", label: "", files: {}, createdAt: "" }) },
  };
  return e as AgentEnv & { saved: number };
}
const turn = (text: string, calls: { name: string; args: Record<string, unknown> }[]): ToolTurnResult => ({
  text,
  calls: calls.map((c, i) => ({ id: `c${i}`, ...c })),
  usage: { inputTokens: 300, outputTokens: 40, estimated: false },
  servedModel: "m",
  stop: calls.length ? "tool_use" : "end_turn",
});

describe("helper agents", () => {
  it("search and read (secrets withheld), then report", async () => {
    const e = env();
    const seen: string[][] = [];
    const script = [
      turn("Searching.", [{ name: "search_code", args: { query: "checkSession" } }, { name: "read_files", args: { paths: ["src/auth.ts", ".env"] } }]),
      turn("", [{ name: "finish", args: { summary: "checkSession is in src/auth.ts:1 and used by src/routes.ts:1." } }]),
    ];
    const r = await runHelper("Where is the session checked?", {
      env: e,
      deadline: Date.now() + 60_000,
      turn: async (p) => {
        seen.push(p.tools.map((t) => t.name));
        if (seen.length === 2) {
          const results = (p.messages.at(-1) as { results: { text: string }[] }).results.map((x) => x.text).join("\n");
          expect(results).toContain("src/routes.ts:1:");
          expect(results).toContain("return req.cookies.sid");
          expect(results).not.toContain("sk-live-xyz");
        }
        return script.shift()!;
      },
    });
    expect(r).toMatchObject({ ok: true, turns: 2, text: "checkSession is in src/auth.ts:1 and used by src/routes.ts:1." });
    expect(r.usage).toHaveLength(2);
    expect(seen[0]!.sort()).toEqual(["finish", "glob", "list_files", "read_files", "search_code"]);
  });

  it("can't change anything, even if the model tries", async () => {
    const e = env();
    const script = [
      turn("", [
        { name: "write_file", args: { path: "src/auth.ts", content: "x" } },
        { name: "run_command", args: { command: "rm -rf ." } },
      ]),
      turn("Done.", []),
    ];
    let second: string = "";
    const r = await runHelper("Fix it", {
      env: e,
      deadline: Date.now() + 60_000,
      turn: async (p) => {
        if (p.messages.length > 1) second = JSON.stringify(p.messages.at(-1));
        return script.shift()!;
      },
    });
    expect(e.saved).toBe(0);
    expect(second).toContain("Helpers can only list, search and read files.");
    expect(r).toMatchObject({ ok: true, text: "Done." });
  });

  it("stop at the turn limit, the deadline, or a failed call, with a report saying so", async () => {
    const loop = await runHelper("q", { env: env(), deadline: Date.now() + 60_000, turn: async () => turn("", [{ name: "list_files", args: {} }]) });
    expect(loop).toMatchObject({ ok: false, turns: HELPER_TURNS });
    const late = await runHelper("q", { env: env(), deadline: Date.now() + 1_000, turn: async () => turn("x", []) });
    expect(late).toMatchObject({ ok: false, turns: 0 });
    expect(late.text).toMatch(/ran out of time/);
    const failed = await runHelper("q", {
      env: env(),
      deadline: Date.now() + 60_000,
      turn: async () => {
        throw new Error("rate limited");
      },
    });
    expect(failed).toMatchObject({ ok: false, text: "The helper's model call failed: rate limited" });
  });

  it("run at most three at once, in parallel", async () => {
    let running = 0;
    let peak = 0;
    const r = await runHelpers(["a1", "b2", "c3", "d4"], {
      env: env(),
      deadline: Date.now() + 60_000,
      turn: async () => {
        peak = Math.max(peak, ++running);
        await new Promise((res) => setTimeout(res, 20));
        running--;
        return turn("", [{ name: "finish", args: { summary: "ok" } }]);
      },
    });
    expect(r).toHaveLength(MAX_HELPERS);
    expect(peak).toBe(3);
  });

  it("are offered to models with native tool calling only, and the agent is told when to use them", () => {
    const base = { commands: "safe" as const, docs: false, github: false, approvePlans: false };
    expect(toolSchemas({ ...base, helpers: true }).map((t) => t.name)).toContain("delegate");
    expect(toolSchemas(base).map((t) => t.name)).not.toContain("delegate");
    expect(systemPrompt({ ...base, helpers: true, native: true, planning: false, reviewEdits: false })).toContain("ask helpers with delegate");
    expect(systemPrompt({ ...base, native: true, planning: false, reviewEdits: false })).not.toContain("delegate");
  });

  it("the delegate tool hands the questions over and returns the reports", async () => {
    const e = env();
    const logged: { kind: string; title: string }[] = [];
    e.emit = async (evs) => logged.push(...evs);
    e.delegate = vi.fn(async (qs: string[]) => qs.map((q) => ({ ok: true, text: `Answer to ${q}`, turns: 2 })));
    const out = await runActions(
      { thought: "", actions: [{ id: "d1", tool: "delegate", args: { questions: ["Where is the session checked?", "Which routes use it?"] } }] },
      { planApproved: true, approvePlans: false, reviewEdits: false, commands: "safe" },
      e,
    );
    expect(e.delegate).toHaveBeenCalledWith(["Where is the session checked?", "Which routes use it?"], undefined);
    expect(out.results[0]!.ok).toBe(true);
    expect(out.results[0]!.text).toContain("Helper 1 (answered, 2 turns) — Where is the session checked?\nAnswer to Where is the session checked?");
    expect(logged.map((x) => x.title)).toEqual(["Asked 2 helpers: Where is the session checked? · Which routes use it?", "Helpers reported back (2 of 2 answered)"]);
    const none = await runActions({ thought: "", actions: [{ id: "d2", tool: "delegate", args: { questions: ["Where?"] } }] }, { planApproved: true, approvePlans: false, reviewEdits: false, commands: "safe" }, env());
    expect(none.results[0]!.ok).toBe(false);
  });
});

describe("opening a pull request after a push", () => {
  const fake = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  it("opens it from the new branch into the default branch", async () => {
    const f = fake(201, { number: 42, html_url: "https://github.com/o/r/pull/42" });
    const pr = await openPullRequest("tok", { repo: "o/r", head: "orbis/x", base: "main", title: "Add greeting", body: "Why" }, f as never);
    expect(pr).toEqual({ number: 42, url: "https://github.com/o/r/pull/42" });
    const [url, init] = (f.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r/pulls");
    expect(JSON.parse(String(init.body))).toEqual({ title: "Add greeting", body: "Why", head: "orbis/x", base: "main", draft: false });
  });

  it("says what GitHub needs when it refuses", async () => {
    await expect(openPullRequest("tok", { repo: "o/r", head: "b", base: "main", title: "t", body: "" }, fake(403, {}) as never)).rejects.toThrow(/Pull requests: Read and write/);
    await expect(openPullRequest("tok", { repo: "o/r", head: "b", base: "main", title: "t", body: "" }, fake(422, {}) as never)).rejects.toThrow(/may already exist/);
    await expect(openPullRequest("tok", { repo: "o/r", head: "b", base: "main", title: "t", body: "" }, fake(500, {}) as never)).rejects.toThrow(/\(500\)/);
  });
});
