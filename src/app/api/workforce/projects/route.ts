import { NextResponse } from "next/server";
import { ApiError, parseJsonBody } from "@/lib/http";
import { detectChecks } from "@/lib/workforce/checks";
import { fetchPackageJson, projectCreateSchema, requireOperator, wfError } from "@/lib/workforce/server";

/** GET /api/workforce/projects */
export async function GET() {
  try {
    const { store } = await requireOperator();
    return NextResponse.json({ projects: await store.listProjects() });
  } catch (err) {
    return wfError(err);
  }
}

/** POST /api/workforce/projects — register a GitHub repository; checks are detected from package.json. */
export async function POST(req: Request) {
  try {
    const { store } = await requireOperator();
    const body = await parseJsonBody(req, projectCreateSchema);
    const pkg = await fetchPackageJson(body.repo, body.branch);
    const checks = detectChecks(pkg as Parameters<typeof detectChecks>[0]);
    if (!checks.some((c) => c.required)) throw new ApiError("bad_request", "No typecheck, lint or test scripts were found in package.json, so changes couldn't be verified.");
    const project = await store.createProject({ name: body.name, repo: body.repo, branch: body.branch, package_manager: "npm", checks, notes: body.notes });
    await store.addEvent({ task_id: null, level: "audit", type: "project.registered", message: `Project registered: ${body.repo}@${body.branch} (${checks.map((c) => c.id).join(", ")})` });
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    return wfError(err);
  }
}
