import { NextResponse } from "next/server";
import { z } from "zod";
import { actionInProgressOrDone, type ProposedAction } from "@/lib/connectors/router";
import { runAction } from "@/lib/connectors/runtime";
import { connectorUser } from "@/lib/connectors/server";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
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
    const card = input.messageId && input.proposalId ? { messageId: input.messageId, proposalId: input.proposalId } : null;
    const save = async (patch: (a: ProposedAction) => ProposedAction) => {
      if (!card) return;
      const { data } = await auth.supabase.from("messages").select("usage_metadata").eq("id", card.messageId).maybeSingle();
      const meta = (data?.usage_metadata ?? null) as { actions?: ProposedAction[] } | null;
      if (!meta?.actions?.some((a) => a.id === card.proposalId)) return;
      const actions = meta.actions.map((a) => (a.id === card.proposalId ? patch(a) : a));
      const { error } = await auth.supabase.from("messages").update({ usage_metadata: { ...meta, actions } }).eq("id", card.messageId);
      if (error) reportError(error, { where: "connectors.actions.mark" });
    };
    if (card) {
      // A proposal runs once: a second confirm (double click, a retried request) is refused while it runs or after it's done.
      const { data } = await auth.supabase.from("messages").select("usage_metadata").eq("id", card.messageId).maybeSingle();
      const prior = ((data?.usage_metadata ?? null) as { actions?: ProposedAction[] } | null)?.actions?.find((a) => a.id === card.proposalId);
      if (prior && actionInProgressOrDone(prior, Date.now())) throw new ApiError("conflict", prior.status === "done" ? "This action has already been done." : "This action is already running. Wait for it to finish.");
      await save((a) => ({ ...a, startedAt: new Date().toISOString() }));
    }
    const outcome = await runAction(auth, input.action, input.args);
    // Keep the card's state with the saved reply, so it isn't offered again after a reload.
    await save((a) => ({ ...a, startedAt: undefined, args: input.args, status: outcome.ok ? "done" : "failed", result: { summary: outcome.summary, url: outcome.url ?? null } }));
    return NextResponse.json(outcome, { status: outcome.ok ? 200 : 502 });
  } catch (err) {
    return errorResponse(err);
  }
}
