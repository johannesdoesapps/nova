import { z } from "zod";
import { bugInput, qaInput, QA_KINDS } from "../code/agent/profiles";
import type { TaskAssignment } from "./protocol";
import { agentDef } from "./registry";

/**
 * The Orbis Agent in chat: when a message asks for work a specialist does
 * (fix a bug, write tests, review code, research, build or change something),
 * the reply can propose a task for that agent. The proposal is a card the user
 * reviews, edits and starts; nothing starts from the model's words alone, and
 * the server checks the agent's access, the project's ownership and the input
 * again when the user presses Start. The model never claims a task ran.
 *
 * Pure: the chat route decides when to offer delegation and extracts the
 * proposal; the start endpoint runs it.
 */

export const DELEGABLE = ["engineer", "bug_fixer", "qa_tester", "code_review", "deep_research"] as const;
export type DelegableAgent = (typeof DELEGABLE)[number];

export const engineerInput = z.object({ request: z.string().trim().min(3).max(4_000), readOnly: z.boolean().default(false) });
export const reviewInput = z.object({ url: z.string().trim().max(400).optional(), focus: z.string().trim().max(500).default("") });
export const researchInput = z.object({ question: z.string().trim().min(5).max(2_000), depth: z.enum(["quick", "standard", "deep"]).default("quick") });

export const INPUT_SCHEMAS = { engineer: engineerInput, bug_fixer: bugInput, qa_tester: qaInput, code_review: reviewInput, deep_research: researchInput } as const;

/** Agents that work on one of the user's Orbis projects. */
export const NEEDS_PROJECT: Record<DelegableAgent, "required" | "optional" | "none"> = {
  engineer: "required",
  bug_fixer: "required",
  qa_tester: "required",
  code_review: "optional",
  deep_research: "none",
};

export interface ProposalField {
  key: string;
  label: string;
  kind: "text" | "textarea" | "select" | "project";
  options?: { value: string; label: string }[];
}

export const PROPOSAL_FIELDS: Record<DelegableAgent, ProposalField[]> = {
  engineer: [
    { key: "request", label: "What should it do?", kind: "textarea" },
    {
      key: "readOnly",
      label: "Mode",
      kind: "select",
      options: [
        { value: "false", label: "Make changes (plan approved first)" },
        { value: "true", label: "Read-only: explain, don't change anything" },
      ],
    },
  ],
  bug_fixer: [
    { key: "summary", label: "What's wrong?", kind: "text" },
    { key: "details", label: "Details", kind: "textarea" },
    { key: "logs", label: "Error output or stack trace", kind: "textarea" },
  ],
  qa_tester: [
    { key: "scope", label: "What should be tested?", kind: "textarea" },
    {
      key: "kinds",
      label: "Kinds of tests",
      kind: "select",
      options: [
        { value: "unit", label: "Unit" },
        { value: "unit,integration", label: "Unit and integration" },
        { value: "unit,api", label: "Unit and API" },
        { value: "unit,integration,api", label: "Unit, integration and API" },
      ],
    },
  ],
  code_review: [
    { key: "url", label: "GitHub repository or pull request (leave empty to review the project)", kind: "text" },
    { key: "focus", label: "Anything to focus on", kind: "textarea" },
  ],
  deep_research: [
    { key: "question", label: "Research question", kind: "textarea" },
    {
      key: "depth",
      label: "Depth",
      kind: "select",
      options: [
        { value: "quick", label: "Quick (2 questions)" },
        { value: "standard", label: "Standard (4 questions)" },
        { value: "deep", label: "Deep (6 questions)" },
      ],
    },
  ],
};

export interface TaskProposal {
  id: string;
  agent: DelegableAgent;
  agentName: string;
  projectId: string | null;
  projectName: string | null;
  input: Record<string, unknown>;
  status: "proposed" | "started" | "failed";
  result?: { summary: string; href: string | null };
  /** What the agent was given once started (the task protocol's assignment). */
  assignment?: TaskAssignment;
}

/** Messages that ask for work a specialist agent does, or about tasks already running. */
const WORK =
  /\b(fix|bug|broken|crash(es|ing)?|\w*error|\w*exception|stack ?trace|traceback|failing|regression|tests?|unit tests?|qa|review|audit|vulnerab\w*|security|research|investigate|compare|refactor|implement|build|add (a|an|the)? ?feature|explain (this|the|my) (code|project|repo)|code ?base|repo(sitory)?|pull request|PR\b)/i;
const STATUS = /\b(tasks?|agents?|running|in progress|status|progress|waiting|finished|done yet|still going)\b/i;

export function wantsDelegation(message: string): boolean {
  return WORK.test(message);
}

export function asksAboutTasks(message: string): boolean {
  return STATUS.test(message) && /\b(what|which|how|is|are|any|show|list|status)\b/i.test(message);
}

const DESCRIBE: Record<DelegableAgent, string> = {
  engineer:
    '"engineer" — Software Engineer: builds features, changes, refactors or explains code in an Orbis project. input: {"request": "<what to do>", "readOnly": <true only to explain without changes>}',
  bug_fixer:
    '"bug_fixer" — Bug Fixing: reproduces a bug, fixes the cause, re-runs tests. input: {"summary": "<one line>", "details": "<what happens>", "logs": "<the error or stack trace the user gave, verbatim, or empty>", "reproduce": "", "expected": ""}',
  qa_tester: `"qa_tester" — QA Testing: writes and runs tests; may only change test files. input: {"scope": "<what to test>", "kinds": [${QA_KINDS.map((k) => `"${k}"`).join(", ")}]}`,
  code_review:
    '"code_review" — Code Review: finds bugs and security problems with line references. Either a project ("projectId") or input {"url": "<a public GitHub repo or pull request URL the user gave>"}; input.focus optional.',
  deep_research: '"deep_research" — Deep Research: searches the web and writes a cited report. No project. input: {"question": "<the research question>", "depth": "quick" | "standard" | "deep"}',
};

/**
 * What the model is told for a turn where delegation may help: the agents this user can start here,
 * their projects (names are the user's own text, fenced as data), and the block format.
 */
export function delegationPrompt(available: DelegableAgent[], projects: { id: string; name: string }[]): string {
  if (!available.length) return "";
  const list = projects.length ? projects.map((p) => `- ${p.id}: ${p.name.replace(/[<>]/g, "")}`).join("\n") : "(none yet: the user can create one in Code, import from GitHub or upload a ZIP)";
  return [
    "You are also the Orbis Agent: you can hand work to Orbis's specialist agents, which run real tasks in isolated computers and keep their own records.",
    "If, and only if, the user asks for work one of these agents does, answer briefly (what you'd hand over and why, and anything they should know), then end your reply with exactly one block:",
    "```orbis-task",
    '{"agent": "<id>", "projectId": "<project id or null>", "input": {...}}',
    "```",
    "Orbis shows it as a card the user reviews, edits and starts. Nothing has started until they press Start, so never say a task is running, done, fixed or tested. If you need something you don't have (which project, the error message), ask instead of proposing. Answer questions you can answer yourself directly, without a block.",
    "Agents the user can start:",
    ...available.map((a) => `- ${DESCRIBE[a]}`),
    `The user's Orbis projects (use the id):\n<projects>\n${list}\n</projects>`,
  ].join("\n");
}

const BLOCK = /```orbis-task\s*\n([\s\S]*?)```/;
const block = z.object({ agent: z.string(), projectId: z.string().nullable().optional(), input: z.record(z.string(), z.unknown()).default({}) });

/**
 * Take an orbis-task block out of a reply and turn it into a proposal when it names an agent the user can
 * start, with valid input and (when needed) one of their projects. Otherwise the block is removed and a
 * short note says why nothing was prepared.
 */
export function extractTask(text: string, ctx: { available: DelegableAgent[]; projects: { id: string; name: string }[] }, id: () => string): { text: string; proposal: TaskProposal | null } {
  const m = BLOCK.exec(text);
  if (!m) return { text, proposal: null };
  const rest = text.replace(BLOCK, "").trimEnd();
  const fail = (why: string) => ({ text: `${rest}\n\n_(${why} Nothing was prepared.)_`, proposal: null });
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch {
    return fail("The proposed task couldn't be read.");
  }
  const b = block.safeParse(raw);
  if (!b.success) return fail("The proposed task couldn't be read.");
  const agent = b.data.agent as DelegableAgent;
  if (!(DELEGABLE as readonly string[]).includes(agent) || !ctx.available.includes(agent)) return fail("That agent isn't available to you here.");
  const input = INPUT_SCHEMAS[agent].safeParse(b.data.input);
  if (!input.success) return fail(`The ${agentDef(agent)!.name} task was incomplete (${input.error.issues[0]?.path.join(".") || "input"}: ${input.error.issues[0]?.message ?? "invalid"}).`);
  const need = NEEDS_PROJECT[agent];
  const project = b.data.projectId ? (ctx.projects.find((p) => p.id === b.data.projectId) ?? null) : null;
  if (b.data.projectId && !project) return fail("That project isn't one of yours.");
  if (need === "required" && !project) return fail(`${agentDef(agent)!.name} needs one of your Orbis projects.`);
  if (agent === "code_review" && !project && !(input.data as { url?: string }).url) return fail("Code Review needs a project or a GitHub link.");
  return {
    text: rest,
    proposal: {
      id: id(),
      agent,
      agentName: agentDef(agent)!.name,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      input: input.data as Record<string, unknown>,
      status: "proposed",
    },
  };
}

/** A stray block in a turn without delegation is removed, never shown as raw JSON. */
export function stripTaskBlock(text: string): string {
  return text.includes("```orbis-task") ? text.replace(/```orbis-task[\s\S]*?(```|$)/, "").trimEnd() : text;
}

/** The start request: which agent, the project, and the (possibly edited) input. */
export const startDelegated = z.object({
  agent: z.enum(DELEGABLE),
  projectId: z.string().uuid().nullable().optional(),
  input: z.record(z.string(), z.unknown()),
  messageId: z.string().uuid().optional(),
  proposalId: z.string().uuid().optional(),
});
