import { NextResponse } from "next/server";
import { workflowInput } from "@/lib/agent-platform/workflow";
import { createWorkflow, listWorkflows, toWorkflowView, workflowsReady } from "@/lib/agent-platform/workflow-server";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody } from "@/lib/http";

/**
 * GET /api/workflows — the signed-in user's workflows, newest first (row-level security: only their own),
 * and whether workflows can run on this deployment (`ready`). `?check=1` returns only `ready`.
 */
export async function GET(req: Request) {
  try {
    const auth = await codeContext("workflows-read", 120);
    const ready = await workflowsReady(auth);
    if (!ready || new URL(req.url).searchParams.get("check") === "1") return NextResponse.json({ ready, workflows: [] });
    return NextResponse.json({ ready, workflows: await listWorkflows(auth) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/workflows — start a workflow on one of the user's projects. Every agent it uses must be
 * available to the user (plan and configuration). Nothing runs until the page asks for the first advance.
 */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, workflowInput, 260_000);
    const auth = await codeContext("workflows", 6);
    return NextResponse.json({ workflow: toWorkflowView(await createWorkflow(auth, input)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
