import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { recordAdminAction } from "@/lib/admin-audit";
import { getAuth } from "@/lib/auth";
import { CAPABILITIES, DEFAULT_CONTROLS, describeChange, HISTORY_LIMIT, parseControls, RISKS, snapshotOf, validateControls, type BastionControls, type Capability } from "@/lib/bastion/policy";
import { planTiersSchema } from "@/lib/bastion/customer/tiers";
import { enforce, invalidateControls } from "@/lib/bastion/server";
import { bastionMac } from "@/lib/bastion/controls";
import { integrityOf, type AuditRow } from "@/lib/bastion/customer/records";
import { summarise, type DecisionEvent } from "@/lib/bastion/view";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { serviceSupabase } from "@/lib/supabase/admin";

const body = z
  .object({
    /** The version the administrator was looking at: a change made meanwhile isn't silently overwritten. */
    expectedVersion: z.number().int().min(0),
    lockdown: z.boolean(),
    suspendedAgents: z.array(z.string().regex(/^[a-z_]{2,40}$/)).max(40),
    blockedCapabilities: z.array(z.enum(Object.keys(CAPABILITIES) as [Capability, ...Capability[]])).max(20),
    riskOverrides: z.record(z.string(), z.enum(RISKS)),
    planTiers: planTiersSchema.optional(),
    note: z.string().trim().max(200).optional(),
    /** Changing policy is critical: the administrator confirms it explicitly. */
    confirm: z.literal(true),
  })
  .strict();

async function stored(auth: Awaited<ReturnType<typeof requireAdmin>>) {
  const { data, error } = await auth.supabase.from("app_settings").select("settings").eq("id", 1).maybeSingle();
  if (error || !data) throw new ApiError("internal", "Couldn't read the platform settings.");
  const raw = ((data as { settings: unknown }).settings ?? {}) as Record<string, unknown>;
  const controls = parseControls(raw.bastion);
  const brokenVersion = typeof (raw.bastion as { version?: unknown } | undefined)?.version === "number" ? ((raw.bastion as { version: number }).version as number) : 0;
  return { raw, controls, version: controls?.version ?? brokenVersion };
}

/**
 * Only decisions Orbis itself recorded: users can add rows to their own audit trail, so an unsigned row could be
 * used to flood this view. (Without a signing key nothing is signed, and every row is shown.)
 */
function signedOnly<T extends AuditRow>(rows: T[]): T[] {
  if (!bastionMac("probe")) return rows;
  return rows.filter((r) => !!r.user_id && integrityOf(bastionMac, r.user_id, r) === "signed");
}

/** GET /api/admin/bastion — the stored controls with their history, and decisions across all users (administrators only). */
export async function GET() {
  try {
    const auth = await requireAdmin(await getAuth());
    const { controls, version } = await stored(auth);
    const svc = serviceSupabase();
    const { data } = await (svc ?? auth.supabase).from("security_audit").select("user_id,action,detail,created_at").like("action", "bastion.%").order("created_at", { ascending: false }).limit(2000);
    return NextResponse.json(
      { controls, valid: !!controls, version, summary: summarise(signedOnly((data ?? []) as (DecisionEvent & AuditRow)[]), 100), scope: svc ? "all_users" : "own" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/** PUT /api/admin/bastion — activate a new version of the controls (validated first; the previous version is kept in the history). */
export async function PUT(req: Request) {
  try {
    const auth = await requireAdmin(await getAuth());
    const input = await parseJsonBody(req, body, 20_000);
    const { raw, controls, version } = await stored(auth);
    if (input.expectedVersion !== version) throw new ApiError("conflict", "Someone changed Bastion's controls meanwhile. Reload to see the current version.");
    const prev = controls ?? DEFAULT_CONTROLS;
    const snapshot = {
      lockdown: input.lockdown,
      suspendedAgents: [...new Set(input.suspendedAgents)],
      blockedCapabilities: [...new Set(input.blockedCapabilities)],
      riskOverrides: input.riskOverrides,
      ...(input.planTiers ? { planTiers: input.planTiers } : {}),
    };
    const summary = describeChange(snapshotOf(prev), snapshot);
    const now = new Date().toISOString();
    const next: BastionControls = {
      ...snapshot,
      version: version + 1,
      updatedAt: now,
      history: [
        { version: prev.version, at: prev.updatedAt, summary: `${input.note ? `${input.note} — ` : ""}replaced by v${version + 1}: ${summary}`.slice(0, 300), snapshot: snapshotOf(prev) },
        ...prev.history,
      ].slice(0, HISTORY_LIMIT),
    };
    const problem = validateControls(next);
    if (problem) throw new ApiError("bad_request", problem);
    // The change itself goes through Bastion: only a person can make it, and only with explicit confirmation.
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "user", agent: "administrator" }, "policy.modify", `bastion v${version + 1}: ${summary}`, { approved: input.confirm });
    const { data: saved, error } = await auth.supabase
      .from("app_settings")
      .update({ settings: { ...raw, bastion: next }, updated_by: auth.user.id })
      .eq("id", 1)
      .select("id");
    if (error || !saved?.length) throw new ApiError("internal", "The change couldn't be saved.");
    invalidateControls();
    await recordAdminAction(auth.supabase, "bastion.update", `v${next.version}`, { summary, note: input.note ?? null });
    return NextResponse.json({ controls: next, valid: true, version: next.version });
  } catch (err) {
    return errorResponse(err);
  }
}
