import { NextResponse } from "next/server";
import { filterQuery, searchPattern, TASK_FILTERS, TASK_SORTS, toTaskSummary, type TaskFilter, type TaskSort } from "@/lib/code/agent/history";
import { changeCounts, listTasks, toRunView } from "@/lib/code/agent/runs";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";

const PAGE = 30;

/**
 * GET /api/code/tasks?filter=&q=&project=&sort=&offset= — the signed-in user's coding tasks across
 * their projects (History), newest activity first. Only the user's own tasks, by the query and by
 * row-level security. Each comes with its project's name, outcome, files changed and how it can be
 * picked up again; never its transcript.
 */
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const filter = (TASK_FILTERS as readonly string[]).includes(sp.get("filter") ?? "") ? (sp.get("filter") as TaskFilter) : "all";
    const sort = (TASK_SORTS as readonly string[]).includes(sp.get("sort") ?? "") ? (sp.get("sort") as TaskSort) : "activity";
    const projectParam = sp.get("project");
    const project = projectParam ? requireUuid(projectParam) : null;
    const offset = Math.min(10_000, Math.max(0, Number(sp.get("offset") ?? 0) || 0));
    const auth = await codeContext("code-tasks", 120);
    const { rows, more } = await listTasks(auth, { ...filterQuery(filter), pattern: searchPattern(sp.get("q")), projectId: project, pairOnly: sp.get("kind") === "pair", sort, offset, limit: PAGE });
    const counts = await changeCounts(
      auth,
      rows.map((r) => r.id),
    );
    const tasks = rows.map((r) => toTaskSummary(toRunView(r), r.project?.name ?? "Deleted project", counts[r.id] ?? 0));
    return NextResponse.json({ tasks, more, nextOffset: more ? offset + PAGE : null });
  } catch (err) {
    return errorResponse(err);
  }
}
