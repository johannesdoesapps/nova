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

/** Code-engine profiles: the Software Engineer (the ordinary coding agent) and the agents that reuse its engine. */
export const CODE_PROFILES = ["bug_fixer", "qa_tester"] as const;
export type CodeProfile = (typeof CODE_PROFILES)[number];

export interface AgentDef {
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

export const AGENTS: AgentDef[] = [
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
      "Works on an Orbis project (imported from GitHub, a ZIP or a template), up to 300 files / 3 MB",
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
    tagline: "Website checks, log investigations and secure code audits",
    description:
      "Three agents: Sentinel checks websites you've proved you own, Threat Hunter analyses logs you upload, Code Guardian audits code with secret and insecure-pattern rules plus OSV dependency checks. Scanners produce the findings; AI only explains them and proposes fixes.",
    category: "Security",
    icon: "shield",
    runtime: "security",
    href: "/agents/security",
    capabilities: [
      "Header and configuration checks",
      "Exposed-file checks (active scope)",
      "Log analysis",
      "Secret and insecure-code rules",
      "Vulnerable dependencies (OSV)",
      "Proposed patches and an exportable report",
    ],
    limitations: ["Websites need proof of ownership", "No continuous monitoring", "Patches are proposals; nothing is applied or deployed"],
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

export function agentDef(id: string): AgentDef | null {
  return AGENTS.find((a) => a.id === id) ?? null;
}

/** The workspace slug of a code-engine profile (/agents/bug-fixer). */
export const PROFILE_SLUG: Record<CodeProfile, string> = { bug_fixer: "bug-fixer", qa_tester: "qa-tester" };

export function isCodeProfile(id: string): id is CodeProfile {
  return (CODE_PROFILES as readonly string[]).includes(id);
}
