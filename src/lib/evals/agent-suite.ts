import recoveryCases from "../../../evals/agents/recovery.json";
import routingCases from "../../../evals/agents/routing.json";
import securityCases from "../../../evals/agents/security.json";
import { classifyFailure, shouldRetry } from "../agent-platform/failures";
import { AGENT_IDS, type AgentId } from "../agent-platform/registry";
import { route, type AvailabilityMap } from "../agent-platform/routing";
import { qaMayEdit } from "../code/agent/profiles";
import { classifyCommand } from "../code/agent/policy";
import { findSecrets } from "../secrets";

/**
 * The agent evaluation suite: fixed, representative cases (evals/agents/*.json) for routing, security and
 * failure recovery, each with a measurable expected result. Scores are compared with evals/agents/baseline.json
 * by tests/agent-evals.test.ts, so a change that makes any suite worse fails before it can be deployed.
 *
 * Runs without a model (deterministic parts only). The answer-quality check in Admin is the real-model
 * evaluation; agent tasks against real models aren't part of this suite (they cost money and vary run to run).
 */

export interface SuiteResult {
  suite: string;
  passed: number;
  total: number;
  /** passed ÷ total, rounded to 3 places. */
  score: number;
  failures: string[];
}

/** Samples written «a|b» are joined here, so fake credentials never sit whole in the repository (secret scanners would flag them). */
const expand = (t: string) => t.replace(/«([^»]*)»/g, (_, parts: string) => parts.split("|").join(""));

const ALL: AvailabilityMap = Object.fromEntries(AGENT_IDS.map((id) => [id, { available: true }]));

function result(suite: string, checks: { ok: boolean; what: string }[]): SuiteResult {
  const passed = checks.filter((c) => c.ok).length;
  return { suite, passed, total: checks.length, score: checks.length ? Math.round((passed / checks.length) * 1000) / 1000 : 1, failures: checks.filter((c) => !c.ok).map((c) => c.what) };
}

export function routingSuite(): SuiteResult {
  return result(
    "routing",
    routingCases.cases.map((c: { message: string; mode: string; agents?: string[] }) => {
      const r = route(c.message, ALL);
      // Steps name catalogue entries ("task:bug_fixer"); the cases name the task agent.
      const agents = r.mode === "delegate" || r.mode === "plan" ? [...new Set(r.steps.map((s) => s.agent?.replace(/^task:/, "")).filter((a): a is AgentId => !!a))].sort() : [];
      const wantAgents = c.agents ? [...c.agents].sort() : null;
      const ok = r.mode === c.mode && (!wantAgents || JSON.stringify(agents) === JSON.stringify(wantAgents));
      return { ok, what: `"${c.message}": expected ${c.mode}${wantAgents ? ` [${wantAgents.join(", ")}]` : ""}, got ${r.mode}${agents.length ? ` [${agents.join(", ")}]` : ""}` };
    }),
  );
}

export function securitySuite(): SuiteResult {
  const s = securityCases;
  return result("security", [
    ...s.secrets.map((c) => {
      const found = findSecrets(expand(c.text)).length > 0;
      return { ok: found === c.secret, what: `secret ${c.secret ? "missed" : "false alarm"}: ${c.text.slice(0, 40)}…` };
    }),
    ...s.commands.map((c) => {
      const d = classifyCommand(c.command).kind;
      return { ok: d === c.decision, what: `command "${c.command}": expected ${c.decision}, got ${d}` };
    }),
    ...s.qaEdits.map((c) => ({ ok: qaMayEdit(c.path) === c.allowed, what: `QA edit ${c.path}: expected ${c.allowed ? "allowed" : "refused"}` })),
  ]);
}

export function recoverySuite(): SuiteResult {
  const r = recoveryCases;
  return result("recovery", [
    ...r.classify.map((c: { error: string; kind?: string; class: string }) => {
      const got = classifyFailure(c.error, c.kind).class;
      return { ok: got === c.class, what: `"${c.error}"${c.kind ? ` (${c.kind})` : ""}: expected ${c.class}, got ${got}` };
    }),
    ...r.retry.map((c) => {
      const got = shouldRetry(c.errors, c.attempts, c.max).retry;
      return { ok: got === c.retry, what: `retry after [${c.errors.join(" | ")}] at attempt ${c.attempts}/${c.max}: expected ${c.retry}, got ${got}` };
    }),
  ]);
}

export const runAgentSuites = (): SuiteResult[] => [routingSuite(), securitySuite(), recoverySuite()];
