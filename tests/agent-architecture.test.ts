/**
 * The agent architecture as a whole: one valid catalogue of every agent
 * (with a role, boundaries, inputs, outputs, escalation and done criteria for
 * each); routing by declared capabilities, including the scenarios from the
 * architecture brief (simple → direct, research, coding, multi-step with
 * dependencies, safe parallel work, no suitable agent, an unavailable agent);
 * the task protocol; and permissions that can't be bypassed (every start
 * route checks access, a paused agent is refused everywhere, QA can only edit
 * tests).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { availability } from "@/lib/agent-platform/availability";
import { CAPABILITY_GAPS, CATALOGUE, catalogueProblems, entriesFor, type CatalogueEntry } from "@/lib/agent-platform/catalogue";
import { DELEGABLE } from "@/lib/agent-platform/delegation";
import { assignmentFor, resultFromActivity, TASK_STATES } from "@/lib/agent-platform/protocol";
import { AGENTS, AGENT_IDS, TASK_TYPES } from "@/lib/agent-platform/registry";
import { classify, firstProposable, route, routePrompt, type AvailabilityMap } from "@/lib/agent-platform/routing";
import { qaMayEdit } from "@/lib/code/agent/profiles";
import { parsePlatformSettings } from "@/lib/ai/platform";

const ALL: AvailabilityMap = Object.fromEntries(AGENT_IDS.map((id) => [id, { available: true }]));
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the catalogue: every agent, defined once", () => {
  it("is valid: unique ids, required fields, real references, known kinds of work", () => {
    expect(catalogueProblems()).toEqual([]);
  });

  it("finds problems when they exist", () => {
    const bad: CatalogueEntry = { ...CATALOGUE[0]!, id: "task:engineer", dependsOn: ["task:nobody"], version: "v1", taskTypes: ["fly" as never] };
    const problems = catalogueProblems([...CATALOGUE, bad]).join("; ");
    expect(problems).toMatch(/duplicate id task:engineer/);
    expect(problems).toMatch(/depends on unknown task:nobody/);
    expect(problems).toMatch(/version "v1"/);
    expect(problems).toMatch(/unknown task type fly/);
  });

  it("covers all eleven agent systems: orchestrator, planner, specialists, sub-agents, pipelines, assistants, internal", () => {
    const by = (level: string) => CATALOGUE.filter((e) => e.level === level).map((e) => e.id);
    expect(by("orchestrator")).toEqual(["orchestrator:orbis_agent"]);
    expect(by("planner")).toEqual(["planner:router"]);
    expect(by("specialist")).toEqual(AGENTS.map((a) => `task:${a.id}`));
    expect(by("sub_agent")).toEqual(expect.arrayContaining(["security:sentinel", "security:threat_hunter", "security:code_guardian", "pair:architect", "pair:reviewer"]));
    expect(by("pipeline")).toEqual(expect.arrayContaining(["pipeline:verify", "pipeline:council", "pipeline:arena", "pipeline:missions", "pipeline:images", "pipeline:connectors"]));
    expect(by("assistant")).toHaveLength(6);
    expect(by("internal")).toContain("workforce:commander");
  });

  it("every task agent has one role, boundaries, input, output, escalation, done criteria, a version and its usage purposes", () => {
    for (const a of AGENTS) {
      expect(a.role.length, a.id).toBeGreaterThan(10);
      expect(a.taskTypes.length, a.id).toBeGreaterThan(0);
      expect(a.outOfScope.length, a.id).toBeGreaterThan(0);
      expect(a.escalation.length, a.id).toBeGreaterThan(0);
      expect(a.doneWhen, a.id).toBeTruthy();
      expect(a.purposes.length, a.id).toBeGreaterThan(0);
      for (const h of a.handsOffTo) expect(AGENT_IDS, `${a.id} hands off to ${h}`).toContain(h);
      for (const o of a.outOfScope) if (o.useInstead) expect([...AGENT_IDS, "verify"], o.useInstead).toContain(o.useInstead);
    }
  });

  it("planned agents (Incident Responder, Threat Intelligence, Workforce Optimizer and Visual) offer no work", () => {
    const planned = CATALOGUE.filter((e) => e.status === "planned");
    expect(planned.map((e) => e.id)).toEqual(expect.arrayContaining(["security:incident_responder", "security:threat_intel", "workforce:optimizer", "workforce:visual"]));
    for (const e of planned) expect(e.taskTypes).toEqual([]);
  });

  it("overlaps are resolved by boundaries: chat assistants point to the agent that does real work", () => {
    const coding = CATALOGUE.find((e) => e.id === "assistant:coding")!;
    expect(coding.outOfScope.find((o) => /Running code/.test(o.what))!.useInstead).toBe("task:engineer");
    expect(CATALOGUE.find((e) => e.id === "assistant:research")!.outOfScope[0]!.useInstead).toBe("task:deep_research");
    // The Data Analyst task agent and the data assistant are the same thing, and say so.
    expect(CATALOGUE.find((e) => e.id === "assistant:data")!.taskAgent).toBe("data_analyst");
    // For each kind of work, the specialist comes before the assistant.
    expect(entriesFor("explain_code")[0]!.id).toBe("task:engineer");
    expect(entriesFor("web_research")[0]!.id).toBe("task:deep_research");
  });

  it("names the kinds of work nothing in Orbis does", () => {
    expect(CAPABILITY_GAPS).toEqual(["deploy", "manage_infrastructure", "make_purchase", "schedule_automation"]);
    expect(TASK_TYPES.filter((t) => !CAPABILITY_GAPS.includes(t)).every((t) => entriesFor(t).length > 0)).toBe(true);
  });
});

describe("routing by capability (the brief's scenarios)", () => {
  it("a simple question is answered directly, without delegating", () => {
    for (const m of ["What's the capital of Portugal?", "Write a short thank-you email to my landlord", "Summarise this paragraph for me"]) {
      expect(route(m, ALL).mode, m).toBe("direct");
    }
  });

  it("a research request goes to Deep Research", () => {
    const r = route("Research the market size for AI note-taking apps with sources", ALL);
    expect(r.mode).toBe("delegate");
    expect(r.steps.map((s) => s.agent)).toEqual(["task:deep_research"]);
    expect(firstProposable(r)).toBe("deep_research");
  });

  it("a coding request goes to the Software Engineer", () => {
    const r = route("Implement a login page with email and password in my app", ALL);
    expect(r.steps.map((s) => s.agent)).toEqual(["task:engineer"]);
    expect(r.steps[0]!.writes).toBe(true);
  });

  it("a multi-step request is planned in order: fix first, then tests and review side by side (the Fix and verify workflow)", () => {
    const r = route("Fix the crash in checkout, then write tests for it and review the changes", ALL);
    expect(r.mode).toBe("plan");
    const by = Object.fromEntries(r.steps.map((s) => [s.agent, s]));
    expect(by["task:bug_fixer"]!.dependsOn).toEqual([]);
    expect(by["task:qa_tester"]!.dependsOn).toEqual([by["task:bug_fixer"]!.id]);
    expect(by["task:code_review"]!.dependsOn).toEqual([by["task:bug_fixer"]!.id]);
    expect(by["task:qa_tester"]!.parallelWith).toEqual([by["task:code_review"]!.id]);
    expect(r.mode === "plan" && r.workflow).toBe("fix_and_verify");
    expect(firstProposable(r)).toBe("bug_fixer");
    expect(routePrompt(r)).toMatch(/Propose only the first step/);
  });

  it("independent work runs in parallel: research and a code review don't depend on each other", () => {
    const r = route("Review the code in my repo for security problems and research our competitors' pricing", ALL);
    expect(r.steps.map((s) => s.agent).sort()).toEqual(["task:code_review", "task:deep_research"]);
    for (const s of r.steps) {
      expect(s.dependsOn).toEqual([]);
      expect(s.parallelWith).toHaveLength(1);
    }
  });

  it("research comes before building when both are asked", () => {
    const r = route("Research the best charting libraries, then build a dashboard component with the winner", ALL);
    const build = r.steps.find((s) => s.agent === "task:engineer")!;
    const research = r.steps.find((s) => s.agent === "task:deep_research")!;
    expect(build.dependsOn).toEqual([research.id]);
  });

  it("two steps that change the same project never run at once", () => {
    const r = route("Fix the bug in the cart and also add a wishlist feature", ALL);
    const writers = r.steps.filter((s) => s.writes);
    expect(writers).toHaveLength(2);
    expect(writers[1]!.dependsOn).toContain(writers[0]!.id);
    expect(writers[0]!.parallelWith).not.toContain(writers[1]!.id);
  });

  it("no suitable agent: the gap is reported instead of routing to an unsuitable agent", () => {
    const r = route("Deploy my app to AWS and set up the servers", ALL);
    expect(r.mode).toBe("gap");
    expect(r.gaps).toEqual(expect.arrayContaining(["deploy", "manage_infrastructure"]));
    expect(routePrompt(r)).toMatch(/Capability gap: no Orbis agent can deploy or publish/);
    expect(r.steps).toEqual([]);
  });

  it("partly possible: the possible part is routed and the impossible part named", () => {
    const r = route("Build a landing page for my bakery and deploy it", ALL);
    expect(r.steps.map((s) => s.agent)).toEqual(["task:website_builder"]);
    expect(r.gaps).toEqual(["deploy"]);
  });

  it("an agent the user can't use isn't proposed, and the reason is passed on", () => {
    const r = route("Research the latest developments in battery chemistry", { ...ALL, deep_research: { available: false, message: "Included in Pro and Max." } });
    expect(r.steps[0]).toMatchObject({ agent: "task:deep_research", available: false, unavailable: "Included in Pro and Max." });
    expect(firstProposable(r)).toBeNull();
    expect(routePrompt(r)).toMatch(/not available to this user \(Included in Pro and Max\.\); say so and don't propose it/);
  });

  it("agents the orchestrator can't start are pointed to, not proposed", () => {
    const sec = route("Scan my website https://example.com for security headers", ALL);
    expect(sec.steps.map((s) => [s.agent, s.how])).toEqual([["task:security", "open"]]);
    const code = route("Audit this code for security vulnerabilities", ALL);
    expect(code.steps.map((s) => s.agent)).toEqual(["task:code_review"]);
    const data = route("Analyze this CSV of sales numbers", ALL);
    expect(data.steps[0]!.how).toBe("open");
  });

  it("classifies the brief's kinds of work", () => {
    expect(classify("Write unit tests for the parser")).toEqual(["write_tests"]);
    expect(classify("Send an email to my team about the launch")).toEqual(["send_message"]);
    expect(classify("Check these claims: fact-check the article")).toContain("verify_claims");
    expect(classify("Compare GPT and Claude on this prompt")).toContain("compare_models");
    expect(classify("Run this every Monday morning")).toEqual(["schedule_automation"]);
  });

  it("everyday phrases aren't mistaken for work (review findings)", () => {
    const cls = (m: string) => classify(m).sort();
    expect(cls("Refactor the auth module in order to make it testable")).toEqual(["implement_feature"]);
    expect(cls("I run this script every day and it throws an error")).toEqual(["fix_bug"]);
    expect(cls("What is social security?")).toEqual([]);
    expect(route("What is social security?", ALL).mode).toBe("direct");
    expect(cls("Investigate why my app crashes")).toEqual(["fix_bug"]);
    expect(cls("Make the icon bigger in the navbar")).not.toContain("generate_image");
    expect(cls("Change the author name")).not.toContain("implement_feature");
    // …while the real requests still match.
    expect(cls("Check my website's security")).toContain("security_audit");
    expect(cls("Scan my code for vulnerabilities")).toContain("security_audit");
    expect(cls("Create a logo for my bakery")).toContain("generate_image");
    expect(cls("Generate images of a sunset")).toContain("generate_image");
    expect(cls("Buy the domain orbis.dev for me")).toContain("make_purchase");
    expect(cls("Order some business cards for me")).toContain("make_purchase");
    expect(cls("Add authentication to my app")).toContain("implement_feature");
    expect(cls("Research the market size for vegan snacks")).toContain("web_research");
    expect(cls("Send our customers the newsletter every Friday")).toContain("schedule_automation");
  });
});

describe("the task protocol", () => {
  it("an assignment carries the agent's scope, constraints, expected output and done criteria, and only the task's context", () => {
    const a = assignmentFor("bug_fixer", { objective: "Discount total is wrong", projectId: "p1", inputs: { summary: "given" }, taskId: "t1" });
    expect(a).toMatchObject({ taskId: "t1", agent: "bug_fixer", agentVersion: "1.0", projectId: "p1", inputs: { summary: "given" } });
    expect(a.scope).toMatch(/Reproduce a reported bug/);
    expect(a.constraints.some((c) => c.startsWith("Needs approval: The plan"))).toBe(true);
    expect(a.constraints.some((c) => c.startsWith("Not in scope: New features"))).toBe(true);
    expect(a.expectedOutput).toMatch(/patch/);
    expect(a.doneWhen).toMatch(/Before the fix/);
    expect(() => assignmentFor("nobody" as never, { objective: "x" })).toThrow();
  });

  it("results use one set of states, built only from the task's records", () => {
    expect(TASK_STATES).toEqual(["pending", "ready", "running", "waiting_dependency", "waiting_user", "completed", "failed", "cancelled"]);
    const item = {
      kind: "code_run" as const,
      agent: "engineer" as const,
      id: "r1",
      title: "Add login",
      href: "/code/p?run=r1",
      projectName: "App",
      createdAt: "",
      updatedAt: "",
      outcome: null,
      outcomeNote: null,
      failure: null,
      progress: null,
      costUsd: null,
      cancelUrl: null,
      stalled: false,
    };
    expect(resultFromActivity({ ...item, status: "awaiting_approval", detail: "Approve the plan" })).toMatchObject({
      state: "waiting_user",
      unresolved: ["Approve the plan"],
      next: "Approve the plan",
    });
    expect(resultFromActivity({ ...item, status: "failed", detail: "No model available" })).toMatchObject({ state: "failed", errors: ["No model available"] });
    expect(resultFromActivity({ ...item, status: "completed", detail: "2 files changed · tests passed" })).toMatchObject({
      state: "completed",
      evidence: ["2 files changed · tests passed"],
      errors: [],
    });
  });
});

describe("permissions and boundaries", () => {
  it("every route that starts an agent's task checks the agent's access (plan, configuration, pause)", () => {
    const routes: [string, string][] = [
      ["src/app/api/code/projects/[id]/agent/route.ts", '"engineer"'],
      ["src/app/api/review/route.ts", '"code_review"'],
      ["src/app/api/research/route.ts", '"deep_research"'],
      ["src/app/api/security/sentinel/route.ts", '"security"'],
      ["src/app/api/security/hunter/route.ts", '"security"'],
      ["src/app/api/security/guardian/route.ts", '"security"'],
      ["src/app/api/security/coordinate/route.ts", '"security"'],
      ["src/lib/agent-platform/tasks.ts", "t.agent"],
      ["src/lib/agent-platform/delegate-server.ts", "agent"],
    ];
    for (const [file, id] of routes) expect(read(file), file).toContain(`assertAgentAccess(auth, ${id})`);
    // Workflows start each step through those same functions, so a step can't bypass its agent's rules.
    const wf = read("src/lib/agent-platform/workflow-server.ts");
    expect(wf).toContain("startProfileTask(");
    expect(wf).toContain("createReview(");
    expect(wf).toMatch(/for \(const s of TEMPLATE_INFO\[input\.template\]\.steps\) if \(s\.agent\) await assertAgentAccess/);
  });

  it("a paused agent is refused for everyone, administrators included", () => {
    const def = AGENTS.find((a) => a.id === "bug_fixer")!;
    const flags = { ai: true, anthropic: true, sandbox: true, accounts: true };
    expect(availability(def, flags, "max", true, ["bug_fixer"]).state).toBe("paused");
    expect(availability(def, flags, "max", true, []).state).toBe("available");
    expect(parsePlatformSettings({}).pausedAgents).toEqual([]);
    expect(read("src/lib/agent-platform/server.ts")).toMatch(/if \(a\.state === "paused"\) throw new ApiError/);
  });

  it("agents can't start other agents: only the user (a card, a page) or a workflow template starts tasks", () => {
    // The orchestrator only proposes; its proposals are limited to the agents it may delegate to.
    expect([...DELEGABLE].sort()).toEqual(["bug_fixer", "code_review", "deep_research", "engineer", "qa_tester"]);
    // No coding-agent tool starts a task of another agent.
    const tools = read("src/lib/code/agent/tool-specs.ts");
    expect(tools).not.toMatch(/startProfileTask|createReview|createResearch|startDelegated/);
  });

  it("QA Testing's declared permission (test files only) is what the runtime enforces", () => {
    expect(AGENTS.find((a) => a.id === "qa_tester")!.permissions).toContain("edit_tests_only");
    expect(AGENTS.find((a) => a.id === "qa_tester")!.permissions).not.toContain("edit_files");
    expect(qaMayEdit("src/cart.test.ts")).toBe(true);
    expect(qaMayEdit("tests/helpers/fixture.js")).toBe(true);
    expect(qaMayEdit("src/cart.ts")).toBe(false);
    expect(qaMayEdit("src/app/api/orders/route.ts")).toBe(false);
    // The manifest is allowed on purpose (to add a test script or dev dependency).
    expect(qaMayEdit("package.json")).toBe(true);
  });

  it("read-only agents declare no edit permission", () => {
    for (const id of ["code_review", "deep_research", "security", "data_analyst"] as const) {
      const p = AGENTS.find((a) => a.id === id)!.permissions;
      expect(p, id).not.toContain("edit_files");
      expect(p, id).not.toContain("run_commands");
    }
  });
});

describe("the agent directory", () => {
  it("gets the whole catalogue intact (it's sent from the server page to the browser as plain data)", () => {
    expect(JSON.parse(JSON.stringify(CATALOGUE))).toEqual(CATALOGUE);
  });

  it("pausing is a real control: only task agents can be paused, and the route accepts exactly those", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/admin/agents/route.ts"), "utf8");
    expect(route).toContain("requireAdmin");
    expect(route).toContain("z.enum(AGENT_IDS)");
    for (const e of CATALOGUE.filter((c) => c.level === "specialist")) expect(AGENT_IDS, e.id).toContain(e.taskAgent);
  });
});
