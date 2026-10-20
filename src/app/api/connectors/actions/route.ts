import { NextResponse } from "next/server";
import { z } from "zod";
import type { ProposedAction } from "@/lib/connectors/router";
import { runAction } from "@/lib/connectors/runtime";
import { connectorUser } from "@/lib/connectors/server";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";

const body = z.object({
  action: z.string().regex(/^[a-z_]{3,60}$/),
  args: z.record(z.string(), z.unknown()),
  /** The user pressed Confirm on the review card. */
  confirm: z.literal(true),
  /** Where the proposal came from, to mark it done there. */
  messageId: z.string().uuid().optional(),
  proposalId: z.string().uuid().optional(),
});

/**
 * POST /api/connectors/actions — run a write action the user reviewed and
 * confirmed (a draft, an event, a message, an issue). Checked again here:
 * the connection must have write access turned on and the permission
 * granted, and the (possibly edited) details must be valid.
 */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, body, 60_000);
    const auth = await connectorUser("connectors-actions", 10);
    const outcome = await runAction(auth, input.action, input.args);
    if (input.messageId && input.proposalId) {
      // Keep the card's state with the saved reply, so it isn't offered again after a reload.
      const { data } = await auth.supabase.from("messages").select("usage_metadata").eq("id", input.messageId).maybeSingle();
      const meta = (data?.usage_metadata ?? null) as { actions?: ProposedAction[] } | null;
      if (meta?.actions?.some((a) => a.id === input.proposalId)) {
        const actions = meta.actions.map((a) => (a.id === input.proposalId ? { ...a, args: input.args, status: outcome.ok ? "done" : "failed", result: { summary: outcome.summary, url: outcome.url ?? null } } : a));
        const { error } = await auth.supabase.from("messages").update({ usage_metadata: { ...meta, actions } }).eq("id", input.messageId);
        if (error) reportError(error, { where: "connectors.actions.mark" });
      }
    }
    return NextResponse.json(outcome, { status: outcome.ok ? 200 : 502 });
  } catch (err) {
    return errorResponse(err);
  }
}
