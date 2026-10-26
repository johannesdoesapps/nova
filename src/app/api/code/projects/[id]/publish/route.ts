import { NextResponse } from "next/server";
import { z } from "zod";
import { enforce } from "@/lib/bastion/server";
import { codeContext, getFiles, getProjectRow } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { planSite, siteFingerprint, siteProjectName } from "@/lib/publish/site";
import { siteHost } from "@/lib/publish/sites";
import { checkReachable, publishConfig, VercelHost, type HostDeployment, type PublishConfig } from "@/lib/publish/vercel";

export const maxDuration = 60;

/**
 * Publishing a Code project as a public website (see src/lib/publish/vercel.ts for the hosting set-up and
 * src/lib/publish/sites.ts for where a site lives: its own host project, or one shared project).
 *
 * GET    — whether publishing is set up, the live site (address, when, whether it matches the saved files), a
 *          publish still in progress, and what publishing the saved files now would do (problems, size).
 * GET ?deployment=dpl_… — one publish's progress; once the host says it's ready, Orbis opens the address from
 *          outside before calling it live.
 * POST   { confirm: true } — check the saved files and start a production deployment of them.
 * DELETE { confirm: true } — take the site down (its address stops working).
 *
 * Ownership: the project is read through the user's own session (row-level security), and a deployment is only
 * reported if it belongs to that project's site.
 */

const DEPLOYMENT_RE = /^dpl_[A-Za-z0-9]{1,64}$/;
const confirmBody = z.object({ confirm: z.literal(true) });

type Phase = "building" | "publishing" | "live" | "failed";

function hostFor(): { cfg: PublishConfig; host: VercelHost } {
  const cfg = publishConfig();
  if (!cfg) throw new ApiError("not_configured", "Publishing isn't set up on this Orbis yet: an administrator needs to add a hosting token (ORBIS_PUBLISH_VERCEL_TOKEN).");
  return { cfg, host: new VercelHost(cfg) };
}

/** Only ever open the site's own address on the host's domain (or the local test host), never anything else. */
function probeUrl(url: string, cfg: PublishConfig): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (cfg.api.startsWith("http://")) return `${cfg.api}/__sites/${u.hostname}/`;
  return u.protocol === "https:" && u.hostname.endsWith(".vercel.app") && !u.port ? `https://${u.hostname}/` : null;
}

function progress(d: HostDeployment): { phase: Phase; error?: string } {
  if (d.readyState === "ERROR" || d.readyState === "CANCELED" || d.readyState === "BLOCKED")
    return {
      phase: "failed",
      error:
        d.readyState === "CANCELED"
          ? "The publish was cancelled before it finished."
          : `The site didn't build${d.errorMessage ? `: ${d.errorMessage.slice(0, 300)}` : ""}. Your files are unchanged; fix the problem (or ask the agent to) and publish again.`,
    };
  // Built: the address is being assigned and checked before the site counts as live.
  if (d.readyState === "READY") return { phase: "publishing" };
  return { phase: "building" };
}

export async function GET(req: Request, ctx: RouteContext<"/api/code/projects/[id]/publish">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("code-publish-status", 120);
    const project = await getProjectRow(auth, id);
    const cfg = publishConfig();
    const deploymentId = new URL(req.url).searchParams.get("deployment");

    if (deploymentId) {
      if (!DEPLOYMENT_RE.test(deploymentId)) throw new ApiError("bad_request", "That isn't a publish id.");
      const { host } = hostFor();
      const site = siteHost(host, cfg!, id);
      const d = await site.deployment(deploymentId);
      if (!d) throw new ApiError("not_found", "That publish wasn't found for this project.");
      const p = progress(d);
      if (p.phase !== "publishing") return NextResponse.json({ phase: p.phase, state: d.readyState, error: p.error ?? null });
      const { url, assigned } = await site.address(d);
      const probe = probeUrl(url, cfg!);
      if (!probe) return NextResponse.json({ phase: "failed", state: d.readyState, error: "The host gave the site an address Orbis doesn't recognise, so it wasn't opened." });
      const reach = await checkReachable(probe);
      if (!reach.ok)
        return NextResponse.json({
          phase: assigned ? "failed" : "publishing",
          state: d.readyState,
          url,
          error: !assigned
            ? null
            : reach.status === 401 || reach.status === 403
              ? `The site was published but ${url} asks visitors to log in to Vercel. An administrator needs to turn off Vercel Authentication (Settings → Deployment Protection) for the hosting project, then publish again.`
              : `The site was published but ${url} didn't load from outside (${reach.detail}). Try again in a minute; if it keeps failing, publish again.`,
        });
      return NextResponse.json({ phase: "live", state: d.readyState, url, publishedAt: d.createdAt ? new Date(d.createdAt).toISOString() : new Date().toISOString(), fingerprint: d.meta.orbisFingerprint ?? null });
    }

    const files = await getFiles(auth, id);
    const plan = planSite(files);
    const current = { fingerprint: await siteFingerprint(plan.files), problems: plan.problems, files: plan.files.length, bytes: plan.bytes, kind: plan.kind, name: siteProjectName(project.name, id) };
    if (!cfg) return NextResponse.json({ configured: false, site: null, pending: null, current, upToDate: null });

    const status = await siteHost(new VercelHost(cfg), cfg, id).status();
    const live = status.live?.deployment;
    const pending = status.pending ? { deploymentId: status.pending.id, state: status.pending.readyState } : null;
    const liveSite = live
      ? { url: status.live!.url, deploymentId: live.id, publishedAt: live.createdAt ? new Date(live.createdAt).toISOString() : null, fingerprint: live.meta.orbisFingerprint ?? null }
      : null;
    return NextResponse.json({ configured: true, site: liveSite, pending, current, upToDate: liveSite ? liveSite.fingerprint === current.fingerprint : null });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, ctx: RouteContext<"/api/code/projects/[id]/publish">) {
  try {
    const id = requireUuid((await ctx.params).id);
    await parseJsonBody(req, confirmBody, 1_000);
    const auth = await codeContext("code-publish", 6);
    const project = await getProjectRow(auth, id);
    const { cfg, host } = hostFor();

    // 1–4. Read the saved files, find the entry point and framework, check references and secrets.
    const files = await getFiles(auth, id);
    const plan = planSite(files);
    const errors = plan.problems.filter((p) => p.level === "error");
    if (errors.length) throw new ApiError("bad_request", errors[0].message, { problems: plan.problems });

    const name = siteProjectName(project.name, id);
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "user", agent: "publish" }, "site.publish", `${project.name} → ${name}.vercel.app`.slice(0, 200), { approved: true });

    // 5. Upload the files and deploy them where the site lives (its own project, or the shared one).
    const uploaded = await host.upload(plan.files);
    const fingerprint = await siteFingerprint(plan.files);
    const d = await siteHost(host, cfg, id).publish(project.name, plan, uploaded, fingerprint);
    return NextResponse.json({ deploymentId: d.id, phase: progress(d).phase === "failed" ? "failed" : "building", kind: plan.kind, warnings: plan.problems.filter((p) => p.level === "warning"), files: plan.files.length });
  } catch (err) {
    if (!(err instanceof ApiError)) reportError(err, { where: "code.publish" });
    return errorResponse(err);
  }
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/code/projects/[id]/publish">) {
  try {
    const id = requireUuid((await ctx.params).id);
    await parseJsonBody(req, confirmBody, 1_000);
    const auth = await codeContext("code-publish", 6);
    await getProjectRow(auth, id);
    const { cfg, host } = hostFor();
    const removed = await siteHost(host, cfg, id).remove();
    return NextResponse.json({ ok: true, removed });
  } catch (err) {
    return errorResponse(err);
  }
}
