/**
 * Every consequential thing an Orbis agent can do, classified by risk and reversibility, with the approval
 * it needs and where the server enforces it. The enforcement lives in code at the point the tool runs, never
 * only in an agent's instructions: each entry names the file and a line of that code (`anchor`), and the
 * tests check the anchor is really there, so the table can't drift from what runs.
 *
 * Low-risk, reversible work proceeds on its own; anything that reaches outside the project, can't be undone,
 * or costs money needs the user; some things are never allowed at all.
 */

export type Risk = "low" | "medium" | "high";
export type Reversible = "yes" | "partly" | "no";
export type Approval = "none" | "optional" | "asks" | "always" | "never_allowed";

export interface ActionRisk {
  id: string;
  action: string;
  agents: string;
  risk: Risk;
  reversible: Reversible;
  approval: Approval;
  how: string;
  /** The file that enforces it, and a piece of its code that does. */
  enforcedIn: string;
  anchor: string;
}

export const APPROVAL_LABEL: Record<Approval, string> = {
  none: "Runs on its own",
  optional: "Optional review",
  asks: "Asks unless known safe",
  always: "Always asks you",
  never_allowed: "Never allowed",
};

export const ACTION_RISKS: ActionRisk[] = [
  {
    id: "read_project",
    action: "Read the project's files",
    agents: "Coding agents, Code Review",
    risk: "low",
    reversible: "yes",
    approval: "none",
    how: "Secret files (.env, keys) are listed but their contents are withheld from the model.",
    enforcedIn: "src/lib/code/agent/tools.ts",
    anchor: "isSecretPath",
  },
  {
    id: "edit_project",
    action: "Change files in an Orbis project",
    agents: "Software Engineer, Bug Fixing, Website Builder",
    risk: "medium",
    reversible: "yes",
    approval: "optional",
    how: "Changes are checkpointed and can be reverted; you can turn on reviewing each edit. Read-only tasks can't edit.",
    enforcedIn: "src/lib/code/agent/tools.ts",
    anchor: "state.reviewEdits",
  },
  {
    id: "edit_tests_only",
    action: "Change test files",
    agents: "QA Testing",
    risk: "low",
    reversible: "yes",
    approval: "none",
    how: "Edits outside tests, test helpers and test configuration are refused.",
    enforcedIn: "src/lib/code/agent/tools.ts",
    anchor: "state.testsOnly && !qaMayEdit",
  },
  {
    id: "plan",
    action: "Start changing a project",
    agents: "Coding agents",
    risk: "medium",
    reversible: "yes",
    approval: "always",
    how: "The plan waits for your approval first (on by default).",
    enforcedIn: "src/lib/code/agent/tools.ts",
    anchor: "approved: !state.approvePlans",
  },
  {
    id: "safe_command",
    action: "Run a known-safe command (tests, build, list files)",
    agents: "Coding agents",
    risk: "low",
    reversible: "yes",
    approval: "none",
    how: "Only in the project's isolated computer; 2 minutes per command.",
    enforcedIn: "src/lib/code/agent/policy.ts",
    anchor: "const SAFE",
  },
  {
    id: "other_command",
    action: "Run any other command",
    agents: "Coding agents",
    risk: "medium",
    reversible: "partly",
    approval: "asks",
    how: "Commands outside the safe list wait for your approval.",
    enforcedIn: "src/lib/code/agent/policy.ts",
    anchor: 'kind: "ask"',
  },
  {
    id: "blocked_command",
    action: "Deploy, push, use administrator rights, or delete the project from a command",
    agents: "Coding agents",
    risk: "high",
    reversible: "no",
    approval: "never_allowed",
    how: "Refused even with approval.",
    enforcedIn: "src/lib/code/agent/policy.ts",
    anchor: "const BLOCKED",
  },
  {
    id: "push_github",
    action: "Push a project to GitHub",
    agents: "You, from Code (not an agent)",
    risk: "high",
    reversible: "partly",
    approval: "always",
    how: "Only to a new branch, after you confirm in a dialog.",
    enforcedIn: "src/app/api/code/projects/[id]/github-push/route.ts",
    anchor: "confirm: z.literal(true)",
  },
  {
    id: "connector_write",
    action: "Send, post or create something in a connected service",
    agents: "Orbis Agent (Connectors)",
    risk: "high",
    reversible: "no",
    approval: "always",
    how: "Only for a connection you allowed to write, after you confirm the exact action card.",
    enforcedIn: "src/lib/connectors/runtime.ts",
    anchor: "if (!row!.write_enabled)",
  },
  {
    id: "scan_website",
    action: "Scan a website",
    agents: "Security Team (Sentinel)",
    risk: "medium",
    reversible: "yes",
    approval: "always",
    how: "Only websites you've proved you own, re-checked before every scan; GET requests to the same site within a page and time budget; active testing only when you choose it; rate limits per user and site.",
    enforcedIn: "src/lib/security/runners.ts",
    anchor: "proveOwnership",
  },
  {
    id: "start_task",
    action: "Start a specialist task proposed in chat",
    agents: "Orbis Agent",
    risk: "medium",
    reversible: "yes",
    approval: "always",
    how: "A proposal is a card; nothing starts until you press Start, and the same access checks apply.",
    enforcedIn: "src/lib/agent-platform/tasks.ts",
    anchor: "await assertAgentAccess(auth, t.agent)",
  },
  {
    id: "remember",
    action: "Add a note to project memory",
    agents: "Coding agents",
    risk: "low",
    reversible: "yes",
    approval: "always",
    how: "Saved as a suggestion; used only after you approve it. Notes containing secrets are refused.",
    enforcedIn: "src/lib/code/memory-store.ts",
    anchor: "refuseSecrets(",
  },
  {
    id: "reject_workflow",
    action: "Undo a workflow's changes",
    agents: "You, at a workflow's decision",
    risk: "medium",
    reversible: "partly",
    approval: "always",
    how: "Undoes every attempt's changes, newest first; stops if a file changed since.",
    enforcedIn: "src/lib/agent-platform/workflow-server.ts",
    anchor: "tasksToUndo(row.steps)",
  },
  {
    id: "pause_agent",
    action: "Pause or resume an agent for everyone",
    agents: "Administrators",
    risk: "medium",
    reversible: "yes",
    approval: "always",
    how: "Administrators only; recorded in the admin audit log.",
    enforcedIn: "src/app/api/admin/agents/route.ts",
    anchor: "requireAdmin",
  },
];

export const actionRisk = (id: string) => ACTION_RISKS.find((a) => a.id === id) ?? null;
