import { NextResponse } from "next/server";
import { startDelegatedWithAssignment } from "@/lib/agent-platform/delegate-server";
import type { TaskAssignment } from "@/lib/agent-platform/protocol";
import { startDelegated, type TaskProposal } from "@/lib/agent-platform/delegation";
import { codeContext } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";

// Starting a review fetches the code and runs the rule and dependency checks first.
export const maxDuration = 60;

/**
 * POST /api/agent-platform/delegate — start a task the Orbis Agent proposed in chat, after the user
 * reviewed it and pressed Start. Signed-in users only; access, input and project ownership are checked
 * again here. The card's outcome is kept with the saved reply so it isn't offered again after a reload.
 */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, startDelegated, 260_000);
    const auth = await codeContext("agent-delegate", 10);
    let outcome: { ok: boolean; summary: string; href: string | null };
    let assignment: TaskAssignment | null = null;
    let failure: unknown = null;
    try {
      const r = await startDelegatedWithAssignment(req, auth, input.agent, input.projectId ?? null, input.input);
      outcome = { ok: true, summary: r.summary, href: r.href };
      assignment = r.assignment;
    } catch (err) {
      failure = err;
      outcome = { ok: false, summary: err instanceof ApiError ? err.message : "The task couldn't be started.", href: null };
    }
    if (input.messageId && input.proposalId) {
      const { data } = await auth.supabase.from("messages").select("usage_metadata").eq("id", input.messageId).maybeSingle();
      const meta = (data?.usage_metadata ?? null) as { tasks?: TaskProposal[] } | null;
      if (meta?.tasks?.some((t) => t.id === input.proposalId)) {
        const tasks = meta.tasks.map((t) =>
          t.id === input.proposalId
            ? {
                ...t,
                projectId: input.projectId ?? null,
                input: input.input,
                status: outcome.ok ? ("started" as const) : ("failed" as const),
                result: { summary: outcome.summary, href: outcome.href },
                ...(assignment ? { assignment } : {}),
              }
            : t,
        );
        const { error } = await auth.supabase
          .from("messages")
          .update({ usage_metadata: { ...meta, tasks } })
          .eq("id", input.messageId);
        if (error) reportError(error, { where: "agent.delegate.mark" });
      }
    }
    if (failure) throw failure;
    return NextResponse.json(outcome, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
