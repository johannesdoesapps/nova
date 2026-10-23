import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Team plan helpers. A team is one Stripe subscription whose quantity is the number of seats; every member gets
 * the team's plan (Pro or Max) with their own allowance. Membership changes go through the database functions in
 * supabase/migrations/20261029000000_teams.sql, which check roles, seats and the invited email address.
 */

export const TEAM_MIN_SEATS = 2;
export const TEAM_MAX_SEATS = 150;

export interface TeamRow {
  id: string;
  name: string;
  owner_id: string;
  plan: "pro" | "max";
  billing_interval: "month" | "year";
  seats: number;
  status: string;
  price_usd: number | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  disputed: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

/** A new invite code (sent to the invitee) and the hash that's stored. */
export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The caller's team, if they're in one. */
export async function myTeam(db: SupabaseClient, userId: string): Promise<TeamRow | null> {
  const { data: m } = await db.from("team_members").select("team_id").eq("user_id", userId).maybeSingle();
  if (!m?.team_id) return null;
  const { data } = await db.from("teams").select("*").eq("id", m.team_id).maybeSingle();
  return (data as TeamRow | null) ?? null;
}

/** Postgres errors from the team functions carry a sentence meant for people; anything else gets a generic one. */
export function teamErrorMessage(err: { message?: string; code?: string } | null, fallback: string): string {
  const m = err?.message ?? "";
  return /^(You|That|This|The|All|Only|Invalid|Not signed)/.test(m) ? m.replace(/\.$/, "") + "." : fallback;
}
