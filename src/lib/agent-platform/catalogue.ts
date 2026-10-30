import { builtinAgents } from "../agents/builtins";
import type { BuiltinAgentId } from "../agents/types";
import { SECURITY_AGENTS } from "../security/agents";
import { AGENTS as WORKFORCE_AGENTS } from "../workforce/agents";
import { AGENTS, PERMISSION_LABEL, TASK_TYPES, type AgentDef, type TaskType, type ToolPermission } from "./registry";

/**
 * Every AI agent in Orbis, in one place: the orchestrator, its planner, the
 * specialist task agents, their sub-agents, the chat assistants, the
 * multi-model pipelines and the internal (administrator) Workforce. Each entry
 * says what it's for, where its boundaries are, what it can use, what it
 * takes and gives, who it reports to, and its status and version.
 *
 * Built from the lists the runtimes themselves use (the task registry, the
 * Security Team, the Workforce and the built-in assistants), so a definition
 * is never written twice: this file only adds how they fit together. The
 * router (routing.ts), the agent directory and the docs read it, and the
 * tests check it with `catalogueProblems`.
 */

export type Level = "orchestrator" | "planner" | "specialist" | "sub_agent" | "assistant" | "pipeline" | "internal";

export const LEVEL_INFO: Record<Level, { label: string; description: string; order: number }> = {
  orchestrator: { label: "Orchestrator", description: "Receives the request, answers simple ones itself, and hands specialist work to the right agent.", order: 0 },
  planner: { label: "Planning", description: "Breaks a request into steps for specific agents, in order, with what can run side by side.", order: 1 },
  specialist: { label: "Specialist agents", description: "Do one kind of real work with real tools, each in its own task with approvals and records.", order: 2 },
  sub_agent: { label: "Sub-agents and capabilities", description: "Parts of another agent, run by it; not started on their own.", order: 3 },
  pipeline: { label: "Multi-model tools", description: "Fixed pipelines across several models (compare, verify, plan); started from their own pages.", order: 4 },
  assistant: { label: "Chat assistants", description: "Text-only helpers with their own instructions. They can't run code or take actions; they point to the agent that can.", order: 5 },
  internal: { label: "Internal (administrators)", description: "Orbis's own engineering team, run by its Commander for administrators only.", order: 6 },
};

export type Category = "Orchestration" | "Planning" | "Coding" | "Testing" | "Research" | "Security" | "Data" | "Writing" | "Design" | "Comparison";

export type CatalogueStatus = "active" | "planned" | "admin_only";

export interface CatalogueEntry {
  /** Unique across Orbis: "<kind>:<id>" (task:engineer, security:sentinel, assistant:coding, workforce:builder…). */
  id: string;
  name: string;
  level: Level;
  category: Category;
  /** The one thing it's responsible for. */
  role: string;
  responsibilities: string[];
  taskTypes: TaskType[];
  outOfScope: { what: string; useInstead: string | null }[];
  /** What it can actually use, in plain words. */
  tools: string[];
  input: string;
  output: string;
  /** When it stops and comes back to the user. */
  escalation: string[];
  doneWhen: string;
  /** Who runs it: the user directly, the orchestrator's proposal (still started by the user), a workflow, or its parent agent. */
  runsUnder: "user" | "orchestrator_or_user" | "parent" | "administrator";
  /** The entry it's part of, for sub-agents. */
  parent: string | null;
  /** Entries it hands work to or relies on. */
  dependsOn: string[];
  status: CatalogueStatus;
  /** Why it isn't active yet, for planned entries. */
  statusNote: string | null;
  version: string;
  /** What its usage is recorded under (model_runs.purpose). */
  purposes: string[];
  /** Who can use it. */
  access: string;
  /** Its page. */
  href: string | null;
  /** The task registry entry, for task agents (availability, permissions and plans live there). */
  taskAgent: AgentDef["id"] | null;
  /** Where it's defined. */
  source: string;
}

const CATEGORY_OF_TASK: Record<AgentDef["id"], Category> = {
  engineer: "Coding",
  code_review: "Testing",
  bug_fixer: "Coding",
  qa_tester: "Testing",
  security: "Security",
  deep_research: "Research",
  website_builder: "Design",
  data_analyst: "Data",
};

const plansText = (plans: string[]) => (plans.length === 3 ? "Every plan, signed in" : `${plans.map((p) => p[0]!.toUpperCase() + p.slice(1)).join(" and ")} plans, signed in`);

const ORCHESTRATOR: CatalogueEntry = {
  id: "orchestrator:orbis_agent",
  name: "Orbis Agent",
  level: "orchestrator",
  category: "Orchestration",
  role: "Understand the request, answer it directly when it's simple, and hand specialist work to the right agent",
  responsibilities: [
    "Classify the request with the router (routing.ts) and the agent list",
    "Answer questions and writing requests itself, without delegating",
    "Switch on Natural Writing (the Writing Agent's capability) when a message asks for natural, conversational, polished or personal writing, and run the writing check on the result",
    "Propose one specialist task at a time as a card the user reviews and starts",
    "For multi-step work, follow the planner's order (or the Fix and verify workflow)",
    "Say plainly when no Orbis agent can do something",
    "Answer questions about tasks from the user's task records, never from memory",
  ],
  taskTypes: ["answer_question", "write_text", "refine_writing"],
  outOfScope: [{ what: "Starting tasks by itself: every task is started by the user", useInstead: null }],
  tools: ["The chat model", "The agent list and the user's available agents", "The user's projects (names fenced as data)", "The user's task records"],
  input: "The user's chat message",
  output: "A reply; at most one task proposal (an orbis-task card); task status from records",
  escalation: [
    "Missing information (which project, the error message): it asks",
    "No agent can do the work: it says so",
    "An agent isn't available on the user's plan or this deployment: it says why",
  ],
  doneWhen: "The reply is sent; a proposed task is only 'started' once the user presses Start and the server accepts it",
  runsUnder: "user",
  parent: null,
  dependsOn: [
    "planner:router",
    ...AGENTS.filter((a) => ["engineer", "bug_fixer", "qa_tester", "code_review", "deep_research"].includes(a.id)).map((a) => `task:${a.id}`),
    "writing:natural-writing-agent",
  ],
  status: "active",
  statusNote: null,
  version: "2.0",
  purposes: ["chat"],
  access: "Signed-in users in Chat",
  href: "/chat",
  taskAgent: null,
  source: "src/lib/agent-platform/orbis-agent.ts, delegation.ts",
};

const PLANNER: CatalogueEntry = {
  id: "planner:router",
  name: "Task router and planner",
  level: "planner",
  category: "Planning",
  role: "Turn a request into the kinds of work it needs, the agents that do them, their order and what can run side by side",
  responsibilities: [
    "Recognise the kinds of work in a request (rules, no model call: fast, free and predictable)",
    "Match each kind to the agents that declare it, and check the user can use them",
    "Order steps: research before building, building before testing and review, testing and review side by side",
    "Report kinds of work no active agent does as gaps",
  ],
  taskTypes: [],
  outOfScope: [{ what: "Running tasks", useInstead: "orchestrator:orbis_agent" }],
  tools: ["The agent catalogue", "The user's agent availability"],
  input: "A request's text and the agents available to the user",
  output: "A route: answer directly, one task, a multi-step plan with dependencies, or a capability gap",
  escalation: ["Nothing recognised: the orchestrator answers directly"],
  doneWhen: "A route is returned",
  runsUnder: "parent",
  parent: "orchestrator:orbis_agent",
  dependsOn: [],
  status: "active",
  statusNote: null,
  version: "1.0",
  purposes: [],
  access: "Used by the Orbis Agent",
  href: null,
  taskAgent: null,
  source: "src/lib/agent-platform/routing.ts",
};

const taskEntry = (a: AgentDef): CatalogueEntry => ({
  id: `task:${a.id}`,
  name: a.name,
  level: "specialist",
  category: CATEGORY_OF_TASK[a.id],
  role: a.role,
  responsibilities: a.responsibilities,
  taskTypes: a.taskTypes,
  outOfScope: a.outOfScope.map((o) => ({ what: o.what, useInstead: o.useInstead ? (o.useInstead === "verify" ? "pipeline:verify" : `task:${o.useInstead}`) : null })),
  tools: a.permissions.map((p: ToolPermission) => PERMISSION_LABEL[p]),
  input: a.input,
  output: a.output,
  escalation: a.escalation,
  doneWhen: a.doneWhen,
  runsUnder: "orchestrator_or_user",
  parent: null,
  dependsOn: a.handsOffTo.map((h) => `task:${h}`),
  status: "active",
  statusNote: null,
  version: a.version,
  purposes: a.purposes,
  access: plansText(a.plans),
  href: a.href,
  taskAgent: a.id,
  source: "src/lib/agent-platform/registry.ts",
});

const securitySub = SECURITY_AGENTS.map(
  (s): CatalogueEntry => ({
    id: `security:${s.id}`,
    name: s.name,
    level: "sub_agent",
    category: "Security",
    role: s.role,
    responsibilities: s.capabilities,
    taskTypes: s.status === "active" ? ["security_audit"] : [],
    outOfScope: [{ what: "Applying fixes", useInstead: "task:engineer" }],
    tools: s.tools,
    input:
      s.id === "sentinel"
        ? "A website the user has proved they own"
        : s.id === "threat_hunter"
          ? "Uploaded logs"
          : s.id === "code_guardian"
            ? "Code: pasted, a repository or a project"
            : "Nothing yet: it isn't built",
    output: s.status === "active" ? "Scanner findings with evidence; AI explanations marked as such" : "Nothing yet: it isn't built",
    escalation: ["Ownership or scope not confirmed", "A scanner fails: reported as not run"],
    doneWhen: "Its checks have run (or are reported as not run) and findings are saved",
    runsUnder: "parent",
    parent: "task:security",
    dependsOn: [],
    status: s.status === "active" ? "active" : "planned",
    statusNote: s.status === "active" ? null : "Shown as planned; it has no tools and can't be started.",
    version: "1.0",
    purposes: ["security"],
    access: "Signed-in users",
    href: "/agents/security",
    taskAgent: null,
    source: "src/lib/security/agents.ts",
  }),
);

const PAIR: CatalogueEntry[] = [
  {
    id: "pair:architect",
    name: "Pair Coding: Architect",
    level: "sub_agent",
    category: "Coding",
    role: "Plan and write the change in a pair-coding task",
    responsibilities: ["Plan", "Implement", "Run tests", "Revise after each review"],
    taskTypes: ["implement_feature"],
    outOfScope: [{ what: "Reviewing its own work", useInstead: "pair:reviewer" }],
    tools: ["The Software Engineer's tools and command policy"],
    input: "The task and the Reviewer's notes",
    output: "Changes and test results",
    escalation: CODE_ESCALATION_SHORT(),
    doneWhen: "The Reviewer accepts, or the review rounds run out",
    runsUnder: "parent",
    parent: "task:engineer",
    dependsOn: ["pair:reviewer"],
    status: "active",
    statusNote: null,
    version: "1.0",
    purposes: ["pair_coding"],
    access: "Every plan, signed in",
    href: "/pair",
    taskAgent: null,
    source: "src/lib/code/pair/",
  },
  {
    id: "pair:reviewer",
    name: "Pair Coding: Reviewer",
    level: "sub_agent",
    category: "Testing",
    role: "Review the Architect's changes each round and accept or ask for changes",
    responsibilities: ["Read the diff and test results", "Ask for specific changes", "Accept when the work meets the request"],
    taskTypes: ["review_code"],
    outOfScope: [{ what: "Editing files", useInstead: "pair:architect" }],
    tools: ["Read the project and the task's changes"],
    input: "The task, the diff and the test results",
    output: "Accept, or a list of required changes",
    escalation: ["The rounds run out: the task ends with the open notes"],
    doneWhen: "It accepts, or the last round ends",
    runsUnder: "parent",
    parent: "task:engineer",
    dependsOn: [],
    status: "active",
    statusNote: null,
    version: "1.0",
    purposes: ["pair_coding"],
    access: "Every plan, signed in",
    href: "/pair",
    taskAgent: null,
    source: "src/lib/code/pair/",
  },
];

function CODE_ESCALATION_SHORT(): string[] {
  return ["The plan needs approval", "A command outside the safe list", "A limit is reached"];
}

const PIPELINES: CatalogueEntry[] = [
  {
    id: "pipeline:verify",
    name: "Verify",
    level: "pipeline",
    category: "Research",
    role: "Check the claims in a text against sources",
    responsibilities: [
      "Extract claims",
      "Find evidence in the user's documents and one web search",
      "Count a judgement only when its quote is found verbatim",
      "Optionally rewrite the text from the findings",
    ],
    taskTypes: ["verify_claims"],
    outOfScope: [{ what: "Open-ended research", useInstead: "task:deep_research" }],
    tools: ["The user's documents", "One web search (when search is set up)"],
    input: "A text, and optionally documents",
    output: "Each claim with a verdict and the quoted evidence",
    escalation: ["No sources found: the claim is marked unverified"],
    doneWhen: "Every claim has a verdict or is marked unverified",
    runsUnder: "user",
    parent: null,
    dependsOn: [],
    status: "active",
    statusNote: null,
    version: "1.0",
    purposes: ["verify", "claims", "hypotheses"],
    access: "Signed-in users",
    href: "/verify",
    taskAgent: null,
    source: "src/lib/verify/",
  },
  {
    id: "pipeline:council",
    name: "Council",
    level: "pipeline",
    category: "Comparison",
    role: "Several models answer, critique each other, and one reply is synthesised",
    responsibilities: ["Collect answers", "Critique", "Synthesise one reply"],
    taskTypes: ["compare_models"],
    outOfScope: [],
    tools: ["Several chat models", "Web sources (when search is set up)"],
    input: "A question and the models to ask",
    output: "Each model's answer and a combined reply",
    escalation: ["A model fails: the others continue and the failure is shown"],
    doneWhen: "The synthesis is written",
    runsUnder: "user",
    parent: null,
    dependsOn: [],
    status: "active",
    statusNote: null,
    version: "1.0",
    purposes: ["council", "council-critique", "council-synthesis", "web_search"],
    access: "Signed-in users",
    href: "/council",
    taskAgent: null,
    source: "src/lib/council/",
  },
  {
    id: "pipeline:arena",
    name: "Arena",
    level: "pipeline",
    category: "Comparison",
    role: "Compare models side by side, blind if the user likes",
    responsibilities: ["Ask each model", "Evaluate and summarise the differences"],
    taskTypes: ["compare_models"],
    outOfScope: [],
    tools: ["Several chat models"],
    input: "A prompt and the models to compare",
    output: "Side-by-side answers, an evaluation and a final answer",
    escalation: ["A model fails: shown as failed"],
    doneWhen: "Every model has answered or failed",
    runsUnder: "user",
    parent: null,
    dependsOn: [],
    status: "active",
    statusNote: null,
    version: "1.0",
    purposes: ["compare", "arena-improve", "arena-summary", "arena-analysis", "arena-final", "arena-evaluate"],
    access: "Signed-in users",
    href: "/arena",
    taskAgent: null,
    source: "src/lib/council/, /api/compare",
  },
  {
    id: "pipeline:missions",
    name: "Mission planner",
    level: "pipeline",
    category: "Planning",
    role: "Turn a goal into milestones and tasks the user confirms, and draft a task's text",
    responsibilities: ["Plan milestones and tasks", "Draft one task as text"],
    taskTypes: ["plan_project"],
    outOfScope: [{ what: "Running code or tools", useInstead: "task:engineer" }],
    tools: ["A chat model (text only)"],
    input: "A goal",
    output: "Milestones and tasks (saved only when the user confirms)",
    escalation: [],
    doneWhen: "The plan is shown; nothing is saved until confirmed",
    runsUnder: "user",
    parent: null,
    dependsOn: [],
    status: "active",
    statusNote: null,
    version: "1.0",
    purposes: ["mission-plan", "mission-task"],
    access: "Signed-in users",
    href: "/missions",
    taskAgent: null,
    source: "src/lib/missions/",
  },
  {
    id: "pipeline:connectors",
    name: "Connectors",
    level: "pipeline",
    category: "Writing",
    role: "Read from and act in the apps the user connected, with confirmation before any change",
    responsibilities: ["Read mail, files, calendars and messages the user connected", "Prepare actions (a Slack message, a calendar event, a Gmail draft) as cards the user confirms"],
    taskTypes: ["send_message"],
    outOfScope: [{ what: "Sending email: Orbis saves a Gmail draft and you send it yourself", useInstead: null }],
    tools: ["The user's connected apps, with the scopes they granted"],
    input: "A chat message about a connected app",
    output: "Answers from the app's data; actions as confirmation cards",
    escalation: ["Every write waits for the user's confirmation", "An app that isn't connected: it says how to connect it"],
    doneWhen: "The answer is given, or the confirmed action's result is shown",
    runsUnder: "user",
    parent: null,
    dependsOn: [],
    status: "active",
    statusNote: null,
    version: "1.0",
    purposes: ["connector_plan"],
    access: "Signed-in users, per connected app",
    href: "/connectors",
    taskAgent: null,
    source: "src/lib/connectors/",
  },
  {
    id: "pipeline:images",
    name: "Images",
    level: "pipeline",
    category: "Design",
    role: "Create an image from a description",
    responsibilities: ["Generate an image with an image model"],
    taskTypes: ["generate_image"],
    outOfScope: [],
    tools: ["An image model"],
    input: "A description",
    output: "An image",
    escalation: ["No image model configured: it says so"],
    doneWhen: "The image is returned",
    runsUnder: "user",
    parent: null,
    dependsOn: [],
    status: "active",
    statusNote: null,
    version: "1.0",
    purposes: ["image"],
    access: "Signed-in users",
    href: "/images",
    taskAgent: null,
    source: "src/lib/images.ts",
  },
];

/** Where each chat assistant hands off when the work needs real tools. */
const ASSISTANT_HANDOFF: Partial<Record<BuiltinAgentId, { category: Category; taskTypes: TaskType[]; outOfScope: CatalogueEntry["outOfScope"]; dependsOn: string[] }>> = {
  research: {
    category: "Research",
    taskTypes: ["answer_question"],
    outOfScope: [
      { what: "Multi-step research with a cited report", useInstead: "task:deep_research" },
      { what: "Checking a text's claims", useInstead: "pipeline:verify" },
    ],
    dependsOn: ["task:deep_research"],
  },
  coding: {
    category: "Coding",
    taskTypes: ["answer_question", "explain_code"],
    outOfScope: [
      { what: "Running code, editing a project or running tests", useInstead: "task:engineer" },
      { what: "Fixing a reported bug in a project", useInstead: "task:bug_fixer" },
    ],
    dependsOn: ["task:engineer"],
  },
  writing: { category: "Writing", taskTypes: ["write_text", "refine_writing"], outOfScope: [{ what: "Sending email or posting", useInstead: null }], dependsOn: ["writing:natural-writing-agent"] },
  data: { category: "Data", taskTypes: ["analyse_data"], outOfScope: [{ what: "Databases and charts", useInstead: null }], dependsOn: [] },
  creative: { category: "Writing", taskTypes: ["write_text"], outOfScope: [{ what: "Creating images", useInstead: "pipeline:images" }], dependsOn: [] },
  general: { category: "Writing", taskTypes: ["answer_question", "write_text"], outOfScope: [{ what: "Real work with tools", useInstead: "orchestrator:orbis_agent" }], dependsOn: [] },
};

const assistants = builtinAgents().map((a): CatalogueEntry => {
  const h = ASSISTANT_HANDOFF[a.id as BuiltinAgentId]!;
  const isData = a.id === "data";
  return {
    id: `assistant:${a.id}`,
    name: a.name,
    level: "assistant",
    category: h.category,
    role: a.description,
    responsibilities: a.starters.slice(0, 3),
    taskTypes: h.taskTypes,
    outOfScope: h.outOfScope,
    tools: a.capabilities.map((c) =>
      c === "web_search"
        ? "One web search per message (when search is set up)"
        : c === "file_analysis"
          ? "Read attached files"
          : c === "data_analysis"
            ? "Exact CSV statistics computed on the server"
            : c,
    ),
    input: "A chat message, optionally with files",
    output: "A text reply",
    escalation: ["It can't run code or take actions; it says which agent can"],
    doneWhen: "The reply is sent",
    runsUnder: "user",
    parent: null,
    dependsOn: h.dependsOn,
    status: "active",
    statusNote: isData ? "The same assistant is listed as the Data Analyst task agent." : null,
    version: "1.0",
    purposes: ["agent"],
    access: "Everyone with an account",
    href: `/agents/${a.id}`,
    taskAgent: isData ? "data_analyst" : null,
    source: "src/lib/agents/builtins.ts",
  };
});

const workforce = WORKFORCE_AGENTS.map(
  (w): CatalogueEntry => ({
    id: `workforce:${w.id}`,
    name: w.name,
    level: "internal",
    category:
      w.id === "commander"
        ? "Orchestration"
        : w.id === "architect"
          ? "Planning"
          : ["qa_hunter", "reviewer", "visual", "optimizer"].includes(w.id)
            ? "Testing"
            : w.id === "sentinel"
              ? "Security"
              : "Coding",
    role: w.role,
    responsibilities: w.responsibilities,
    taskTypes: [],
    outOfScope: [{ what: "Anything for ordinary users: administrators only", useInstead: null }],
    tools: w.tools,
    input: w.id === "commander" ? "An administrator's engineering task" : "A step assigned by the Commander",
    output: w.output,
    escalation: ["Approvals, budgets and limits are enforced by the Commander"],
    doneWhen: w.id === "commander" ? "The result is verified against real evidence and the final report is written" : "Its step's output is recorded",
    runsUnder: "administrator",
    parent: w.id === "commander" ? null : "workforce:commander",
    dependsOn: [],
    status: w.status === "active" ? "admin_only" : "planned",
    statusNote: w.status === "planned" ? (w.plannedReason ?? "Planned.") : "Administrators only.",
    version: w.version,
    purposes: ["workforce"],
    access: "Administrators",
    href: "/workforce",
    taskAgent: null,
    source: "src/lib/workforce/agents.ts",
  }),
);

/**
 * Natural Writing: a capability of the Writing Agent, not a separate agent (it has no conversations or page of
 * its own). It runs inside the Writing Agent when its controls are on or the request asks for it, and inside
 * the Orbis Agent's chat when a message asks for natural, conversational, polished or personal writing. Its
 * styles, intensities, instructions and writing check live in one module (src/lib/writing/natural.ts).
 */
const NATURAL_WRITING: CatalogueEntry = {
  id: "writing:natural-writing-agent",
  name: "Natural Writing",
  level: "sub_agent",
  category: "Writing",
  role: "Turn stiff, generic or robotic text into natural writing for its audience, without changing what it says",
  responsibilities: [
    "Rewrite robotic, repetitive, overly formal or generic paragraphs in natural language",
    "Vary sentence length, rhythm, structure and transitions",
    "Replace clichés, filler, needless headings and predictable wording with specific language",
    "Adapt to the chosen style (natural, professional, friendly, persuasive, academic, or the author's own) and audience",
    "Match the author's voice from a writing sample when one is given",
    "Keep meaning, facts, numbers, technical terms, quotations, citations, links, disclosures and formatting",
    "Explain the main changes briefly when asked",
  ],
  taskTypes: ["refine_writing"],
  outOfScope: [
    { what: "Writing new content from scratch (the Writing Agent does that)", useInstead: "assistant:writing" },
    { what: "Checking whether the text's claims are true", useInstead: "pipeline:verify" },
    { what: "Getting text past AI detectors or hiding who wrote it", useInstead: null },
    { what: "Adding experiences, credentials, sources or statistics the original doesn't have", useInstead: null },
  ],
  tools: [
    "The chat model",
    "The writing check (compares the rewrite with the original: numbers, citations, quotations, links, disclosures, length, generic phrasing)",
    "A writing sample, when given (as data)",
  ],
  input: "Text to rewrite (in the message or an attached file), a style, a rewrite intensity (light edit, balanced rewrite, full rewrite), optionally a writing sample",
  output: "The rewritten text, a short note on what changed, and the writing check with the original kept to compare or restore",
  escalation: [
    "No text to rewrite: it asks for it",
    "The writing check finds lost or added facts: shown as problems to fix before using the text",
    "AI-detector requests: it improves the writing and says it can't promise detector results",
  ],
  doneWhen: "The rewrite is returned and, when there was an original, the writing check has compared them",
  runsUnder: "user",
  parent: "assistant:writing",
  dependsOn: ["pipeline:verify"],
  status: "active",
  statusNote: "Part of the Writing Agent: switch it on there, or ask in chat for natural, conversational, polished or personal writing.",
  version: "1.0",
  purposes: ["natural_writing"],
  access: "Everyone with an account (the Writing Agent), and in chat",
  href: "/agents/writing",
  taskAgent: null,
  source: "src/lib/writing/natural.ts",
};

export const CATALOGUE: CatalogueEntry[] = [ORCHESTRATOR, PLANNER, ...AGENTS.map(taskEntry), ...securitySub, ...PAIR, ...PIPELINES, ...assistants, NATURAL_WRITING, ...workforce];

export function catalogueEntry(id: string): CatalogueEntry | null {
  return CATALOGUE.find((e) => e.id === id) ?? null;
}

/** Kinds of work nothing in Orbis does. The router reports these as gaps instead of handing them to an agent that can't do them. */
export const CAPABILITY_GAPS: TaskType[] = TASK_TYPES.filter((t) => !CATALOGUE.some((e) => e.status === "active" && e.taskTypes.includes(t)));

/** Which active entries (not internal) do a kind of work, most specific first: specialists, then pipelines, then assistants. */
export function entriesFor(type: TaskType): CatalogueEntry[] {
  const rank: Level[] = ["specialist", "pipeline", "orchestrator", "assistant", "sub_agent"];
  return CATALOGUE.filter((e) => e.status === "active" && e.taskTypes.includes(type) && rank.includes(e.level)).sort((a, b) => rank.indexOf(a.level) - rank.indexOf(b.level));
}

/**
 * Problems in the catalogue: duplicate ids, missing fields, references to entries that don't exist,
 * unknown kinds of work, a sub-agent without a parent, a planned entry offering work. Empty when valid;
 * the tests require it to be empty.
 */
export function catalogueProblems(entries: CatalogueEntry[] = CATALOGUE): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) out.push(`duplicate id ${e.id}`);
    ids.add(e.id);
  }
  for (const e of entries) {
    if (!/^[a-z]+:[a-z_-]+$/.test(e.id)) out.push(`${e.id}: id must look like kind:name`);
    for (const k of ["name", "role", "input", "output", "doneWhen", "access", "source"] as const) if (!e[k]?.trim()) out.push(`${e.id}: missing ${k}`);
    if (!/^\d+\.\d+(\.\d+)?$/.test(e.version)) out.push(`${e.id}: version "${e.version}" isn't like 1.0`);
    for (const t of e.taskTypes) if (!(TASK_TYPES as readonly string[]).includes(t)) out.push(`${e.id}: unknown task type ${t}`);
    for (const d of e.dependsOn) if (!ids.has(d)) out.push(`${e.id}: depends on unknown ${d}`);
    for (const o of e.outOfScope) if (o.useInstead && !ids.has(o.useInstead)) out.push(`${e.id}: points to unknown ${o.useInstead}`);
    if (e.level === "sub_agent" && !e.parent) out.push(`${e.id}: a sub-agent needs a parent`);
    if (e.parent && !ids.has(e.parent)) out.push(`${e.id}: unknown parent ${e.parent}`);
    if (e.status === "planned" && e.taskTypes.length) out.push(`${e.id}: a planned entry can't offer work`);
    if (e.href && !e.href.startsWith("/")) out.push(`${e.id}: href must be a path`);
    if (e.level === "specialist" && !e.taskAgent) out.push(`${e.id}: a specialist must be a task agent in the registry`);
  }
  return out;
}
