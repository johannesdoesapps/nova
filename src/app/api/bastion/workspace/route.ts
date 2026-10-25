import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { invalidateWorkspacePolicy, loadWorkspacePolicy } from "@/lib/bastion/controls";
import { assessProject } from "@/lib/bastion/customer/assess";
import { runChecks } from "@/lib/bastion/customer/checks";
import { summaryOf, WORKFLOW_ACTIONS } from "@/lib/bastion/customer/findings";
import { APP_MODES } from "@/lib/bastion/customer/gate";
import { notifySecurity } from "@/lib/bastion/customer/notify";
import { customerPolicySchema, CUSTOM_CAPS, DEFAULT_CUSTOMER_POLICY, describePolicyChange, policyImpact, validateCustomerPolicy, type CustomerPolicy } from "@/lib/bastion/customer/policy";
import { ASSIGNABLE_ROLES } from "@/lib/bastion/customer/roles";
import { auditRows, loadWorkspace, recordEvent, requireFeature, requirePermission, resolveWorkspace, workspaceState, type WorkspaceCtx } from "@/lib/bastion/customer/workspace";
import { AGENTS } from "@/lib/agent-platform/registry";
import { builtinAgents } from "@/lib/agents/builtins";
import { forgetConnection } from "@/lib/connectors/runtime";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";

export const maxDuration = 60;

const uuid = z.string().uuid();
const workspace = z.string().uuid().nullable().optional();

const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run_checks"), workspace }),
  z.object({ kind: z.literal("assess_app"), workspace, projectId: uuid, mode: z.enum(APP_MODES), findingIds: z.array(uuid).max(50).optional() }),
  z.object({
    kind: z.literal("finding"),
    workspace,
    findingId: z.string().regex(/^(BW-[0-9A-F]{8}|[0-9a-f-]{36})$/),
    action: z.enum(WORKFLOW_ACTIONS),
    owner: z.string().trim().max(120).nullable().optional(),
    note: z.string().trim().max(1000).optional(),
    until: z.string().date().optional(),
  }),
  z.object({ kind: z.literal("policy"), workspace, policy: customerPolicySchema, expectedVersion: z.number().int().min(0), note: z.string().trim().max(200).optional(), confirm: z.boolean() }),
  z.object({
    kind: z.literal("agent"),
    workspace,
    ref: z.string().max(80),
    action: z.enum(["pause", "resume", "limit"]),
    removeTools: z.array(z.enum(CUSTOM_CAPS)).max(4).optional(),
    confirm: z.boolean(),
  }),
  z.object({ kind: z.literal("revoke_integration"), workspace, connectorId: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), confirm: z.literal(true) }),
  z.object({ kind: z.literal("role"), workspace, userId: uuid, role: z.enum(ASSIGNABLE_ROLES).nullable(), confirm: z.literal(true) }),
  z.object({ kind: z.literal("access_review"), workspace, note: z.string().trim().max(500).optional() }),
]);

/** GET /api/bastion/workspace?workspace=<owner id> — the workspace's security state (scoped to it; role-checked). */
export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    const ctx = await resolveWorkspace(auth, new URL(req.url).searchParams.get("workspace"));
    requirePermission(ctx, "view");
    return NextResponse.json(await workspaceState(ctx, auth), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/bastion/workspace — an action in a workspace: run the checks, assess a project, work a finding,
 * change the policy, pause or limit an agent, revoke a connected service, give a role, record an access review.
 * Each is authorised here (role, plan, ownership), recorded with a correlation id, and — where it changes what
 * agents may do — previewed first (`confirm: false` returns the impact without changing anything).
 */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    if (!limiter("bastion-ws", 40, 60_000).check(`u:${auth.user.id}`, 1).ok) throw new ApiError("rate_limited", "Too many Bastion actions in a minute. Please wait a moment.");
    const b = await parseJsonBody(req, body, 30_000);
    const ctx = await resolveWorkspace(auth, b.workspace ?? null);

    switch (b.kind) {
      case "run_checks": {
        requirePermission(ctx, "assess");
        requireFeature(ctx, "workspace_checks");
        const { snapshot } = await loadWorkspace(ctx);
        const { findings, checks } = runChecks(snapshot);
        const prev = (await auditRows(ctx, { actions: ["bastion.assessment"], limit: 30 })).find((r) => r.integrity === "signed" && r.detail.mode === "workspace");
        const before = new Set(Array.isArray(prev?.detail.present) ? (prev!.detail.present as { id: string }[]).map((p) => p.id) : []);
        const ran = checks.filter((c) => c.state !== "unavailable").map((c) => c.id);
        await recordEvent(ctx, "bastion.assessment", {
          mode: "workspace",
          present: findings.slice(0, 40).map(summaryOf),
          checked: ran,
          unavailable: checks.filter((c) => c.state === "unavailable").map((c) => c.id),
        });
        const fresh = findings.filter((f) => !before.has(f.id));
        for (const f of fresh.filter((x) => x.checkId === "agents.secret-in-instructions"))
          await notifySecurity(ctx, "credentialExposure", `ws:${f.id}`, "Possible credential in an agent's instructions", `${f.title}. Remove it and rotate the credential if it's real.`);
        for (const f of fresh.filter((x) => x.severity === "critical")) await notifySecurity(ctx, "critical", `ws:${f.id}`, `Critical finding: ${f.title}`.slice(0, 120), f.description);
        for (const c of snapshot.connectors.filter((x) => x.writeEnabled && Date.now() - Date.parse(x.connectedAt) < 7 * 86_400_000))
          await notifySecurity(
            ctx,
            "riskyIntegrations",
            `int:${c.connectorId}:${c.connectedAt.slice(0, 10)}`,
            `${c.name} was connected with write access`,
            `${c.name} can now be used to create or send things (each action still needs your confirmation). If you didn't connect it, disconnect it in Bastion → Agents.`,
          );
        return NextResponse.json({ ok: true, found: findings.length, new: fresh.length, checks });
      }

      case "assess_app": {
        requirePermission(ctx, "assess");
        requireFeature(ctx, b.mode === "quick" ? "quick_check" : b.mode === "deep" ? "deep_assessment" : b.mode === "gate" ? "deploy_gate" : "recheck");
        if (!limiter("bastion-assess", 6, 10 * 60_000).check(`u:${ctx.actorId}`, 1).ok) throw new ApiError("rate_limited", "At most 6 assessments per 10 minutes.");
        return NextResponse.json(await assessProject(ctx, b.projectId, b.mode, { findingIds: b.findingIds, signal: req.signal }));
      }

      case "finding": {
        const manage = ["assign", "suppress", "unsuppress", "reopen"].includes(b.action);
        requirePermission(ctx, manage ? "findings_manage" : "findings_triage");
        if (b.action !== "acknowledge" && b.action !== "resolve_requested") requireFeature(ctx, "finding_workflow");
        await assertFindingInWorkspace(ctx, b.findingId);
        if (b.action === "suppress") {
          if (!b.note || b.note.length < 10) throw new ApiError("bad_request", "Say why it's suppressed (at least 10 characters).");
          if (b.until && (Date.parse(b.until) - Date.now()) / 86_400_000 > 366) throw new ApiError("bad_request", "Suppress for at most a year; review it again after that.");
        }
        await recordEvent(ctx, "bastion.finding", { findingId: b.findingId, action: b.action, owner: b.owner ?? null, note: b.note ?? null, until: b.until ?? null });
        return NextResponse.json({
          ok: true,
          note: b.action === "resolve_requested" ? "Recorded. It stays open until a re-check no longer finds it — run the checks (or a targeted recheck) after the fix." : "Recorded.",
        });
      }

      case "policy": {
        requirePermission(ctx, "policies_manage");
        requireFeature(ctx, "policies");
        if (b.policy.retentionDays !== null) requireFeature(ctx, "retention");
        return NextResponse.json(await writePolicy(ctx, () => b.policy, { expectedVersion: b.expectedVersion, note: b.note ?? null, confirm: b.confirm }));
      }

      case "agent": {
        requirePermission(ctx, "agents_manage");
        requireFeature(ctx, b.action === "limit" ? "policies" : "pause_agents");
        const current = await currentPolicy(ctx);
        return NextResponse.json(
          await writePolicy(
            ctx,
            (p) => {
              if (b.action === "pause") return { ...p, pausedAgents: [...new Set([...p.pausedAgents, b.ref])] };
              if (b.action === "resume") return { ...p, pausedAgents: p.pausedAgents.filter((r) => r !== b.ref) };
              if (!b.ref.startsWith("custom:")) throw new ApiError("bad_request", "Tools can be removed from your own custom agents only.");
              const limits = { ...p.customAgentLimits };
              if (b.removeTools?.length) limits[b.ref] = b.removeTools;
              else delete limits[b.ref];
              return { ...p, customAgentLimits: limits };
            },
            { expectedVersion: current.version, note: `${b.action} ${b.ref}`, confirm: b.confirm },
          ),
        );
      }

      case "revoke_integration": {
        requirePermission(ctx, "integrations_revoke");
        if (ctx.shared) throw new ApiError("forbidden", "Only the workspace owner can revoke a connected service.");
        const { data: before } = await auth.supabase.from("connector_accounts").select("status").eq("user_id", ctx.ownerId).eq("connector_id", b.connectorId).maybeSingle();
        if (!before) throw new ApiError("not_found", "That service isn't connected.");
        await forgetConnection(auth, b.connectorId);
        // Confirm it really happened before saying so.
        const { data: after } = await auth.supabase.from("connector_accounts").select("status,secret").eq("user_id", ctx.ownerId).eq("connector_id", b.connectorId).maybeSingle();
        const confirmed = (after as { status: string; secret: string | null } | null)?.status === "disconnected" && !(after as { secret: string | null }).secret;
        await recordEvent(ctx, "bastion.integration", { connectorId: b.connectorId, action: "revoke", outcome: confirmed ? "confirmed" : "unconfirmed" });
        if (!confirmed) throw new ApiError("upstream_error", "The disconnection couldn't be confirmed. Check the Connectors page.");
        return NextResponse.json({
          ok: true,
          confirmed,
          note: "Disconnected: Orbis deleted its stored sign-in. To revoke Orbis's access on the service's side too, remove it in that service's security settings.",
        });
      }

      case "role": {
        requirePermission(ctx, "roles_manage");
        requireFeature(ctx, "roles");
        if (b.userId === ctx.ownerId) throw new ApiError("bad_request", "You're the owner of this workspace.");
        // Row-level security only lets the owner write grants, and only for someone in the owner's team.
        const q = b.role
          ? auth.supabase.from("bastion_workspace_roles").upsert({ owner_id: ctx.ownerId, user_id: b.userId, role: b.role }, { onConflict: "owner_id,user_id" }).select("role")
          : auth.supabase.from("bastion_workspace_roles").delete().eq("owner_id", ctx.ownerId).eq("user_id", b.userId).select("role");
        const { data, error } = await q;
        if (error)
          throw new ApiError(
            /does not exist|schema cache/i.test(error.message) ? "not_configured" : "forbidden",
            /does not exist|schema cache/i.test(error.message) ? "Workspace roles aren't set up on this server yet (a database update is pending)." : "That person isn't in your team.",
          );
        if (b.role && !data?.length) throw new ApiError("forbidden", "That person isn't in your team.");
        await recordEvent(ctx, "bastion.role", { userId: b.userId, role: b.role });
        return NextResponse.json({ ok: true });
      }

      case "access_review": {
        requirePermission(ctx, "access_review");
        const { snapshot } = await loadWorkspace(ctx);
        await recordEvent(ctx, "bastion.access_review", { members: snapshot.team?.members.length ?? 0, grants: snapshot.team?.grants?.length ?? 0, note: b.note ?? null });
        return NextResponse.json({ ok: true });
      }
    }
  } catch (err) {
    return errorResponse(err);
  }
}

async function currentPolicy(ctx: WorkspaceCtx) {
  invalidateWorkspacePolicy(ctx.ownerId);
  const ws = await loadWorkspacePolicy(ctx.db, ctx.ownerId);
  if (ws === "unavailable") throw new ApiError("internal", "The workspace's policy couldn't be read.");
  return ws.current;
}

/** Validate, preview (confirm=false) or activate a new policy version. */
async function writePolicy(ctx: WorkspaceCtx, change: (p: CustomerPolicy) => CustomerPolicy, opts: { expectedVersion: number; note: string | null; confirm: boolean }) {
  const cur = await currentPolicy(ctx);
  if (opts.expectedVersion !== cur.version) throw new ApiError("conflict", "Someone changed this workspace's policy meanwhile. Reload to see the current version.");
  const next = change(cur.policy);
  const parsed = customerPolicySchema.safeParse(next);
  if (!parsed.success) throw new ApiError("bad_request", "That policy isn't valid.");
  const { snapshot } = await loadWorkspace(ctx);
  const problem = validateCustomerPolicy(parsed.data, {
    customAgents: snapshot.customAgents.map((a) => a.id),
    projects: snapshot.projects.map((p) => p.id),
    connectors: snapshot.connectors.map((c) => c.connectorId),
  });
  if (problem) throw new ApiError("bad_request", problem);
  const summary = describePolicyChange(cur.policy ?? DEFAULT_CUSTOMER_POLICY, parsed.data);
  const names: Record<string, string> = Object.fromEntries([
    ...snapshot.customAgents.map((a) => [`custom:${a.id}`, a.name]),
    ...AGENTS.map((a) => [`task:${a.id}`, a.name]),
    ...builtinAgents().map((a) => [`builtin:${a.id}`, a.name]),
  ]);
  const impact = policyImpact(cur.policy, parsed.data, names);
  if (!opts.confirm) return { preview: true, version: cur.version + 1, summary, impact };
  const ok = await recordEvent(ctx, "bastion.policy", { version: cur.version + 1, policy: parsed.data, summary, note: opts.note });
  invalidateWorkspacePolicy(ctx.ownerId);
  if (!ok) throw new ApiError("internal", "The policy couldn't be saved.");
  // Confirm it's the active version before saying so.
  const now = await currentPolicy(ctx);
  if (now.version !== cur.version + 1) throw new ApiError("internal", "The policy was written but couldn't be confirmed as active (its record isn't signed — is the server key configured?).");
  return { preview: false, version: now.version, summary, impact };
}

async function assertFindingInWorkspace(ctx: WorkspaceCtx, id: string) {
  if (id.startsWith("BW-")) {
    const { snapshot } = await loadWorkspace(ctx);
    const present = runChecks(snapshot).findings.some((f) => f.id === id);
    const recorded = (await auditRows(ctx, { actions: ["bastion.assessment"], limit: 50 })).some(
      (r) => r.integrity === "signed" && Array.isArray(r.detail.present) && (r.detail.present as { id: string }[]).some((p) => p.id === id),
    );
    if (!present && !recorded) throw new ApiError("not_found", "Finding not found.");
    return;
  }
  const { data } = await ctx.db.from("security_findings").select("id").eq("user_id", ctx.ownerId).eq("id", id).maybeSingle();
  if (!data) throw new ApiError("not_found", "Finding not found.");
}
