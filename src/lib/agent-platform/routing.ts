import { CAPABILITY_GAPS, catalogueEntry, entriesFor, type CatalogueEntry } from "./catalogue";
import { DELEGABLE, type DelegableAgent } from "./delegation";
import { TASK_TYPE_LABEL, type AgentId, type TaskType } from "./registry";

/**
 * The orchestrator's router and planner. For one request it works out the
 * kinds of work it needs (rules, no model call: fast, free and predictable),
 * which agent does each (from what agents declare in the catalogue, and
 * whether this user can use them), the order (dependencies) and what can run
 * side by side, and anything no Orbis agent can do. The result decides how
 * the Orbis Agent answers:
 *
 * - direct: nothing specialist is needed; the chat answers itself.
 * - delegate: one agent's task.
 * - plan: several steps, with dependencies; the first can start now.
 * - gap: what's asked isn't something any Orbis agent does; say so.
 *
 * Pure and deterministic, so every routing decision is testable.
 */

/** Phrases that show a kind of work. A request can show several. */
const PATTERNS: [TaskType, RegExp][] = [
  ["fix_bug", /\b(fix(es|ing)?|debug|broken|crash(es|ing)?|\w*error\b|\w*exception|stack ?trace|traceback|doesn'?t work|not working|failing|regression|bugs?)\b/i],
  ["write_tests", /\b((write|add|create|generate|run)\b[^.?!]{0,30}\btests?|unit tests?|integration tests?|test coverage|qa)\b/i],
  ["review_code", /\b((review|audit|check)\b[^.?!]{0,30}\b(code|pr|pull request|repo|repository|diff|changes|project)|code review)\b/i],
  ["security_audit", /\b(security|vulnerab\w*|leaked secrets?|cves?|owasp|pentest|penetration test|xss|sql injection|security headers)\b/i],
  ["web_research", /\b(research|investigate|market (size|analysis|research)|competitors?|literature|state of the art|latest developments|cited report)\b/i],
  ["build_website", /\b(build|create|make|design|launch|set up)\b[^.?!]{0,40}\b(website|landing page|web ?page|homepage|portfolio site|online store|storefront|web ?site)\b/i],
  [
    "implement_feature",
    /\b((implement|build|add|create|refactor|migrate|change|update|extend)\b[^.?!]{0,40}\b(feature|function|endpoint|api|app|application|component|module|code|button|form|integration|login|sign-?in|auth\w*|page|screen|cli|script|service)|refactor\w*)\b/i,
  ],
  ["explain_code", /\b(explain\b[^.?!]{0,20}\b(code|codebase|project|repo|repository|function|file)|how does (this|my|the) (code|project|repo|app) work|walk me through (the|my) (code|codebase))\b/i],
  ["analyse_data", /\b(csv|tsv|spreadsheet|dataset|data ?set|descriptive statistics|analy[sz]e (this|my|the|these) (data|numbers|results))\b/i],
  ["verify_claims", /\b(fact[- ]?check|verify (this|these|the|my) (claims?|facts?|statements?)|check (this|these) claims?)\b/i],
  ["compare_models", /\b(compare|which is better|side by side)\b[^.?!]{0,30}\b(models?|gpt\S*|claude|gemini|llms?|ai answers)\b/i],
  ["plan_project", /\b(plan|roadmap|milestones?|break (it|this) down)\b[^.?!]{0,30}\b(project|launch|goal|product|mission)\b/i],
  ["generate_image", /\b(generate|create|draw|make|design)\b[^.?!]{0,20}\b(an? )?(image|picture|illustration|logo|icon|poster)\b/i],
  ["design_ui", /\b((design|redesign|mock ?up|wireframe)\b[^.?!]{0,30}\b(ui|ux|page|screen|app|interface|layout|dashboard)|improve (the )?(ui|ux|layout|design))\b/i],
  ["write_docs", /\b(write|update|create|generate|add)\b[^.?!]{0,30}\b(docs|documentation|readme|api reference|changelog)\b/i],
  ["deploy", /\b(deploy\w*|go live|host (it|this|my \w+)|push (it )?to production|release (it )?to production|put (it|this|my \w+) online|publish (it|this|my (site|app|website)))\b/i],
  [
    "send_message",
    /\b(send (an? |the )?(email|e-mail|message|newsletter|dm|slack message)|post (it |this )?(on|to) (slack|twitter|x|linkedin|instagram)|email (my|the|our) (team|customers|clients|subscribers))\b/i,
  ],
  ["manage_infrastructure", /\b(provision|scale|configure|set up|manage|restart)\b[^.?!]{0,30}\b(servers?|kubernetes|k8s|aws|gcp|azure|terraform|ec2|database cluster|dns records?|load balancer)\b/i],
  ["make_purchase", /\b(buy|purchase|order|pay for)\b[^.?!]{0,30}\b(for me|domain|licen[cs]e|subscription|ticket|tickets|product|item|it)\b/i],
  ["schedule_automation", /\b(every (day|week|morning|evening|hour|monday|tuesday|wednesday|thursday|friday)|on a schedule|cron job|automatically each|daily at|weekly on)\b/i],
  ["write_text", /\b(write|draft|rewrite|proofread|summari[sz]e|translate|edit)\b[^.?!]{0,30}\b(email|essay|post|article|letter|paragraph|summary|copy|blog|tweet|bio|cover letter|speech|story)\b/i],
];

/** The kinds of work a request shows, most specific wins where two phrases describe the same work. */
export function classify(message: string): TaskType[] {
  const found = new Set<TaskType>(PATTERNS.filter(([, re]) => re.test(message)).map(([t]) => t));
  // "Build a website" is a website, not a generic feature; "write tests" isn't also generic text.
  if (found.has("build_website")) found.delete("implement_feature");
  if (found.has("write_tests") || found.has("write_docs")) found.delete("write_text");
  // A security audit of code is a code review with the security focus; keep both, the router merges them on one agent.
  // Asking to send/post isn't also a writing task.
  if (found.has("send_message")) found.delete("write_text");
  return [...found];
}

/** When a step can start, relative to the others: earlier stages first. */
const STAGE: Record<TaskType, number> = {
  web_research: 0,
  plan_project: 0,
  verify_claims: 0,
  analyse_data: 0,
  compare_models: 0,
  generate_image: 0,
  answer_question: 0,
  write_text: 0,
  explain_code: 1,
  implement_feature: 2,
  build_website: 2,
  fix_bug: 2,
  design_ui: 2,
  write_docs: 2,
  write_tests: 3,
  review_code: 4,
  security_audit: 4,
  deploy: 5,
  send_message: 5,
  manage_infrastructure: 5,
  make_purchase: 5,
  schedule_automation: 5,
};

/** Kinds of work that change the user's project; two of them never run at once on the same project. */
const WRITES: TaskType[] = ["implement_feature", "build_website", "fix_bug", "design_ui", "write_docs", "write_tests"];

export interface RouteStep {
  /** s1, s2… in order. */
  id: string;
  /** The kinds of work this step covers (one agent can cover several, e.g. review and security). */
  types: TaskType[];
  /** The catalogue entry that does it. */
  agent: string;
  agentName: string;
  /** How it starts: a task the Orbis Agent proposes, a page the user opens, or the chat itself. */
  how: "propose" | "open" | "answer";
  href: string | null;
  /** Steps that must finish first. */
  dependsOn: string[];
  /** Steps that can run at the same time as this one. */
  parallelWith: string[];
  /** It changes the project (so it never runs at the same time as another step that does). */
  writes: boolean;
  /** Whether this user can use it here; when not, why. */
  available: boolean;
  unavailable: string | null;
  reason: string;
}

export type Route =
  | { mode: "direct"; types: TaskType[]; steps: []; gaps: []; reason: string }
  | { mode: "delegate" | "plan"; types: TaskType[]; steps: RouteStep[]; gaps: TaskType[]; workflow: "fix_and_verify" | null; reason: string }
  | { mode: "gap"; types: TaskType[]; steps: []; gaps: TaskType[]; reason: string };

/** Whether each task agent is available to this user here (from availability.ts); missing means unknown, treated as unavailable. */
export type AvailabilityMap = Partial<Record<AgentId, { available: boolean; message?: string }>>;

const DIRECT_TYPES: TaskType[] = ["answer_question", "write_text"];

/** Websites, domains and logs are the Security Team's; security in code is Code Review's. */
const SECURITY_TEAM_TARGETS = /\b(website|web ?site|site|url|domain|https?:\/\/\S+|logs?|log files?|headers?|cookies?)\b/i;

/** The best entry for a kind of work: a specialist this user can use, else the best other entry, else none. */
function pick(type: TaskType, avail: AvailabilityMap, message: string): CatalogueEntry | null {
  let entries = entriesFor(type);
  if (type === "security_audit" && SECURITY_TEAM_TARGETS.test(message)) entries = [...entries].sort((a, b) => (a.id === "task:security" ? -1 : b.id === "task:security" ? 1 : 0));
  return entries.find((e) => !e.taskAgent || avail[e.taskAgent]?.available) ?? entries[0] ?? null;
}

/**
 * Route a request: the kinds of work it shows, the agent for each, in which order and what can run side by
 * side, and what no agent does. `avail` says which task agents this user can use here.
 */
export function route(message: string, avail: AvailabilityMap): Route {
  const types = classify(message);
  const gaps = types.filter((t) => CAPABILITY_GAPS.includes(t));
  const work = types.filter((t) => !gaps.includes(t) && !DIRECT_TYPES.includes(t));
  if (!work.length) {
    if (gaps.length) return { mode: "gap", types, steps: [], gaps, reason: `No Orbis agent can ${gaps.map((g) => TASK_TYPE_LABEL[g].toLowerCase()).join(" or ")}.` };
    return { mode: "direct", types, steps: [], gaps: [], reason: "Nothing here needs a specialist agent; the chat answers it." };
  }

  // One step per agent, covering every kind of work that agent was picked for, in stage order.
  const byAgent = new Map<string, { entry: CatalogueEntry; types: TaskType[] }>();
  for (const t of [...work].sort((a, b) => STAGE[a] - STAGE[b])) {
    const entry = pick(t, avail, message);
    if (!entry) continue;
    const cur = byAgent.get(entry.id);
    if (cur) cur.types.push(t);
    else byAgent.set(entry.id, { entry, types: [t] });
  }
  const groups = [...byAgent.values()].sort((a, b) => Math.min(...a.types.map((t) => STAGE[t])) - Math.min(...b.types.map((t) => STAGE[t])));

  const steps: RouteStep[] = groups.map(({ entry, types: ts }, i) => {
    const delegable = !!entry.taskAgent && (DELEGABLE as readonly string[]).includes(entry.taskAgent);
    const available = entry.taskAgent ? !!avail[entry.taskAgent]?.available : true;
    return {
      id: `s${i + 1}`,
      types: ts,
      agent: entry.id,
      agentName: entry.name,
      how: entry.level === "orchestrator" ? "answer" : delegable ? "propose" : "open",
      href: entry.href,
      dependsOn: [],
      parallelWith: [],
      writes: ts.some((t) => WRITES.includes(t)),
      available,
      unavailable: available ? null : (avail[entry.taskAgent!]?.message ?? "Not available to you here."),
      reason: `${ts.map((t) => TASK_TYPE_LABEL[t]).join(" and ")}: ${entry.role.charAt(0).toLowerCase()}${entry.role.slice(1)}.`,
    };
  });

  // Dependencies: a step waits for every earlier-stage step it builds on. Research and planning come before
  // building; tests and review come after building, side by side; two steps that change the project never
  // run at the same time.
  const stage = (s: RouteStep) => Math.min(...s.types.map((t) => STAGE[t]));
  for (const s of steps) {
    for (const o of steps) {
      if (o === s || stage(o) >= stage(s)) continue;
      const builds = stage(o) === 2; // what tests and review look at
      const informs = stage(o) === 0 && stage(s) === 2; // research before building
      const sameResource = o.writes && s.writes;
      if ((stage(s) >= 3 && builds) || informs || sameResource) s.dependsOn.push(o.id);
    }
  }
  // Two writers in the same stage (fix and build) go one after the other.
  const writers = steps.filter((s) => s.writes);
  for (let i = 1; i < writers.length; i++) if (!writers[i]!.dependsOn.includes(writers[i - 1]!.id) && stage(writers[i]!) === stage(writers[i - 1]!)) writers[i]!.dependsOn.push(writers[i - 1]!.id);
  for (const s of steps) {
    s.parallelWith = steps.filter((o) => o !== s && !(o.writes && s.writes) && !dependsTransitively(steps, s, o) && !dependsTransitively(steps, o, s)).map((o) => o.id);
  }

  const fixAndVerify =
    steps.some((s) => s.agent === "task:bug_fixer") &&
    steps.some((s) => s.agent === "task:qa_tester" || s.agent === "task:code_review") &&
    steps.every((s) => ["task:bug_fixer", "task:qa_tester", "task:code_review"].includes(s.agent));
  const mode = steps.length === 1 ? "delegate" : "plan";
  const reason =
    mode === "delegate"
      ? `${steps[0]!.agentName} does this.`
      : `${steps.length} steps: ${steps.map((s) => `${s.agentName}${s.dependsOn.length ? ` after ${s.dependsOn.join(", ")}` : ""}`).join("; ")}.`;
  return { mode, types, steps, gaps, workflow: fixAndVerify ? "fix_and_verify" : null, reason };
}

function dependsTransitively(steps: RouteStep[], a: RouteStep, b: RouteStep, seen = new Set<string>()): boolean {
  if (a.dependsOn.includes(b.id)) return true;
  for (const d of a.dependsOn) {
    if (seen.has(d)) continue;
    seen.add(d);
    const next = steps.find((s) => s.id === d);
    if (next && dependsTransitively(steps, next, b, seen)) return true;
  }
  return false;
}

/** The task agents a route proposes now: the first available step with no unmet dependency, if the orchestrator can start it. */
export function firstProposable(r: Route): DelegableAgent | null {
  const s = r.steps.find((x) => x.how === "propose" && x.available && x.dependsOn.length === 0);
  const id = s ? catalogueEntry(s.agent)?.taskAgent : null;
  return id && (DELEGABLE as readonly string[]).includes(id) ? (id as DelegableAgent) : null;
}

/** What the Orbis Agent is told about the route for this message (empty for a direct answer). */
export function routePrompt(r: Route): string {
  if (r.mode === "direct") return "";
  const lines: string[] = ["Routing for this message (from Orbis's agent catalogue; follow it):"];
  if (r.mode === "gap" || r.gaps.length) {
    lines.push(
      `- Capability gap: no Orbis agent can ${r.gaps.map((g) => TASK_TYPE_LABEL[g].toLowerCase()).join(", ")}. Say so plainly, don't pretend or simulate it, and say what Orbis can do instead (for example prepare the files, a draft or a plan the user carries out).`,
    );
  }
  for (const s of r.steps) {
    const when = s.dependsOn.length ? `after ${s.dependsOn.join(" and ")}` : "can start now";
    const side = s.parallelWith.length ? `; can run alongside ${s.parallelWith.join(", ")}` : "";
    const how = !s.available
      ? `not available to this user (${s.unavailable}); say so and don't propose it`
      : s.how === "propose"
        ? "you can propose it as an orbis-task card"
        : s.how === "open"
          ? `the user starts it on its page (${s.href}); point them there, don't propose a card`
          : "answer it yourself";
    lines.push(`- ${s.id}: ${s.agentName} — ${s.types.map((t) => TASK_TYPE_LABEL[t]).join(", ")}; ${when}${side}; ${how}.`);
  }
  if (r.mode === "plan") {
    lines.push(
      "- This is several steps. Propose only the first step that can start now (one card), then list the remaining steps in order with which can run side by side. Never claim a later step has started.",
    );
    if (r.workflow)
      lines.push("- These steps match the Fix and verify workflow (/agents/workflows): Bug Fixing, then QA Testing and Code Review side by side, then the user's decision. Mention it as an option.");
  }
  return lines.join("\n");
}
