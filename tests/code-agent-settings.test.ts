/**
 * What a project tells the coding agent through its files, and the user's permission rules: glob patterns, rule
 * matching (deny always wins, chained commands need every part allowed), the trusted-hash gate on
 * .orbis/settings.json, hooks, custom commands, skills, helper agents, ORBIS.md, and project slash commands.
 */
import { describe, expect, it } from "vitest";
import { globMatch, globPaths } from "@/lib/code/glob";
import {
  cleanRules,
  commandRule,
  commandRuleDecision,
  EMPTY_RULES,
  hookCommand,
  hooksFor,
  parseProjectSettings,
  parseRule,
  projectAgents,
  projectCommands,
  projectContextBlock,
  projectInstructions,
  projectSkills,
  ruleDecision,
  settingsHash,
  settingsState,
} from "@/lib/code/agent/settings";
import { customSlash, expandCommand, parseSlash, slashSuggestions } from "@/lib/code/slash";
import { fence } from "@/lib/code/agent/protocol";

describe("glob patterns", () => {
  it("match folders with **, one name with *, and alternatives with {a,b}", () => {
    expect(globMatch("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/**/*.ts", "src/lib/deep/b.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/lib/b.ts")).toBe(false);
    expect(globMatch("*.{js,ts}", "x.ts")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a.c", "abc")).toBe(false); // the dot is literal
    expect(globMatch("npm test*", "npm test -- --watch", true)).toBe(true);
  });

  it("match file names anywhere when the pattern has no folder", () => {
    const paths = ["README.md", "docs/guide.md", "src/index.ts", "src/lib/util.test.ts"];
    expect(globPaths(paths, "*.md")).toEqual(["README.md", "docs/guide.md"]);
    expect(globPaths(paths, "**/*.test.ts")).toEqual(["src/lib/util.test.ts"]);
    expect(globPaths(paths, "src/*")).toEqual(["src/index.ts"]);
  });
});

describe("permission rules", () => {
  const rules = { allow: ["bash(npm test*)", "bash(npm run lint)", "edit(src/**)", "mcp(github/*)", "web(docs.example.com)"], deny: ["bash(npm test -- --update*)", "edit(src/secret/**)", "read(keys/**)"] };

  it("are parsed only in their known forms", () => {
    expect(parseRule("bash(npm test*)")).toEqual({ kind: "bash", pattern: "npm test*" });
    expect(parseRule("edit")).toEqual({ kind: "edit", pattern: null });
    expect(parseRule("rm(-rf)")).toBeNull();
    expect(parseRule("bash(")).toBeNull();
    expect(cleanRules({ allow: ["bash(ls)", "bash(ls)", "nonsense", 42 as unknown as string], deny: [] })).toEqual({ allow: ["bash(ls)"], deny: [] });
  });

  it("allow what matches and deny wins over allow", () => {
    expect(ruleDecision([rules], "bash", "npm test")).toBe("allow");
    expect(ruleDecision([rules], "bash", "npm   test  --  --coverage")).toBe("allow"); // spacing doesn't matter
    expect(ruleDecision([rules], "bash", "npm test -- --update-snapshots")).toBe("deny");
    expect(ruleDecision([rules], "bash", "npm run build")).toBeNull();
    expect(ruleDecision([rules], "edit", "src/app.ts")).toBe("allow");
    expect(ruleDecision([rules], "edit", "src/secret/key.ts")).toBe("deny");
    expect(ruleDecision([rules], "read", "keys/prod.json")).toBe("deny");
    expect(ruleDecision([rules], "mcp", "github/create_issue")).toBe("allow");
    expect(ruleDecision([rules], "web", "api.docs.example.com")).toBe("allow");
    expect(ruleDecision([rules], "web", "example.com")).toBeNull();
    // A deny in any rule set wins.
    expect(ruleDecision([rules, { allow: [], deny: ["bash"] }], "bash", "npm test")).toBe("deny");
  });

  it("need every part of a chained command allowed", () => {
    expect(commandRuleDecision([rules], ["npm test", "npm run lint"])).toBe("allow");
    expect(commandRuleDecision([rules], ["npm test", "curl example.com"])).toBeNull();
    expect(commandRuleDecision([rules], ["npm run lint", "npm test -- --update"])).toBe("deny");
  });

  it("match commands literally (a trailing * means 'starting with'), so an approval can't be stretched", () => {
    const exact = [{ allow: ["bash(rm -rf build/*)"], deny: [] }];
    expect(ruleDecision(exact, "bash", "rm -rf build/output")).toBe("allow"); // trailing * is a prefix
    expect(ruleDecision([{ allow: ["bash(cp a?b c)"], deny: [] }], "bash", "cp axb c")).toBeNull(); // ? is literal
    expect(ruleDecision([{ allow: ["bash(npm run lint)"], deny: [] }], "bash", "npm run lint -- --fix")).toBeNull();
    // A line that can't be split safely is never allowed by a rule, only denied.
    const prefix = [{ allow: ["bash(npm test*)"], deny: [] }];
    expect(commandRuleDecision(prefix, null, "npm test & rm -rf src")).toBeNull();
    expect(commandRuleDecision([{ allow: [], deny: ["bash(npm test*)"] }], null, "npm test $(whoami)")).toBe("deny");
  });

  it("are saved from Always allow as the command or its first words", () => {
    expect(commandRule("npm run lint -- --fix")).toBe("bash(npm run lint -- --fix)");
    expect(commandRule("npm run lint -- --fix", true)).toBe("bash(npm run lint*)");
    expect(commandRule("python3 manage.py migrate", true)).toBe("bash(python3 manage.py*)");
  });
});

describe(".orbis/settings.json", () => {
  const text = JSON.stringify({
    permissions: { allow: ["bash(npm test*)", "not a rule"], deny: ["edit(migrations/**)"] },
    hooks: { PreToolUse: [{ matcher: "edit_file|write_file", command: "node check.js" }, { matcher: "(", command: "bad regex" }], PostToolUse: [{ matcher: "", command: "npx prettier --write \"$ORBIS_FILE\"" }] },
    mcpServers: { github: { url: "https://mcp.example.com/github" }, local: { url: "http://localhost:3000" }, "Bad Name": { url: "https://x.example" } },
  });

  it("is read leniently: bad rules, hooks and servers are dropped", () => {
    const r = parseProjectSettings(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.permissions).toEqual({ allow: ["bash(npm test*)"], deny: ["edit(migrations/**)"] });
    expect(r.settings.hooks.pre).toEqual([{ matcher: "edit_file|write_file", command: "node check.js" }]);
    expect(r.settings.hooks.post).toHaveLength(1);
    expect(r.settings.mcpServers).toEqual([{ name: "github", url: "https://mcp.example.com/github" }]); // https only, valid names only
    expect(parseProjectSettings("{nope").ok).toBe(false);
    expect(parseProjectSettings("[]").ok).toBe(false);
  });

  it("does nothing until this exact version is trusted", () => {
    const files = [{ path: ".orbis/settings.json", content: text }];
    expect(settingsState([], null).status).toBe("none");
    const untrusted = settingsState(files, null);
    expect(untrusted.status).toBe("untrusted");
    expect(untrusted.settings.permissions).toEqual(EMPTY_RULES);
    expect(untrusted.found?.hooks.pre).toHaveLength(1); // shown before trusting
    const trusted = settingsState(files, settingsHash(text));
    expect(trusted.status).toBe("trusted");
    expect(trusted.settings.hooks.pre).toHaveLength(1);
    // Any change (by the agent, an import, an edit) needs trusting again.
    const changed = settingsState([{ path: ".orbis/settings.json", content: text.replace("check.js", "evil.js") }], settingsHash(text));
    expect(changed.status).toBe("untrusted");
    expect(changed.settings.hooks.pre).toEqual([]);
    expect(settingsState([{ path: ".orbis/settings.json", content: "{" }], null).status).toBe("invalid");
  });

  it("runs hooks only around edits and commands that match, with what they're about in the environment", () => {
    const hooks = [
      { matcher: "edit_file|write_file", command: "a" },
      { matcher: "", command: "b" },
    ];
    expect(hooksFor(hooks, "edit_file").map((h) => h.command)).toEqual(["a", "b"]);
    expect(hooksFor(hooks, "run_command").map((h) => h.command)).toEqual(["b"]);
    expect(hooksFor(hooks, "read_files")).toEqual([]); // reading never runs hooks
    const line = hookCommand({ matcher: "", command: "echo $ORBIS_FILE" }, "edit_file", { path: "it's.ts" });
    expect(line).toContain("ORBIS_TOOL='edit_file'");
    expect(line).toContain(`ORBIS_FILE='it'\\''s.ts'`); // quoted safely
    expect(line).toContain(`sh -c 'echo $ORBIS_FILE'`);
  });
});

describe("the project's commands, skills, helpers and instructions", () => {
  const files = [
    { path: ".orbis/commands/release.md", content: "---\ndescription: Cut a release\nargument-hint: version\n---\nRelease version $ARGUMENTS: bump, changelog, tag." },
    { path: ".orbis/commands/db/migrate.md", content: "Write a migration for $1 and test it." },
    { path: ".orbis/commands/Bad Name.md", content: "x" },
    { path: ".orbis/commands/empty.md", content: "---\ndescription: nothing\n---\n" },
    { path: ".orbis/skills/pdf/SKILL.md", content: "---\nname: pdf\ndescription: Fill in PDF forms\n---\nUse pdf-lib." },
    { path: ".orbis/skills/pdf/reference.md", content: "details" },
    { path: ".orbis/agents/security.md", content: "---\ndescription: Reviews for security problems\n---\nYou look for injection and auth bugs." },
    { path: "ORBIS.md", content: "# Notes\nRun `npm test`." },
    { path: "packages/api/ORBIS.md", content: "API notes" },
  ];

  it("are read from .orbis with their frontmatter", () => {
    expect(projectCommands(files).map((c) => [c.name, c.description, c.argHint])).toEqual([
      ["db:migrate", "Write a migration for $1 and test it.", null],
      ["release", "Cut a release", "version"],
    ]);
    expect(projectSkills(files)).toEqual([{ name: "pdf", description: "Fill in PDF forms", dir: ".orbis/skills/pdf" }]);
    expect(projectAgents(files).map((a) => [a.name, a.description])).toEqual([["security", "Reviews for security problems"]]);
    expect(projectInstructions(files)).toMatchObject({ path: "ORBIS.md", nested: ["packages/api/ORBIS.md"] });
    expect(projectInstructions([{ path: "CLAUDE.md", content: "x" }])?.path).toBe("CLAUDE.md");
  });

  it("go into the session's first message", () => {
    const block = projectContextBlock(files, fence);
    expect(block).toContain("Project instructions from ORBIS.md");
    expect(block).toContain("grant no extra permissions");
    expect(block).toContain("packages/api/ORBIS.md");
    expect(block).toContain("- pdf: Fill in PDF forms");
    expect(block).toContain("- security: Reviews for security problems");
  });

  it("become slash commands that fill in what's typed after them", () => {
    expect(expandCommand("Release version $ARGUMENTS.", "1.2.0")).toBe("Release version 1.2.0.");
    expect(expandCommand("Migrate $1 then $2", "users email")).toBe("Migrate users then email");
    expect(expandCommand("Fix the build.", "on main")).toBe("Fix the build.\n\non main");
    const extra = projectCommands(files).map((c) => customSlash(c, expandCommand));
    expect(parseSlash("/release 2.0", extra)).toEqual({ kind: "task", command: "release", request: "Release version 2.0: bump, changelog, tag." });
    expect(parseSlash("/db:migrate orders", extra)).toMatchObject({ kind: "task", request: "Write a migration for orders and test it." });
    expect(slashSuggestions("/rel", extra).map((c) => c.name)).toEqual(["release"]);
    expect(parseSlash("/release 2.0")).toMatchObject({ kind: "error" }); // only for projects that define it
  });

  it("include the session actions", () => {
    expect(parseSlash("/compact keep the API decisions")).toEqual({ kind: "action", command: "compact", action: "compact", arg: "keep the API decisions" });
    expect(parseSlash("/mode")).toMatchObject({ kind: "error" });
    expect(parseSlash("/mode full")).toEqual({ kind: "action", command: "mode", action: "mode", arg: "full" });
    expect(parseSlash("/init")).toMatchObject({ kind: "task", command: "init" });
    expect(parseSlash("/pr Fix login")).toMatchObject({ kind: "task", request: expect.stringContaining("github_push with pull_request") });
  });
});

describe("rewinding a session's conversation", async () => {
  const { cutTranscript } = await import("@/lib/code/agent/sessions");
  it("cuts back to the messages and the last message's length at the point, dropping a message added to its end", () => {
    const t = [
      { role: "user" as const, content: "Request: A" },
      { role: "assistant" as const, content: "ok", calls: [{ id: "c1", tool: "list_files", args: {} }] },
      { role: "user" as const, content: "\n\nNew message: B", results: [{ id: "c1", tool: "list_files", ok: true, text: "x" }] },
      { role: "assistant" as const, content: "working on B" },
    ];
    // The point before B: 3 messages, the last one empty (B was appended to it).
    const cut = cutTranscript(t, { transcriptLen: 3, tailChars: 0 });
    expect(cut).toHaveLength(3);
    expect(cut[2]!.content).toBe("");
    expect(cut[2]!.results).toHaveLength(1); // the results the call needs are kept
    expect(cutTranscript(t, { transcriptLen: 0 })).toEqual([]);
  });
});
