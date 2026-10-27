import type { PlanId } from "../plans";

/**
 * The task agents Orbis offers: one entry per agent that really runs. The
 * marketplace, the agent workspaces, the start-task API and the docs all read
 * this list, so an agent's description, tools, approvals and plan access are
 * stated once. An agent is listed here only when its runtime exists; whether
 * it can run on this deployment, for this user, is worked out separately
 * (availability.ts) from the server's configuration and the user's plan.
 *
 * Adding an agent: add an entry here, give it a runtime (or reuse one, as the
 * Bug Fixing and QA agents reuse the coding engine with their own profile),
 * and a workspace page. Nothing else in the marketplace needs to change.
 */

export const AGENT_IDS = ["engineer", "code_review", "bug_fixer", "qa_tester", "security", "deep_research", "website_builder", "data_analyst"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_CATEGORIES = ["Software", "Security", "Research", "Data"] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

/** What an agent's runtime is: the coding engine (with a profile), the review pipeline, research, the security scanners, or a chat assistant. */
export type AgentRuntime = "code_agent" | "code_review" | "deep_research" | "security" | "chat";

/** Server configuration an agent needs. Checked on the server; never trusted from the browser. */
export type Requirement = "ai" | "anthropic" | "sandbox" | "accounts";

/** A permission an agent's tools have. Enforced by its runtime, not only described. */
export type ToolPermission =
  | "read_code"
  | "edit_files"
  | "edit_tests_only"
  | "run_commands"
  | "run_tests"
  | "web_search"
  | "github_read"
  | "dependency_scan"
  | "rule_scan"
  | "website_scan"
  | "log_analysis"
  | "data_analysis";

export const PERMISSION_LABEL: Record<ToolPermission, string> = {
  read_code: "Read your code",
  edit_files: "Edit files in an Orbis project (a copy; nothing reaches GitHub without you)",
  edit_tests_only: "Create and edit test files only",
  run_commands: "Run commands in an isolated computer (safe list runs; others ask you)",
  run_tests: "Run your tests in an isolated computer",
  web_search: "Search the web",
  github_read: "Read GitHub repositories and pull requests",
  dependency_scan: "Check dependencies against the OSV vulnerability database",
  rule_scan: "Scan code with secret and insecure-pattern rules",
  website_scan: "Check websites you've proved you own",
  log_analysis: "Analyse logs you upload",
  data_analysis: "Compute exact statistics for CSV files you attach",
};

/**
 * The kinds of work a request can need. Every agent declares the ones it does (`taskTypes`); the router
 * (routing.ts) matches requests to agents through them, and a kind no active agent does is reported as a
 * gap instead of being sent to an agent that can't do it.
 */
export const TASK_TYPES = [
  "answer_question",
  "write_text",
  "refine_writing",
  "implement_feature",
  "explain_code",
  "build_website",
  "fix_bug",
  "write_tests",
  "review_code",
  "security_audit",
  "web_research",
  "verify_claims",
  "analyse_data",
  "compare_models",
  "plan_project",
  "generate_image",
  "design_ui",
  "write_docs",
  "deploy",
  "send_message",
  "manage_infrastructure",
  "make_purchase",
  "schedule_automation",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  answer_question: "Answer a question",
  write_text: "Write or edit text",
  refine_writing: "Make writing natural or polished",
  implement_feature: "Build or change software",
  explain_code: "Explain a codebase",
  build_website: "Build a website",
  fix_bug: "Fix a bug",
  write_tests: "Write and run tests",
  review_code: "Review code",
  security_audit: "Security audit",
  web_research: "Research the web",
  verify_claims: "Check claims against sources",
  analyse_data: "Analyse data",
  compare_models: "Compare AI models",
  plan_project: "Plan a project",
  generate_image: "Create an image",
  design_ui: "Design a user interface",
  write_docs: "Write documentation",
  deploy: "Deploy or publish",
  send_message: "Send email or messages",
  manage_infrastructure: "Manage servers or cloud infrastructure",
  make_purchase: "Buy or pay for something",
  schedule_automation: "Run something on a schedule",
};

/** One agent's job, stated once: what it's for, its boundaries, what it takes and gives, and when it's done or must stop. */
export interface AgentRole {
  /** The one thing it's responsible for. */
  role: string;
  /** What else it does in service of that role. */
  responsibilities: string[];
  /** The kinds of work it accepts. */
  taskTypes: TaskType[];
  /** Work it doesn't do, and who does. */
  outOfScope: { what: string; useInstead: string | null }[];
  /** What it needs to start. */
  input: string;
  /** What it hands back. */
  output: string;
  /** When it stops and comes back to the user instead of carrying on. */
  escalation: string[];
  /** How a task counts as finished. */
  doneWhen: string;
  /** Agents it hands work to (never directly: through the user or a workflow). */
  handsOffTo: string[];
  /** Bumped when its instructions, tools or limits change. */
  version: string;
  /** What its usage is recorded under (model_runs.purpose), so its cost can be measured. */
  purposes: string[];
}

/** Code-engine profiles: the Software Engineer (the ordinary coding agent) and the agents that reuse its engine. */
export const CODE_PROFILES = ["bug_fixer", "qa_tester"] as const;
export type CodeProfile = (typeof CODE_PROFILES)[number];

export interface AgentDef extends AgentRole {
  id: AgentId;
  name: string;
  /** One line for cards. */
  tagline: string;
  description: string;
  category: AgentCategory;
  /** Icon key (mapped to an icon in the UI). */
  icon: "code" | "scan" | "bug" | "flask" | "shield" | "telescope" | "globe" | "chart";
  runtime: AgentRuntime;
  /** The agent's workspace. */
  href: string;
  capabilities: string[];
  limitations: string[];
  permissions: ToolPermission[];
  /** What waits for the user's approval. */
  approvals: string[];
  requires: Requirement[];
  /** Plans that include it. Enforced by the server when a task starts. */
  plans: PlanId[];
  /** How a task is charged. */
  charging: string;
  /** Where its tasks are listed. */
  historyHref: string;
}

const CODE_CHARGING = "Each agent step is charged from your plan's allowance like a message of its size; commands use computer minutes.";

const CODE_ESCALATION = [
  "The plan needs approval (on by default)",
  "A command outside the safe list",
  "It needs information only the user has (ask_user)",
  "A step, token, time or failed-test limit is reached",
  "The same failure three times: it stops and explains instead of retrying",
];

const ROLES: Record<AgentId, AgentRole> = {
  engineer: {
    role: "Change software in an Orbis project and prove the change works",
    responsibilities: ["Inspect the project before editing", "Plan, then make the smallest change that does the job", "Run the tests or build and fix what fails", "Report only what actually ran"],
    taskTypes: ["implement_feature", "explain_code", "design_ui", "write_docs"],
    outOfScope: [
      { what: "Diagnosing a reported bug from an error or stack trace", useInstead: "bug_fixer" },
      { what: "Writing a test suite without touching application code", useInstead: "qa_tester" },
      { what: "An independent review of changes", useInstead: "code_review" },
      { what: "Deploying, publishing or pushing without the user", useInstead: null },
    ],
    input: "A request in plain words and one of the user's Orbis projects; optional files and images",
    output: "Changed files (each undoable), the commands and tests that ran with their real results, and a report",
    escalation: CODE_ESCALATION,
    doneWhen: "It calls finish and the report is built from the run's records: what changed, which checks ran, whether they passed",
    handsOffTo: ["code_review", "qa_tester"],
    version: "3.2",
    purposes: ["code_agent", "pair_coding"],
  },
  code_review: {
    role: "Find real problems in code and point to the exact line",
    responsibilities: [
      "Run secret and insecure-pattern rules",
      "Check dependencies against OSV",
      "Review each part of the code with a model and keep only findings whose quoted line exists",
      "Suggest fixes as diffs",
    ],
    taskTypes: ["review_code", "security_audit"],
    outOfScope: [
      { what: "Changing the code", useInstead: "engineer" },
      { what: "Scanning a live website", useInstead: "security" },
    ],
    input: "Pasted code, a diff, a ZIP, a GitHub repository or pull request, an Orbis project, or the changes of earlier agent tasks",
    output: "Findings with severity, file, line, the quoted code and a suggested fix; rule matches marked separately from AI findings",
    escalation: ["The source can't be read (private repository without access, too large)", "A part of the code fails twice: the review continues and says which part wasn't reviewed"],
    doneWhen: "Every part has been reviewed or reported as skipped, and the findings are saved",
    handsOffTo: ["engineer"],
    version: "1.1",
    purposes: ["code_review"],
  },
  bug_fixer: {
    role: "Reproduce a reported bug, fix its cause and show the before and after",
    responsibilities: [
      "Read the error, logs and stack trace (as data, never instructions)",
      "Reproduce the failure before changing code",
      "Find the root cause and make a minimal patch",
      "Add a regression test when the project has a test setup",
      "Re-run the tests",
    ],
    taskTypes: ["fix_bug"],
    outOfScope: [
      { what: "New features", useInstead: "engineer" },
      { what: "Production servers, databases or logs it wasn't given", useInstead: null },
    ],
    input: "A bug summary, details, the error or logs, how to reproduce and what's expected; one of the user's projects",
    output: "The patch, the failing check before the fix (or why there wasn't one) and the test results after",
    escalation: CODE_ESCALATION,
    doneWhen: "The report's 'Before the fix' and 'After the fix' sections are built from what actually ran",
    handsOffTo: ["qa_tester", "code_review"],
    version: "1.0",
    purposes: ["bug_fix"],
  },
  qa_tester: {
    role: "Write and run tests and report what failed, without changing application code",
    responsibilities: ["Write unit, integration and API tests", "Set up a test runner when there is none", "Run the tests and capture failures", "Report bugs it finds instead of fixing them"],
    taskTypes: ["write_tests"],
    outOfScope: [
      { what: "Fixing the bugs its tests find", useInstead: "bug_fixer" },
      { what: "Browser (end-to-end) tests", useInstead: null },
    ],
    input: "What to test, which kinds of tests, notes; one of the user's projects",
    output: "Test files, the real test results and a readable test report",
    escalation: [...CODE_ESCALATION, "An edit outside test files is refused by the server; it says so"],
    doneWhen: "Its tests have run and the report shows their real results",
    handsOffTo: ["bug_fixer"],
    version: "1.0",
    purposes: ["qa_testing"],
  },
  security: {
    role: "Find security problems with scanners, and explain them",
    responsibilities: ["Check websites the user has proved they own", "Analyse uploaded logs", "Audit code with rules and OSV", "Propose patches and an exportable report"],
    taskTypes: ["security_audit"],
    outOfScope: [
      { what: "Applying or deploying fixes", useInstead: "engineer" },
      { what: "Scanning sites the user doesn't own", useInstead: null },
      { what: "Continuous monitoring", useInstead: null },
    ],
    input: "A verified website, uploaded logs, or code (pasted, a repository or a project)",
    output: "Findings from scanners with evidence; AI explanations and proposed patches clearly marked as proposals",
    escalation: ["A website scan needs proof of ownership and the user's confirmation", "A scanner fails: the run reports which check didn't run"],
    doneWhen: "Each requested check has run or been reported as not run, and findings are saved",
    handsOffTo: ["engineer"],
    version: "1.0",
    purposes: ["security"],
  },
  deep_research: {
    role: "Answer a research question from sources it actually read, with citations",
    responsibilities: ["Plan sub-questions", "Search the web and read pages", "Write a report where each claim links to a quoted source", "Count and show uncited paragraphs"],
    taskTypes: ["web_research"],
    outOfScope: [
      { what: "Checking a given text's claims", useInstead: "verify" },
      { what: "Pages behind logins", useInstead: null },
    ],
    input: "A research question and a depth (quick, standard or deep)",
    output: "A cited report with sources and quotes; exportable",
    escalation: ["No web searches left in the plan", "Searches fail: it reports what it couldn't find"],
    doneWhen: "The report is written and every paragraph is either cited or counted as uncited",
    handsOffTo: [],
    version: "1.1",
    purposes: ["deep_research"],
  },
  website_builder: {
    role: "Build or change a website and check it in a real browser",
    responsibilities: ["Start from a template or the user's description", "Build responsive pages", "Start a preview and inspect it at phone, tablet and desktop sizes", "Report what was checked"],
    taskTypes: ["build_website", "design_ui"],
    outOfScope: [
      { what: "Hosting or publishing the site", useInstead: null },
      { what: "Back-end services the site doesn't have (payments, email, accounts)", useInstead: null },
    ],
    input: "A description of the site (optionally a website template) and a project",
    output: "The site's files, browser-check results and screenshots, and a report",
    escalation: CODE_ESCALATION,
    doneWhen: "The site's files are written and the browser check has run (or the report says why it couldn't)",
    handsOffTo: ["code_review"],
    version: "1.2",
    purposes: ["code_agent"],
  },
  data_analyst: {
    role: "Compute exact statistics for the user's CSV files and explain them",
    responsibilities: ["Compute column statistics on the server", "Explain results with caveats", "Answer follow-up questions"],
    taskTypes: ["analyse_data"],
    outOfScope: [
      { what: "Databases, spreadsheets other than CSV/TSV, charts", useInstead: null },
      { what: "Web research", useInstead: "deep_research" },
    ],
    input: "A question and attached CSV or TSV files",
    output: "Statistics computed on the server, explained in the reply",
    escalation: ["A file is too large (over 20,000 rows or 50 columns)", "The question needs data that wasn't attached"],
    doneWhen: "The reply is given with the statistics it used",
    handsOffTo: [],
    version: "1.0",
    purposes: ["agent"],
  },
};

const BASE: Omit<AgentDef, keyof AgentRole>[] = [
  {
    id: "engineer",
    name: "Software Engineer",
    tagline: "Builds features, fixes bugs and refactors in your project",
    description: "Works in an Orbis project: inspects the code, plans, edits files, runs tests and builds in an isolated computer, fixes what fails and reports what actually ran.",
    category: "Software",
    icon: "code",
    runtime: "code_agent",
    href: "/code",
    capabilities: ["Implement features", "Explain a codebase (read-only mode)", "Refactor", "Fix bugs and produce patches", "Run tests and report real results", "Import from and push to GitHub"],
    limitations: [
      "Works on an Orbis project (imported from GitHub, a ZIP or a template), up to 1,000 files / 20 MB",
      "Progress needs the page open; a closed page pauses the task",
      "No interactive commands",
    ],
    permissions: ["read_code", "edit_files", "run_commands", "run_tests", "github_read"],
    approvals: ["The plan, before any change (on by default)", "Commands outside the safe list", "Each set of edits, if you turn on edit review", "Pushing to GitHub (always a new branch)"],
    requires: ["ai", "accounts"],
    plans: ["free", "pro", "max"],
    charging: CODE_CHARGING,
    historyHref: "/history",
  },
  {
    id: "code_review",
    name: "Code Review",
    tagline: "Finds bugs and security problems, with line references",
    description:
      "Reviews pasted code, a diff, a ZIP, a GitHub repository or pull request, or an Orbis project. Findings quote the exact line; rule and dependency checks are marked separately from AI judgement.",
    category: "Software",
    icon: "scan",
    runtime: "code_review",
    href: "/review",
    capabilities: [
      "Bugs, logic errors and edge cases",
      "Security problems (rules + AI)",
      "Known-vulnerable dependencies (OSV)",
      "Performance and test gaps",
      "Suggested fixes as diffs",
      "Hand a finding to the coding agent",
    ],
    limitations: [
      "Up to 400 files / 1.5 MB per review",
      "AI findings are never marked confirmed; only rule matches are",
      "Doesn't post comments on GitHub (needs the app's pull-request write permission)",
    ],
    permissions: ["read_code", "github_read", "rule_scan", "dependency_scan"],
    approvals: ["Nothing changes your code: fixes go through the Software Engineer, with its approvals"],
    requires: ["ai", "accounts"],
    plans: ["free", "pro", "max"],
    charging: "Each part of the code (up to 45 KB) is one model call, charged like a message of its size.",
    historyHref: "/review",
  },
  {
    id: "bug_fixer",
    name: "Bug Fixing",
    tagline: "Reproduces a bug, fixes the cause and re-runs the tests",
    description:
      "Give it the bug, the error or stack trace and the project. It tries to reproduce the problem in an isolated computer first, finds the root cause, patches it, and runs the tests again. The report shows the original failure, the patch and the test results that actually ran.",
    category: "Software",
    icon: "bug",
    runtime: "code_agent",
    href: "/agents/bug-fixer",
    capabilities: [
      "Read logs and stack traces",
      "Reproduce with tests or a command before changing code",
      "Root-cause analysis",
      "Minimal patch",
      "Regression test when the project has a test setup",
      "Before / after test results",
    ],
    limitations: ["Reproduction needs the project to run in the isolated computer; when it can't, the report says so", "No access to your servers, databases or production logs except what you paste"],
    permissions: ["read_code", "edit_files", "run_commands", "run_tests"],
    approvals: ["The plan, before any change", "Commands outside the safe list", "Pushing the fix to GitHub (a new branch)"],
    requires: ["ai", "sandbox", "accounts"],
    plans: ["free", "pro", "max"],
    charging: CODE_CHARGING,
    historyHref: "/agents/bug-fixer",
  },
  {
    id: "qa_tester",
    name: "QA Testing",
    tagline: "Writes tests, runs them and reports what failed",
    description:
      "Writes unit, integration and API tests for the code you point it at, runs them in an isolated computer and reports the real results. It can only create and edit test files, so it can't change your application code to make tests pass.",
    category: "Software",
    icon: "flask",
    runtime: "code_agent",
    href: "/agents/qa-tester",
    capabilities: [
      "Unit, integration and API tests",
      "Sets up a test runner when the project has none",
      "Runs the tests and captures failures",
      "Readable test report",
      "Never reports a test as passing unless it ran and passed",
    ],
    limitations: [
      "Edits only test files and test configuration",
      "Browser (end-to-end) tests need a browser in the computer, which isn't installed by default",
      "Failures it finds are reported, not fixed: hand them to Bug Fixing",
    ],
    permissions: ["read_code", "edit_tests_only", "run_commands", "run_tests"],
    approvals: ["The plan, before writing tests", "Commands outside the safe list"],
    requires: ["ai", "sandbox", "accounts"],
    plans: ["free", "pro", "max"],
    charging: CODE_CHARGING,
    historyHref: "/agents/qa-tester",
  },
  {
    id: "security",
    name: "Security Team",
    tagline: "Code, repository, deployment and Cloudflare security audits",
    description:
      "Eleven agents audit your code, GitHub repositories and pull requests, Vercel deployments and Cloudflare protection, investigate logs, independently verify what they find, and help you fix it. They run on three engines — Sentinel (websites, Vercel and Cloudflare), Threat Hunter (logs) and Code Guardian (code, dependencies and pull requests) — coordinated by Aegis and guarded by Bastion. Scanners produce the findings; AI explains them, challenges them and proposes fixes that only apply after your approval.",
    category: "Security",
    icon: "shield",
    runtime: "security",
    href: "/agents/security",
    capabilities: [
      "Audit modes: Quick, Deep, Attack-path, Pre-release gate",
      "Read-only site mapping and header/configuration checks",
      "Exposed-file and signed-out endpoint checks (active testing)",
      "Attack paths and coverage reports",
      "Log analysis",
      "Secret and insecure-code rules",
      "Vulnerable dependencies (OSV)",
      "Proposed patches and an exportable report",
    ],
    limitations: ["Websites need proof of ownership", "No scheduled monitoring: audits run when you start them", "Doesn't sign in, submit forms or send attack payloads", "Fixes need your approval; nothing is pushed or deployed"],
    permissions: ["website_scan", "log_analysis", "rule_scan", "dependency_scan", "github_read", "read_code"],
    approvals: ["Every website scan needs your confirmation that you're authorised"],
    requires: ["accounts"],
    plans: ["free", "pro", "max"],
    charging: "Scans are free; AI explanations and reports are charged like messages of their size.",
    historyHref: "/agents/security",
  },
  {
    id: "deep_research",
    name: "Deep Research",
    tagline: "Multi-step web research with a cited report",
    description: "Plans research questions, searches the web, and writes a report where every claim links to a page it read, with the quoted text. Uncited paragraphs are counted and shown.",
    category: "Research",
    icon: "telescope",
    runtime: "deep_research",
    href: "/research",
    capabilities: ["Competitor, product, technology and market research", "Citations with quotes", "Quick, standard and deep runs", "Markdown export and print"],
    limitations: ["Uses your plan's web searches (none on Free)", "Pages behind logins aren't read"],
    permissions: ["web_search"],
    approvals: ["Nothing: research can't take actions"],
    requires: ["anthropic", "accounts"],
    plans: ["pro", "max"],
    charging: "Each step is charged like a message of its size; each research question uses web searches from your plan.",
    historyHref: "/research",
  },
  {
    id: "website_builder",
    name: "Website Builder",
    tagline: "Builds a website and checks it in a real browser",
    description: "The Software Engineer with website guidance: builds pages, starts a preview, inspects them in a browser and reports what was checked.",
    category: "Software",
    icon: "globe",
    runtime: "code_agent",
    href: "/code",
    capabilities: ["Landing pages and small sites", "Preview at phone, tablet and desktop sizes", "Browser inspection after changes", "Download as ZIP or push to GitHub"],
    limitations: ["Forms aren't connected to a backend unless you build one", "No hosting: you deploy the result yourself"],
    permissions: ["read_code", "edit_files", "run_commands", "run_tests"],
    approvals: ["The plan, before any change", "Commands outside the safe list"],
    requires: ["ai", "sandbox", "accounts"],
    plans: ["free", "pro", "max"],
    charging: CODE_CHARGING,
    historyHref: "/history",
  },
  {
    id: "data_analyst",
    name: "Data Analyst",
    tagline: "Exact statistics for CSV files, explained",
    description: "A chat assistant that computes exact statistics for attached CSV/TSV files on the server and explains them, stating caveats.",
    category: "Data",
    icon: "chart",
    runtime: "chat",
    href: "/agents/data",
    capabilities: ["Column statistics computed on the server", "Explanations and caveats", "Follow-up questions"],
    limitations: ["Up to 20,000 rows and 50 columns per file", "No charts or database connections"],
    permissions: ["data_analysis"],
    approvals: ["Nothing: it can't take actions"],
    requires: ["ai", "accounts"],
    plans: ["free", "pro", "max"],
    charging: "Charged like a chat message of its size.",
    historyHref: "/agents/data",
  },
];

export const AGENTS: AgentDef[] = BASE.map((a) => ({ ...a, ...ROLES[a.id] }));

export function agentDef(id: string): AgentDef | null {
  return AGENTS.find((a) => a.id === id) ?? null;
}

/** The workspace slug of a code-engine profile (/agents/bug-fixer). */
export const PROFILE_SLUG: Record<CodeProfile, string> = { bug_fixer: "bug-fixer", qa_tester: "qa-tester" };

export function isCodeProfile(id: string): id is CodeProfile {
  return (CODE_PROFILES as readonly string[]).includes(id);
}
