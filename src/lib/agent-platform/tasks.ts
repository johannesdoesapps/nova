import "server-only";
import { z } from "zod";
import { bugInput, bugRequest, clipLog, qaInput, qaRequest } from "../code/agent/profiles";
import { createRun, openRun, toRunView } from "../code/agent/runs";
import { DEFAULT_STEP_LIMIT, type RunOptions, type RunView } from "../code/agent/types";
import { getProjectRow, type Authed } from "../code/server";
import { ApiError } from "../http";
import { PROFILE_SLUG, type CodeProfile } from "./registry";
import { assertAgentAccess } from "./server";

/**
 * Starting a Bug Fixing or QA Testing task: the user's form is validated, the
 * agent's access is checked on the server (plan and configuration), and a run
 * of the coding engine is created with the agent's profile. The run is then
 * driven, approved and reviewed in the project's Code workspace like any
 * other task; its profile adds the agent's instructions, permissions and
 * report section.
 */

const options = z
  .object({ modelId: z.string().max(120).nullable().optional(), approvePlans: z.boolean().optional(), reviewEdits: z.boolean().optional(), commands: z.enum(["safe", "ask", "off"]).optional() })
  .optional();

export const startTaskBody = z.discriminatedUnion("agent", [
  z.object({ agent: z.literal("bug_fixer"), projectId: z.string().uuid(), input: bugInput, options }),
  z.object({ agent: z.literal("qa_tester"), projectId: z.string().uuid(), input: qaInput, options }),
]);
export type StartTask = z.infer<typeof startTaskBody>;

/** The more steps a profile usually takes: a bug fix reproduces, fixes and re-runs; QA writes and runs several test files. */
const STEP_LIMIT: Record<CodeProfile, number> = { bug_fixer: DEFAULT_STEP_LIMIT + 5, qa_tester: DEFAULT_STEP_LIMIT + 5 };

/** `workflowId` is set by the server when a workflow starts the task (never taken from the request). */
export async function startProfileTask(auth: Authed, t: StartTask, workflowId?: string): Promise<{ run: RunView; href: string }> {
  await assertAgentAccess(auth, t.agent);
  const project = await getProjectRow(auth, t.projectId);
  const open = await openRun(auth, project.id);
  if (open) throw new ApiError("conflict", "An agent is already working on this project. Stop that task or let it finish first.", { runId: open.id });
  const request = t.agent === "bug_fixer" ? bugRequest(t.input) : qaRequest(t.input);
  // The form is kept (with long logs clipped as the agent saw them) so the task can be retried.
  const agentInput = t.agent === "bug_fixer" ? { ...t.input, logs: clipLog(t.input.logs) } : t.input;
  const o = t.options ?? {};
  const runOptions: RunOptions = {
    modelId: o.modelId ?? null,
    // The plan is approved before anything changes unless the user turns that off.
    approvePlans: o.approvePlans ?? true,
    reviewEdits: o.reviewEdits ?? false,
    commands: o.commands ?? "safe",
    readOnly: false,
    web: false,
    agent: t.agent,
    agentInput,
    ...(workflowId ? { workflowId } : {}),
  };
  const row = await createRun(auth, { projectId: project.id, request, options: runOptions, stepLimit: STEP_LIMIT[t.agent] });
  return { run: toRunView(row), href: `/code/${project.id}?run=${row.id}&from=${PROFILE_SLUG[t.agent]}` };
}
