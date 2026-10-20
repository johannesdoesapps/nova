import { NextResponse } from "next/server";
import { codeContext, createProject, listProjects, workspaceAllowance } from "@/lib/code/server";
import { newProjectBody, TEMPLATES } from "@/lib/code/projects";
import { errorResponse, parseJsonBody } from "@/lib/http";

/** GET /api/code/projects — the user's code projects, their plan's limits and workspace time left. */
export async function GET() {
  try {
    const auth = await codeContext();
    const [projects, a] = await Promise.all([listProjects(auth), workspaceAllowance(auth)]);
    return NextResponse.json({
      projects,
      maxProjects: a.entitlement.kind === "unlimited" ? null : a.entitlement.limits.codeProjects,
      allowance: { used: a.used, limit: a.limit, left: a.left, blockMinutes: a.blockMinutes, resetsAt: a.resetsAt },
      plan: a.entitlement.plan,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/code/projects — create a project from a starter template. */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, newProjectBody, 4_000);
    const auth = await codeContext();
    const t = TEMPLATES[body.template];
    const project = await createProject(auth, {
      name: body.name,
      template: t.id,
      runCommand: t.runCommand,
      files: Object.entries(t.files).map(([path, content]) => ({ path, content })),
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
