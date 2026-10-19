import type { AgentId } from "./types";

/**
 * The Workforce agent registry. Each agent declares what it is allowed to do;
 * the runtime refuses any tool use outside these permissions. Adding an agent
 * means adding an entry here and an executor in ./executors.
 */
export type Permission =
  | "read_repo" // list, search and read files in the task workspace
  | "write_workspace" // change files inside the task workspace only
  | "run_checks" // run the project's allow-listed checks (no arbitrary commands)
  | "model_calls"
  | "network_none"; // sandboxed commands run with network denied

export interface AgentDef {
  id: AgentId;
  name: string;
  role: string;
  version: string;
  kind: "deterministic" | "model" | "hybrid";
  status: "active" | "planned";
  plannedReason?: string;
  responsibilities: string[];
  output: string;
  tools: string[];
  permissions: Permission[];
  defaultModel: string | null;
  limits: { timeoutMs: number; maxAttempts: number; maxOutputTokens: number };
}

export const AGENTS: AgentDef[] = [
  {
    id: "commander",
    name: "Nova Commander",
    role: "Orchestration and verification",
    version: "1.0.0",
    kind: "deterministic",
    status: "active",
    responsibilities: ["Builds and runs the task graph", "Enforces approvals, budgets and limits", "Retries, escalates and cancels", "Verifies results against real evidence and writes the final report"],
    output: "Task state, verification verdict and final report",
    tools: ["task-store", "approvals", "budget"],
    permissions: [],
    defaultModel: null,
    limits: { timeoutMs: 60_000, maxAttempts: 1, maxOutputTokens: 0 },
  },
  {
    id: "archaeologist",
    name: "Nova Archaeologist",
    role: "Codebase mapping",
    version: "1.0.0",
    kind: "hybrid",
    status: "active",
    responsibilities: ["Lists and searches the repository", "Finds existing implementations", "Maps relevant files and data flow"],
    output: "Codebase map: relevant files, why they matter, existing implementations",
    tools: ["git ls-files", "git grep", "read file"],
    permissions: ["read_repo", "model_calls"],
    defaultModel: "auto:quick",
    limits: { timeoutMs: 120_000, maxAttempts: 2, maxOutputTokens: 2500 },
  },
  {
    id: "architect",
    name: "Nova Architect",
    role: "Requirements and implementation plan",
    version: "1.0.0",
    kind: "model",
    status: "active",
    responsibilities: ["Analyses requirements", "Proposes the implementation plan", "Identifies risks", "Defines testable acceptance criteria"],
    output: "Plan: changes per file, tests, risks, acceptance criteria",
    tools: ["read file"],
    permissions: ["read_repo", "model_calls"],
    defaultModel: "auto:deep",
    limits: { timeoutMs: 120_000, maxAttempts: 2, maxOutputTokens: 4000 },
  },
  {
    id: "builder",
    name: "Nova Builder",
    role: "Implementation",
    version: "1.0.0",
    kind: "hybrid",
    status: "active",
    responsibilities: ["Implements the approved plan", "Follows project conventions", "Keeps changes scoped", "Produces a diff"],
    output: "File edits applied in the task workspace and a git diff",
    tools: ["read file", "write file (workspace)", "git diff"],
    permissions: ["read_repo", "write_workspace", "model_calls"],
    defaultModel: "auto:coding",
    limits: { timeoutMs: 180_000, maxAttempts: 2, maxOutputTokens: 12000 },
  },
  {
    id: "qa_hunter",
    name: "Nova QA Hunter",
    role: "Testing",
    version: "1.0.0",
    kind: "deterministic",
    status: "active",
    responsibilities: ["Runs the project's real checks (typecheck, lint, tests)", "Records a baseline before changes", "Separates new failures from pre-existing ones"],
    output: "Check results with exit codes and output excerpts",
    tools: ["allow-listed check commands"],
    permissions: ["read_repo", "run_checks", "network_none"],
    defaultModel: null,
    limits: { timeoutMs: 900_000, maxAttempts: 1, maxOutputTokens: 0 },
  },
  {
    id: "self_heal",
    name: "Nova Self-Heal",
    role: "Failure diagnosis and repair",
    version: "1.0.0",
    kind: "hybrid",
    status: "active",
    responsibilities: ["Analyses failing checks", "Applies scoped fixes", "Stops when the same failure repeats"],
    output: "Root cause, applied fix and retry history",
    tools: ["read file", "write file (workspace)"],
    permissions: ["read_repo", "write_workspace", "model_calls"],
    defaultModel: "auto:coding",
    limits: { timeoutMs: 180_000, maxAttempts: 1, maxOutputTokens: 10000 },
  },
  {
    id: "reviewer",
    name: "Nova Reviewer",
    role: "Independent code review",
    version: "1.0.0",
    kind: "model",
    status: "active",
    responsibilities: ["Reviews the actual diff, not the builder's summary", "Checks acceptance criteria against evidence", "Flags unnecessary or risky changes"],
    output: "Findings by severity, criteria assessment and a recommendation",
    tools: ["git diff", "check results"],
    permissions: ["read_repo", "model_calls"],
    defaultModel: "auto:deep",
    limits: { timeoutMs: 120_000, maxAttempts: 2, maxOutputTokens: 4000 },
  },
  {
    id: "sentinel",
    name: "Nova Sentinel",
    role: "Security review of changes",
    version: "1.0.0",
    kind: "hybrid",
    status: "active",
    responsibilities: ["Runs secret and insecure-code rules on changed files", "Reviews the diff for auth, injection and unsafe execution risks", "Blocks delivery on serious findings per policy"],
    output: "Security findings with severity and evidence",
    tools: ["Nova code & secret rules", "git diff"],
    permissions: ["read_repo", "model_calls"],
    defaultModel: "auto:deep",
    limits: { timeoutMs: 120_000, maxAttempts: 2, maxOutputTokens: 3000 },
  },
  {
    id: "devops",
    name: "Nova DevOps",
    role: "Workspace, build and release readiness",
    version: "1.0.0",
    kind: "deterministic",
    status: "active",
    responsibilities: ["Prepares the isolated workspace", "Runs the production build check", "Reports release readiness. Deployment stays approval-gated and is not automated."],
    output: "Workspace status, build result and readiness",
    tools: ["Vercel Sandbox", "allow-listed build command"],
    permissions: ["read_repo", "run_checks"],
    defaultModel: null,
    limits: { timeoutMs: 900_000, maxAttempts: 2, maxOutputTokens: 0 },
  },
  {
    id: "optimizer",
    name: "Nova Optimizer",
    role: "Performance measurement",
    version: "0.0.0",
    kind: "hybrid",
    status: "planned",
    plannedReason: "No benchmark or profiling harness exists in the project yet, so there is nothing real to measure against.",
    responsibilities: ["Baseline measurements", "Scoped optimisations", "Before/after comparison"],
    output: "Measurements and comparisons",
    tools: [],
    permissions: [],
    defaultModel: null,
    limits: { timeoutMs: 0, maxAttempts: 1, maxOutputTokens: 0 },
  },
  {
    id: "visual",
    name: "Nova Visual",
    role: "Rendered UI verification",
    version: "0.0.0",
    kind: "hybrid",
    status: "planned",
    plannedReason: "Needs a headless browser inside the sandbox and a way to run the app with test data; not set up yet. No screenshots are claimed.",
    responsibilities: ["Screenshot key screens", "Detect layout regressions", "Responsive and accessibility checks"],
    output: "Screenshots and visual findings",
    tools: [],
    permissions: [],
    defaultModel: null,
    limits: { timeoutMs: 0, maxAttempts: 1, maxOutputTokens: 0 },
  },
];

export const agentById = (id: string) => AGENTS.find((a) => a.id === id);
export const agentVersions = () => Object.fromEntries(AGENTS.filter((a) => a.status === "active").map((a) => [a.id, a.version]));
