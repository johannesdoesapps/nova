/**
 * Code workspace: path rules and templates, the line diff, the AI editor's
 * reply parsing and all-or-nothing edits, the plan economics of workspace
 * time, and the computer's scripts — run for real with the local bash and
 * node against temporary folders standing in for the VM.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyAiEdits, editorUserMessage, parseEditorReply, pickContext } from "@/lib/code/ai-edits";
import { diffHunks, diffLines, diffStats } from "@/lib/code/diff";
import { workspaceBlockCostUsd, workspaceMinuteCostUsd } from "@/lib/code/pricing";
import { isIgnoredPath, MAX_FILE_BYTES, TEMPLATE_IDS, TEMPLATES, validProjectPath } from "@/lib/code/projects";
import { DEFAULT_BILLING, PLAN_IDS, planEconomics, priceForBudget, validateBilling } from "@/lib/plans";

vi.mock("server-only", () => ({}));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { create: vi.fn(), get: vi.fn() } }));

const ws = await import("@/lib/code/workspace");

describe("project paths and templates", () => {
  it("accepts plain relative paths only", () => {
    for (const ok of ["index.html", "src/app.js", "a/b/c.d.ts", ".env.example", "my file.txt"]) expect(validProjectPath(ok)).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "./a", "a//b", "a\\b", "a\u0000b", "a\nb", "a/", "x".repeat(301)]) expect(validProjectPath(bad)).toBe(false);
  });

  it("knows package and build folders", () => {
    expect(isIgnoredPath("node_modules/x/index.js")).toBe(true);
    expect(isIgnoredPath("app/.next/server.js")).toBe(true);
    expect(isIgnoredPath("src/build.js")).toBe(false);
  });

  it("ships templates with valid files and a preview on port 3000 for web projects", () => {
    for (const id of TEMPLATE_IDS) {
      for (const [p, c] of Object.entries(TEMPLATES[id].files)) {
        expect(validProjectPath(p)).toBe(true);
        expect(c.length).toBeLessThan(MAX_FILE_BYTES);
      }
    }
    expect(TEMPLATES.website.runCommand).toContain("3000");
    expect(TEMPLATES.node.files["index.js"]).toContain("process.env.PORT ?? 3000");
  });
});

describe("line diff", () => {
  const rebuild = (lines: ReturnType<typeof diffLines>, side: "old" | "new") => lines.filter((l) => l.kind === "same" || l.kind === (side === "old" ? "del" : "add")).map((l) => l.text);

  it("reconstructs both versions and finds the minimal change", () => {
    const a = "one\ntwo\nthree\nfour\n";
    const b = "one\n2\nthree\nfour\nfive\n";
    const d = diffLines(a, b);
    expect(rebuild(d, "old")).toEqual(["one", "two", "three", "four"]);
    expect(rebuild(d, "new")).toEqual(["one", "2", "three", "four", "five"]);
    expect(diffStats(a, b)).toEqual({ added: 2, removed: 1 });
  });

  it("handles new, deleted and identical files", () => {
    expect(diffStats("", "a\nb\n")).toEqual({ added: 2, removed: 0 });
    expect(diffStats("a\nb", "")).toEqual({ added: 0, removed: 2 });
    expect(diffHunks("same\n", "same\n")).toEqual([]);
  });

  it("groups changes into hunks with context", () => {
    const a = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 3", "LINE 3").replace("line 35", "LINE 35");
    const h = diffHunks(a, b, 2);
    expect(h).toHaveLength(2);
    expect(h[0]!.lines.map((l) => l.text)).toEqual(["line 1", "line 2", "line 3", "LINE 3", "line 4", "line 5"]);
    expect(h[1]!.lines.find((l) => l.kind === "add")!.newNo).toBe(36);
  });

  it("fuzz: random edits always reconstruct", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: rnd(15) }, () => "abcde"[rnd(5)]!);
      const b = Array.from({ length: rnd(15) }, () => "abcde"[rnd(5)]!);
      const d = diffLines(a.join("\n"), b.join("\n"));
      expect(rebuild(d, "old")).toEqual(a);
      expect(rebuild(d, "new")).toEqual(b);
    }
  });
});

describe("AI editor", () => {
  const files = [
    { path: "index.html", content: "<h1>Hi</h1>\n<p>One</p>\n" },
    { path: "app.js", content: "const a = 1;\nconst a2 = 1;\n" },
    { path: "README.md", content: "# Demo\n```js\nx()\n```\n" },
  ];

  it("applies replace, write and delete edits as proposed changes", () => {
    const r = applyAiEdits(files, [
      { action: "replace", path: "index.html", search: "<p>One</p>", replace: "<p>Two</p>" },
      { action: "write", path: "src/new.js", content: "export {};\n" },
      { action: "delete", path: "README.md" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changes).toEqual([
      { path: "index.html", before: files[0]!.content, after: "<h1>Hi</h1>\n<p>Two</p>\n" },
      { path: "README.md", before: files[2]!.content, after: null },
      { path: "src/new.js", before: null, after: "export {};\n" },
    ]);
  });

  it("applies none when any edit doesn't fit, and says why", () => {
    const r = applyAiEdits(files, [
      { action: "replace", path: "index.html", search: "<p>One</p>", replace: "<p>Two</p>" },
      { action: "replace", path: "app.js", search: "= 1;", replace: "= 2;" },
      { action: "replace", path: "missing.js", search: "x", replace: "y" },
      { action: "write", path: "../escape.js", content: "" },
      { action: "write", path: "node_modules/x.js", content: "" },
      { action: "delete", path: "nope.txt" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/appears 2 times/);
    expect(r.errors.join(" ")).toMatch(/missing\.js: file not found/);
    expect(r.errors.join(" ")).toMatch(/escape\.js: not an allowed file path/);
    expect(r.errors.join(" ")).toMatch(/node_modules\/x\.js: not an allowed/);
    expect(r.errors.join(" ")).toMatch(/nope\.txt: can't delete/);
  });

  it("chains edits to the same file and ignores no-op changes", () => {
    const r = applyAiEdits(files, [
      { action: "replace", path: "app.js", search: "const a = 1;", replace: "const a = 3;" },
      { action: "replace", path: "app.js", search: "const a = 3;", replace: "const a = 1;" },
    ]);
    expect(r).toEqual({ ok: true, changes: [] });
  });

  it("reads the JSON reply even when file contents contain code fences", () => {
    const reply = JSON.stringify({ summary: "Docs", edits: [{ action: "write", path: "README.md", content: "# A\n```js\nx()\n```\n" }] });
    const p = parseEditorReply(`\`\`\`json\n${reply}\n\`\`\``);
    expect(p.ok && p.data.edits[0]).toMatchObject({ action: "write", path: "README.md" });
    expect(parseEditorReply('{"summary": "cut off", "edits": [{"action"').ok).toBe(false);
    expect(parseEditorReply('{"edits": [{"action": "rm", "path": "x"}]}').ok).toBe(false);
  });

  it("shows the open file and mentioned files first, within the budget", () => {
    const big = { path: "big.js", content: "x".repeat(5000) };
    const { shown, hidden } = pickContext([...files, big], "fix app.js", "index.html", 200);
    expect(shown.map((f) => f.path)).toEqual(["app.js", "index.html"]);
    expect(hidden).toContain("big.js");
    // File text is fenced longer than any fence inside it.
    expect(editorUserMessage("x", [files[2]!], [], null)).toContain("````\n# Demo");
  });
});

describe("plan economics for workspace time", () => {
  it("prices a minute from Vercel Sandbox rates (1 vCPU, 2 GB) plus preview traffic", () => {
    expect(workspaceMinuteCostUsd()).toBeCloseTo((0.128 + 2 * 0.0212) / 60 + 0.002 * 0.15, 6);
    expect(workspaceBlockCostUsd(10)).toBeCloseTo(10 * workspaceMinuteCostUsd() + 0.0000006, 6);
  });

  it("sets each plan's minutes aside before the AI budget, so the margin holds with every minute used", () => {
    for (const id of PLAN_IDS) {
      for (const interval of ["month", "year"] as const) {
        const e = planEconomics(DEFAULT_BILLING, id, interval);
        expect(e.workspaceUsd).toBeCloseTo(DEFAULT_BILLING.plans[id].workspaceMinutesPerPeriod * workspaceMinuteCostUsd(), 3);
        if (id === "free") continue;
        expect((e.revenueUsd - e.feesUsd - e.overheadUsd - e.codeRunsUsd - e.workspaceUsd - e.aiBudgetUsd) / e.revenueUsd).toBeGreaterThanOrEqual(0.6);
      }
    }
    const pro = DEFAULT_BILLING.plans.pro;
    expect(priceForBudget(DEFAULT_BILLING, planEconomics(DEFAULT_BILLING, "pro").aiBudgetUsd, pro)).toBeCloseTo(pro.priceUsd, 0);
  });

  it("validates the workspace settings", () => {
    expect(validateBilling({ workspaceBlockMinutes: 2 }).ok).toBe(false);
    expect(validateBilling({ workspaceBlockMinutes: 50 }).ok).toBe(false);
    expect(validateBilling({ plans: { pro: { workspaceMinutesPerPeriod: -1 } } }).ok).toBe(false);
    expect(validateBilling({ workspaceSiteConcurrent: 0, workspaceSiteMonthlyMinutes: 0 }).ok).toBe(true);
  });
});

describe("the computer's scripts (local bash and node standing in for the VM)", () => {
  let base: string;
  let d: { root: string; jobs: string };

  /** Writes files and runs commands locally; detached commands keep running in the background. */
  const box = (): import("@/lib/code/workspace").WorkspaceBox => ({
    async writeFiles(files) {
      for (const f of files) {
        mkdirSync(dirname(f.path), { recursive: true });
        writeFileSync(f.path, f.content);
      }
    },
    runCommand({ cmd, args, cwd, env, detached }) {
      if (detached) {
        const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "ignore", detached: true });
        child.unref();
        return Promise.resolve({ exitCode: null, stdout: async () => "" });
      }
      return new Promise((resolve) =>
        execFile(cmd, args, { cwd, env: { ...process.env, ...env }, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => resolve({ exitCode: err ? 1 : 0, stdout: async () => stdout })),
      );
    },
    domain: () => "https://example.vercel.run",
    extendTimeout: async () => {},
    stop: async () => {},
  });

  async function waitDone(b: ReturnType<typeof box>, job: string, timeoutMs = 10_000) {
    let offset = 0;
    let out = "";
    const until = Date.now() + timeoutMs;
    for (;;) {
      const r = await ws.readJob(b, job, offset, d);
      out += r.output;
      offset = r.offset;
      if (r.done || Date.now() > until) return { ...r, all: out };
      await new Promise((res) => setTimeout(res, 100));
    }
  }

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "orbis-ws-"));
    d = { root: join(base, "root"), jobs: join(base, "jobs") };
    mkdirSync(d.root, { recursive: true });
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("copies the project in and runs a command in the background with its output and exit code", async () => {
    const b = box();
    await ws.seedWorkspace(b, [{ path: "main.py", content: "print('hello from orbis')\n" }, { path: "src/a.txt", content: "A" }], d);
    expect(readFileSync(join(d.root, "src/a.txt"), "utf8")).toBe("A");
    await ws.startJob(b, "jaaaaaa1", "python3 main.py && echo \"$PORT\" && exit 3", d);
    const r = await waitDone(b, "jaaaaaa1");
    expect(r.all).toBe("hello from orbis\n3000\n");
    expect(r).toMatchObject({ done: true, exitCode: 3 });
    expect(r.startedAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it("reads long output in chunks from an offset", async () => {
    const b = box();
    await ws.startJob(b, "jaaaaaa2", `python3 -c "print('x' * ${ws.JOB_READ_CHUNK * 2})"`, d);
    await waitDone(b, "jaaaaaa2");
    const first = await ws.readJob(b, "jaaaaaa2", 0, d);
    expect(first.output.length).toBe(ws.JOB_READ_CHUNK);
    expect(first.offset).toBe(ws.JOB_READ_CHUNK);
    const second = await ws.readJob(b, "jaaaaaa2", first.offset, d);
    const third = await ws.readJob(b, "jaaaaaa2", second.offset, d);
    expect(first.output.length + second.output.length + third.output.length).toBe(ws.JOB_READ_CHUNK * 2 + 1);
  });

  it("stops a long-running command and everything it started", async () => {
    const b = box();
    await ws.startJob(b, "jaaaaaa3", "sleep 30 & echo started; wait", d);
    await new Promise((res) => setTimeout(res, 400));
    expect((await ws.readJob(b, "jaaaaaa3", 0, d)).done).toBe(false);
    await ws.killJob(b, "jaaaaaa3", d);
    const r = await waitDone(b, "jaaaaaa3", 3000);
    expect(r.done).toBe(true);
    expect([143, 137, 129]).toContain(r.exitCode);
  });

  it("copies back what a command created, changed and removed — and nothing it didn't touch", async () => {
    const b = box();
    await ws.seedWorkspace(b, [{ path: "keep.txt", content: "keep" }, { path: "old.txt", content: "old" }, { path: "edit.txt", content: "v1" }], d);
    // Saved from the editor while the computer was on, but never copied in: must not be deleted.
    const saved = [
      { path: "keep.txt", content: "keep" },
      { path: "old.txt", content: "old" },
      { path: "edit.txt", content: "v1" },
      { path: "editor-only.txt", content: "mine" },
    ];
    await ws.startJob(b, "jaaaaaa4", "rm old.txt && echo v2 > edit.txt && mkdir -p gen node_modules/pkg && echo made > gen/new.txt && echo dep > node_modules/pkg/i.js && head -c 300000 /dev/zero > big.bin", d);
    const r = await waitDone(b, "jaaaaaa4");
    expect(r.exitCode).toBe(0);
    expect(await ws.claimSync(b, "jaaaaaa4", d)).toBe(true);
    expect(await ws.claimSync(b, "jaaaaaa4", d)).toBe(false);
    const c = await ws.collectFiles(b, r.startedAt - 1000, "jaaaaaa4", d);
    expect(c.paths).not.toContain("node_modules/pkg/i.js");
    expect(c.skipped).toContain("big.bin");
    const plan = ws.syncPlan(saved, c);
    expect(plan.upserts).toEqual(expect.arrayContaining([{ path: "edit.txt", content: "v2\n" }, { path: "gen/new.txt", content: "made\n" }]));
    expect(plan.upserts.map((f) => f.path)).not.toContain("keep.txt");
    expect(plan.deletes).toEqual(["old.txt"]);
  });

  it("deletes nothing when it can't tell what was there before", () => {
    expect(ws.syncPlan([{ path: "a", content: "" }], { paths: [], changed: {}, skipped: [], overflow: false, before: null }).deletes).toEqual([]);
    expect(ws.syncPlan([{ path: "a", content: "" }], { paths: [], changed: {}, skipped: [], overflow: true, before: ["a"] }).deletes).toEqual([]);
  });

  it("mirrors editor saves and deletes into the computer", async () => {
    const b = box();
    await ws.writeToWorkspace(b, [{ path: "dir/x.txt", content: "x" }], d);
    expect(readFileSync(join(d.root, "dir/x.txt"), "utf8")).toBe("x");
    await ws.removeFromWorkspace(b, ["dir/x.txt"], d);
    expect(existsSync(join(d.root, "dir/x.txt"))).toBe(false);
  });

  it("refuses job ids that could reach other files", () => {
    for (const bad of ["../x", "a b", "short", "J1234567", "x".repeat(40)]) expect(() => ws.jobScript(bad, d)).toThrow(/Invalid job id/);
    expect(ws.parseRead("- 10 123\nabc", 0)).toEqual({ output: "abc", offset: 10, done: false, exitCode: null, startedAt: 123 });
  });

  afterAll(() => {
    try {
      unlinkSync(join(d.root, "big.bin"));
    } catch {}
  });
});
