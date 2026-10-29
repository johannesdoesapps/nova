import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No direct execution paths around Bastion: every place that can run a command, push code, act in a connected
 * service, run code, change Bastion's settings, write workspace roles or change the audit trail is listed here
 * by file. A new call site fails this test until it's reviewed — and each listed route also calls Bastion.
 */

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const SRC = files("src").map((p) => ({ path: p.replace(/\\/g, "/"), text: readFileSync(p, "utf8") }));
const callers = (needle: string | RegExp) =>
  SRC.filter((f) => (typeof needle === "string" ? f.text.includes(needle) : needle.test(f.text)))
    .map((f) => f.path)
    .sort();

const SENSITIVE: [string, string | RegExp, string[]][] = [
  // Commands in a project's computer: the agent engine (guarded in execCommand), the user's terminal route (guarded),
  // the preview helper (called only by the guarded engine), the sandbox client itself, and the Workforce sandbox (ticks guarded).
  [
    "start a job in a project computer",
    "startJob(",
    ["src/app/api/code/projects/[id]/exec/route.ts", "src/lib/code/agent/engine.ts", "src/lib/code/preview.ts", "src/lib/code/workspace.ts", "src/lib/workforce/sandbox-vercel.ts"],
  ],
  ["run an agent command", "execCommand(", ["src/lib/code/agent/engine.ts", "src/lib/code/pair/engine.ts"]],
  // Rewinding a session (sessions.ts) is the user putting files back, like revert; the agent's own changes pass Bastion in saveChanges.
  ["save an agent's file changes", "saveChanges(", ["src/lib/code/agent/engine.ts", "src/lib/code/agent/sessions.ts", "src/lib/code/pair/engine.ts"]],
  ["start a preview server", "startPreview(", ["src/lib/code/agent/engine.ts", "src/lib/code/preview.ts"]],
  // The Push dialog and the agent's approved github_push both go through pushProject, which calls Bastion first.
  ["push to GitHub", "pushBranch(", ["src/lib/code/github-push.ts", "src/lib/github/push.ts"]],
  ["act in a connected service", "runAction(", ["src/app/api/connectors/actions/route.ts", "src/lib/connectors/runtime.ts"]],
  ["run a code block", "runCode(", ["src/app/api/code/run/route.ts", "src/lib/code/run.ts"]],
  ["disconnect a connected service", "forgetConnection(", ["src/app/api/bastion/workspace/route.ts", "src/app/api/connectors/[id]/route.ts", "src/lib/connectors/runtime.ts"]],
  ["write workspace roles", /bastion_workspace_roles"\)\.(upsert|insert|update|delete)/, ["src/app/api/bastion/workspace/route.ts"]],
  ["change platform settings", /from\("app_settings"\)\s*\.(update|upsert|insert)/, ["src/app/api/admin/agents/route.ts", "src/app/api/admin/bastion/route.ts", "src/app/api/admin/settings/route.ts"]],
];

describe("no execution path around Bastion", () => {
  for (const [what, needle, allowed] of SENSITIVE)
    it(`only reviewed code can ${what}`, () => {
      expect(callers(needle)).toEqual(allowed);
    });

  it("every route that runs, pushes, acts or exports checks Bastion before it does", () => {
    for (const p of [
      "src/app/api/code/projects/[id]/exec/route.ts",
      "src/lib/code/github-push.ts",
      "src/app/api/code/run/route.ts",
      "src/app/api/code/projects/[id]/download/route.ts",
      "src/app/api/workforce/tasks/[id]/advance/route.ts",
      "src/app/api/admin/bastion/route.ts",
      "src/app/api/security/sentinel/route.ts",
      "src/app/api/security/coordinate/route.ts",
    ])
      expect(SRC.find((f) => f.path === p)!.text, p).toMatch(/\benforce\(/);
    // The executors themselves call Bastion where the work happens.
    const engine = SRC.find((f) => f.path === "src/lib/code/agent/engine.ts")!.text;
    for (const fn of ["export async function execCommand", "export async function saveChanges"]) {
      const body = engine.slice(engine.indexOf(fn), engine.indexOf(fn) + 1600);
      expect(body, fn).toMatch(/bastionGuard\(/);
    }
    const runtime = SRC.find((f) => f.path === "src/lib/connectors/runtime.ts")!.text;
    for (const fn of ["export async function runTool", "export async function runAction"]) expect(runtime.slice(runtime.indexOf(fn), runtime.indexOf(fn) + 2200), fn).toMatch(/\bguard\(/);
  });

  it("settings writers keep Bastion's controls; only the Bastion route changes them", () => {
    for (const p of ["src/app/api/admin/agents/route.ts", "src/app/api/admin/settings/route.ts"]) {
      const t = SRC.find((f) => f.path === p)!.text;
      expect(t, p).toMatch(/\.\.\.raw|storedRaw\.bastion/);
    }
  });

  it("nothing in Orbis changes or deletes security audit records", () => {
    expect(callers(/security_audit"\)\s*\.(update|delete|upsert)/)).toEqual([]);
  });

  it("agents can't reach Bastion's administration: those routes require an administrator", () => {
    for (const p of ["src/app/api/admin/bastion/route.ts"]) expect(SRC.find((f) => f.path === p)!.text).toMatch(/requireAdmin\(/);
  });
});
