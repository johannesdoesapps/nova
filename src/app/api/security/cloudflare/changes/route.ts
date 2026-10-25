import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { guard } from "@/lib/bastion/server";
import { ConnectorError } from "@/lib/connectors/http";
import { audit, getFinding, updateFinding } from "@/lib/db/security";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { CF_CHANGES, listZones, readSetting, writeSetting } from "@/lib/security/cloudflare-audit";
import { requireService, serviceState } from "@/lib/security/connections";

/**
 * Approval-gated Cloudflare fixes. GET shows the proposal for a finding (live current value, the new value, impact,
 * how to undo it). POST applies it only with { confirm: true } and the current value the person saw: if the setting
 * changed since, nothing is written. After writing, the setting is read back; the finding becomes "fixed — awaiting
 * verification" and is marked verified only when a re-check no longer finds it.
 */

async function proposalFor(req: Request, id: string) {
  const auth = await requireUser();
  const { finding } = await getFinding(auth.supabase, auth.user.id, id);
  const change = CF_CHANGES[finding.rule_id];
  if (!change || !finding.asset.startsWith("cloudflare:")) throw new ApiError("bad_request", "Orbis doesn't offer an automatic change for this finding. Follow the remediation steps in Cloudflare.");
  const zoneName = finding.asset.slice("cloudflare:".length);
  const { ctx, row } = await requireService(auth, "cloudflare", req.signal);
  const zone = (await listZones(ctx)).find((z) => z.name === zoneName);
  if (!zone) throw new ApiError("not_found", `The connected token can't see ${zoneName} any more.`);
  const current = await readSetting(ctx, zone.id, change.setting);
  return { auth, finding, change, zone, ctx, row, current };
}

const wrap = (err: unknown) => (err instanceof ConnectorError ? new ApiError(err.kind === "auth" || err.kind === "permission" ? "forbidden" : "upstream_error", err.kind === "permission" ? "The token doesn't have permission for this. Add Zone Settings: Edit to it (and replace the token) to apply changes." : err.message) : err);

export async function GET(req: Request) {
  try {
    const id = requireUuid(new URL(req.url).searchParams.get("findingId") ?? "");
    const p = await proposalFor(req, id).catch((err) => {
      throw wrap(err);
    });
    const state = await serviceState(p.auth, "cloudflare", [p.row]);
    return NextResponse.json({
      proposal: {
        zone: p.zone.name,
        setting: p.change.setting,
        label: p.change.label,
        current: p.current,
        proposed: p.change.value,
        needed: p.change.from.includes(p.current),
        impact: p.change.impact,
        rollback: `To undo, set ${p.change.setting} back to "${p.current}" in Cloudflare (SSL/TLS settings for ${p.zone.name}). The old value is kept in this finding's history.`,
        canApply: state.writeEnabled && state.scopes.includes("zone_settings:edit"),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({ findingId: z.uuid(), confirm: z.literal(true), expectCurrent: z.string().min(1).max(20) });

export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, body, 500);
    const p = await proposalFor(req, input.findingId).catch((err) => {
      throw wrap(err);
    });
    if (!p.row.write_enabled || !p.row.scopes.includes("zone_settings:edit")) throw new ApiError("forbidden", "Changes are off for your Cloudflare connection. Replace the token with one that has Zone Settings: Edit and tick “Orbis may use that for changes I approve”.");
    if (p.current !== input.expectCurrent) throw new ApiError("conflict", `The setting changed since you reviewed it (it's now "${p.current}"). Nothing was changed; review the proposal again.`);
    if (!p.change.from.includes(p.current)) throw new ApiError("bad_request", `${p.change.setting} is already "${p.current}"; there's nothing to change. Run a re-check to update the finding.`);
    const d = await guard({ db: p.auth.supabase, userId: p.auth.user.id, kind: "user", agent: "security" }, "connector.write", `cloudflare ${p.zone.name} ${p.change.setting}=${p.change.value}`, { approved: true });
    if (d.outcome !== "allow") throw new ApiError("forbidden", `Blocked by Orbis Bastion: ${d.reason}`);

    const detail = { zone: p.zone.name, setting: p.change.setting, before: p.current, after: p.change.value, rollback: { setting: p.change.setting, value: p.current } };
    try {
      await writeSetting(p.ctx, p.zone.id, p.change.setting, p.change.value);
    } catch (err) {
      await audit(p.auth.supabase, p.auth.user.id, "cloudflare.change_failed", { findingId: p.finding.id, detail: { ...detail, error: err instanceof ConnectorError ? err.message.slice(0, 200) : "failed" } });
      throw wrap(err);
    }
    // Read it back: the change counts only if Cloudflare now reports the new value.
    const now = await readSetting(p.ctx, p.zone.id, p.change.setting).catch(() => null);
    const applied = now === p.change.value;
    await audit(p.auth.supabase, p.auth.user.id, applied ? "cloudflare.change_applied" : "cloudflare.change_unconfirmed", { findingId: p.finding.id, detail: { ...detail, readBack: now } });
    if (applied)
      await updateFinding(p.auth.supabase, p.auth.user.id, p.finding.id, {
        status: "fixed",
        verification_note: `Changed ${p.change.setting} from "${p.current}" to "${p.change.value}" with your approval; Cloudflare reports the new value. Run a re-check to confirm the finding is gone.`,
      });
    return NextResponse.json({ ok: applied, readBack: now, rollback: detail.rollback });
  } catch (err) {
    return errorResponse(err);
  }
}
