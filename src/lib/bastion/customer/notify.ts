import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSecurityEmail } from "../../email";
import { loadWorkspacePolicy } from "../controls";
import { recordSigned } from "../server";
import type { CustomerPolicy } from "./policy";
import type { WorkspaceCtx } from "./workspace";

export type NoticeKind = keyof Omit<CustomerPolicy["notifications"], "email" | "blockThreshold">;

/**
 * A security notice for a workspace's owner: always kept in the workspace's records (shown on the Bastion page),
 * and emailed when the workspace's notification settings allow it. Sent at most once per key. Wording says what
 * was detected; it never calls something a confirmed incident.
 */
export async function notifyOwner(db: SupabaseClient, ownerId: string, kind: NoticeKind, key: string, subject: string, text: string, actor: string | null = null): Promise<void> {
  const ws = await loadWorkspacePolicy(db, ownerId);
  const prefs = ws === "unavailable" ? null : ws.current.policy.notifications;
  const emailed = prefs && prefs.email && prefs[kind] ? await sendSecurityEmail(ownerId, `bastion_${kind}`, key, subject, text) : false;
  await recordSigned(db, ownerId, "bastion.notice", { kind, key: key.slice(0, 80), subject: subject.slice(0, 160), text: text.slice(0, 600), emailed, actor });
}

export const notifySecurity = (ctx: WorkspaceCtx, kind: NoticeKind, key: string, subject: string, text: string) => notifyOwner(ctx.db, ctx.ownerId, kind, key, subject, text, ctx.actorId);
