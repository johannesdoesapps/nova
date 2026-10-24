import "server-only";
import { createRun, openRun } from "../code/agent/runs";
import { DEFAULT_STEP_LIMIT } from "../code/agent/types";
import { bugInput, qaInput } from "../code/agent/profiles";
import { getProjectRow, type Authed } from "../code/server";
import { ApiError } from "../http";
import { createResearch } from "../research/server";
import { createReview } from "../review/server";
import { engineerInput, researchInput, reviewInput, type DelegableAgent } from "./delegation";
import { assertAgentAccess } from "./server";
import { startProfileTask } from "./tasks";

/**
 * Starting a task the Orbis Agent proposed in chat, after the user pressed
 * Start (with any edits). Everything is checked again here: the agent's
 * access for this user, the input, and that the project is theirs (row-level
 * security). The task then runs on its own page like any other, which is
 * where its progress, approvals and results are.
 */
export async function startDelegatedTask(
  req: Request,
  auth: Authed,
  agent: DelegableAgent,
  projectId: string | null,
  raw: Record<string, unknown>,
): Promise<{ summary: string; href: string; taskId: string }> {
  await assertAgentAccess(auth, agent);
  const needProject = async () => {
    if (!projectId) throw new ApiError("bad_request", "Choose one of your projects first.");
    return getProjectRow(auth, projectId);
  };
  const parse = <T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }) => {
    const r = schema.safeParse(raw);
    if (!r.success) throw new ApiError("bad_request", r.error.issues[0]?.message ?? "Some details are missing.");
    return r.data;
  };

  switch (agent) {
    case "engineer": {
      const input = parse(engineerInput);
      const project = await needProject();
      const open = await openRun(auth, project.id);
      if (open) throw new ApiError("conflict", "An agent is already working on this project. Stop that task or let it finish first.", { runId: open.id });
      const row = await createRun(auth, {
        projectId: project.id,
        request: input.request,
        options: input.readOnly
          ? { modelId: null, approvePlans: false, reviewEdits: false, commands: "off", readOnly: true }
          : { modelId: null, approvePlans: true, reviewEdits: false, commands: "safe", readOnly: false },
        stepLimit: DEFAULT_STEP_LIMIT,
      });
      return {
        summary: `Software Engineer task created in ${project.name}${input.readOnly ? " (read-only)" : "; it proposes a plan for you to approve first"}.`,
        href: `/code/${project.id}?run=${row.id}`,
        taskId: row.id,
      };
    }
    case "bug_fixer":
    case "qa_tester": {
      const project = await needProject();
      const r =
        agent === "bug_fixer"
          ? await startProfileTask(auth, { agent, projectId: project.id, input: parse(bugInput) })
          : await startProfileTask(auth, { agent, projectId: project.id, input: { ...parse(qaInput) } });
      return { summary: `${agent === "bug_fixer" ? "Bug Fixing" : "QA Testing"} task created in ${project.name}; it proposes a plan for you to approve first.`, href: r.href, taskId: r.run.id };
    }
    case "code_review": {
      const input = parse(reviewInput);
      const source = projectId ? { kind: "project" as const, projectId: (await needProject()).id } : input.url ? { kind: "github" as const, url: input.url } : null;
      if (!source) throw new ApiError("bad_request", "Choose a project or give a GitHub link to review.");
      const review = await createReview(req, auth, { source, focus: input.focus || null });
      return { summary: `Code review started: ${review.title}.`, href: `/review/${review.id}`, taskId: review.id };
    }
    case "deep_research": {
      const input = parse(researchInput);
      const run = await createResearch(auth, { question: input.question, depth: input.depth, context: null });
      return { summary: `Deep Research started (${input.depth}).`, href: `/research/${run.id}`, taskId: run.id };
    }
  }
}
