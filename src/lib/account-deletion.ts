import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "@/lib/http";

/**
 * Deleting an Orbis account, by the account's owner (Settings → Delete account).
 *
 * Almost every table that refers to a user deletes its rows with the user or clears the reference (checked in
 * tests/account-deletion-db.test.ts), so deleting the sign-in user removes the account's data in one step. What
 * doesn't follow on its own is dealt with first: each project's computer and saved disk, each published site (nobody
 * could take it down once the account is gone), and the tables that aren't linked to the user (UNLINKED_TABLES).
 * Payment records Orbis must keep (billing ledger, disputes) stay, without the link to the person.
 *
 * Refused while it would leave something charging or other people relying on the account: a plan that will renew
 * (checked in Orbis and, where billing is set up, at Stripe), a team with other members or a team plan that renews,
 * or an administrator account.
 */

export interface DeletionBlocker {
  kind: "subscription" | "team" | "admin";
  message: string;
}

/** Plans that will charge again, unless set to end. */
const RENEWING = ["active", "trialing", "past_due", "incomplete", "unpaid"];
/** Plans with a payment still being collected: Stripe retries the open invoice even when the plan is set to end. */
const COLLECTING = ["past_due", "unpaid", "incomplete"];

const willCharge = (status: string, cancelAtPeriodEnd: boolean) => COLLECTING.includes(status) || (RENEWING.includes(status) && !cancelAtPeriodEnd);

/** Tables keyed by the user without a foreign key to them: deleted explicitly, before the sign-in user. */
export const UNLINKED_TABLES = ["mimic_runs", "mimic_workflows", "mimic_ledger", "mimic_rules", "mimic_documents", "mimic_events", "mimic_settings"];

/** A Stripe customer's subscriptions, as far as deletion needs them (null when billing isn't set up here). */
export type StripeSubscriptions = (customerId: string) => Promise<{ id: string; status: string; cancel_at_period_end: boolean }[]>;

/** Why the account can't be deleted yet; empty when it can. Read with the user's own session (row-level security). */
export async function deletionBlockers(db: SupabaseClient, userId: string, stripeSubs: StripeSubscriptions | null = null): Promise<DeletionBlocker[]> {
  const blockers: DeletionBlocker[] = [];
  const [{ data: sub }, { data: teams }, { data: admin }] = await Promise.all([
    db.from("subscriptions").select("status, cancel_at_period_end, stripe_subscription_id, stripe_customer_id").eq("user_id", userId).maybeSingle(),
    db.from("teams").select("id, name, status, cancel_at_period_end, stripe_subscription_id, stripe_customer_id").eq("owner_id", userId),
    db.from("admins").select("user_id").eq("user_id", userId).maybeSingle(),
  ]);
  if (admin) blockers.push({ kind: "admin", message: "This is an administrator account. Ask another administrator to remove your admin role first." });
  if (sub && sub.stripe_subscription_id && willCharge(sub.status as string, !!sub.cancel_at_period_end)) {
    blockers.push({ kind: "subscription", message: "Your plan renews automatically or has a payment due. Cancel it in Billing first, so you aren't charged again." });
  }
  const ownTeams = (teams ?? []) as { id: string; name: string; status: string; cancel_at_period_end: boolean; stripe_subscription_id: string | null; stripe_customer_id: string | null }[];
  for (const t of ownTeams) {
    if (t.stripe_subscription_id && willCharge(t.status, t.cancel_at_period_end)) {
      blockers.push({ kind: "team", message: `Your team "${t.name}" has a plan that renews or has a payment due. Cancel it in Billing first.` });
      continue;
    }
    const { count } = await db.from("team_members").select("user_id", { count: "exact", head: true }).eq("team_id", t.id).neq("user_id", userId);
    if ((count ?? 0) > 0) blockers.push({ kind: "team", message: `Your team "${t.name}" still has other members. Remove them first.` });
  }
  // Orbis's copy of a plan can lag behind Stripe (a missed event, a checkout paid in another tab): ask Stripe too.
  if (stripeSubs && !blockers.some((b) => b.kind === "subscription")) {
    const customers = [...new Set([sub?.stripe_customer_id as string | null | undefined, ...ownTeams.map((t) => t.stripe_customer_id)].filter((c): c is string => !!c))];
    for (const c of customers) {
      let live;
      try {
        live = await stripeSubs(c);
      } catch {
        throw new ApiError("upstream_error", "Your billing couldn't be checked right now, so nothing was deleted. Please try again in a few minutes.");
      }
      if (live.some((s) => willCharge(s.status, s.cancel_at_period_end))) {
        blockers.push({ kind: "subscription", message: "A plan on your account renews automatically or has a payment due. Cancel it in Billing first, so you aren't charged again." });
        break;
      }
    }
  }
  return blockers;
}

export interface DeletionDeps {
  /** The user's own session. */
  db: SupabaseClient;
  /** Service-role client: only it can delete the sign-in user. */
  admin: SupabaseClient;
  userId: string;
  /** Stop a project's computer and delete its saved disk. */
  stopComputer: (projectId: string) => Promise<void>;
  /** Take a project's published site down (false if none); null when publishing isn't set up here. */
  takeDownSite: ((projectId: string) => Promise<boolean>) | null;
  stripeSubs?: StripeSubscriptions | null;
}

export interface DeletionResult {
  projects: number;
  sitesRemoved: number;
}

const PAGE = 500;
const PARALLEL = 4;

async function allProjectIds(db: SupabaseClient, userId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("code_projects").select("id").eq("user_id", userId).order("id").range(from, from + PAGE - 1);
    if (error) throw new ApiError("internal", "Your projects couldn't be read, so nothing was deleted. Please try again.");
    const page = ((data ?? []) as { id: string }[]).map((p) => p.id);
    ids.push(...page);
    if (page.length < PAGE) return ids;
  }
}

/** Run fn over items, a few at a time. */
async function eachLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

export async function deleteAccount(d: DeletionDeps): Promise<DeletionResult> {
  const blockers = await deletionBlockers(d.db, d.userId, d.stripeSubs ?? null);
  if (blockers.length) throw new ApiError("conflict", blockers.map((b) => b.message).join(" "));

  const ids = await allProjectIds(d.db, d.userId);

  // Outside the database first. A site that can't be taken down stops the deletion before the account goes:
  // otherwise it would stay online with nobody able to remove it.
  let sitesRemoved = 0;
  let siteFailed = false;
  await eachLimited(ids, async (id) => {
    await d.stopComputer(id).catch(() => undefined);
    if (!d.takeDownSite) return;
    try {
      if (await d.takeDownSite(id)) sitesRemoved++;
    } catch {
      siteFailed = true;
    }
  });
  if (siteFailed) {
    throw new ApiError("upstream_error", `One of your published sites couldn't be taken down, so your account wasn't deleted.${sitesRemoved ? ` ${sitesRemoved} other site${sitesRemoved === 1 ? " was" : "s were"} already taken offline.` : ""} Please try again in a few minutes.`);
  }

  // Anything that changed while sites were taken down (a plan bought, a member joined) still stops it.
  const late = await deletionBlockers(d.db, d.userId, d.stripeSubs ?? null);
  if (late.length) throw new ApiError("conflict", late.map((b) => b.message).join(" "));

  for (const t of UNLINKED_TABLES) {
    const { error } = await d.db.from(t).delete().eq("user_id", d.userId);
    if (error) throw new ApiError("internal", "Part of your data couldn't be deleted, so your account wasn't deleted. Please try again, or email support.");
  }

  const { error: delError } = await d.admin.auth.admin.deleteUser(d.userId);
  if (delError) throw new ApiError("internal", "Your account couldn't be deleted. Please try again, or email support.");
  return { projects: ids.length, sitesRemoved };
}
