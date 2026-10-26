import { NextResponse } from "next/server";
import { z } from "zod";
import { enforce } from "@/lib/bastion/server";
import { codeContext, getFiles, getProjectRow } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { planSite, publicUrl, siteFingerprint, siteKey, siteProjectName } from "@/lib/publish/site";
import { checkReachable, publishConfig, VercelHost, type HostDeployment, type PublishConfig } from "@/lib/publish/vercel";

export const maxDuration = 60;

/**
 * Publishing a Code project as a public website (see src/lib/publish/vercel.ts for the hosting set-up).
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
      const site = await host.findProject(siteKey(id));
      const d = site ? await host.deployment(deploymentId) : null;
      if (!site || !d || d.projectId !== site.id || d.meta.orbisProject !== id) throw new ApiError("not_found", "That publish wasn't found for this project.");
      const p = progress(d);
      if (p.phase !== "publishing") return NextResponse.json({ phase: p.phase, state: d.readyState, error: p.error ?? null });
      const url = publicUrl(d.alias, d.url, site.name);
      const probe = probeUrl(url, cfg!);
      if (!probe) return NextResponse.json({ phase: "failed", state: d.readyState, error: "The host gave the site an address Orbis doesn't recognise, so it wasn't opened." });
      const reach = await checkReachable(probe);
      if (!reach.ok)
        return NextResponse.json({
          phase: d.aliasAssigned ? "failed" : "publishing",
          state: d.readyState,
          url,
          error: d.aliasAssigned ? `The site was published but ${url} didn't load from outside (${reach.detail}). Try again in a minute; if it keeps failing, publish again.` : null,
        });
      return NextResponse.json({ phase: "live", state: d.readyState, url, publishedAt: d.createdAt ? new Date(d.createdAt).toISOString() : new Date().toISOString(), fingerprint: d.meta.orbisFingerprint ?? null });
    }

    const files = await getFiles(auth, id);
    const plan = planSite(files);
    const current = { fingerprint: await siteFingerprint(plan.files), problems: plan.problems, files: plan.files.length, bytes: plan.bytes, kind: plan.kind, name: siteProjectName(project.name, id) };
    if (!cfg) return NextResponse.json({ configured: false, site: null, pending: null, current, upToDate: null });

    const host = new VercelHost(cfg);
    const site = await host.findProject(siteKey(id));
    if (!site) return NextResponse.json({ configured: true, site: null, pending: null, current, upToDate: null });
    const [live, latest] = await Promise.all([host.latestProduction(site.id, "READY"), host.latestProduction(site.id)]);
    const pending = latest && latest.id !== live?.id && !["ERROR", "CANCELED", "BLOCKED", "READY"].includes(latest.readyState) ? { deploymentId: latest.id, state: latest.readyState } : null;
    const liveSite = live
      ? { url: publicUrl(live.alias, live.url, site.name), deploymentId: live.id, publishedAt: live.createdAt ? new Date(live.createdAt).toISOString() : null, fingerprint: live.meta.orbisFingerprint ?? null }
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
    const { host } = hostFor();

    // 1–4. Read the saved files, find the entry point and framework, check references and secrets.
    const files = await getFiles(auth, id);
    const plan = planSite(files);
    const errors = plan.problems.filter((p) => p.level === "error");
    if (errors.length) throw new ApiError("bad_request", errors[0].message, { problems: plan.problems });

    const name = siteProjectName(project.name, id);
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "user", agent: "publish" }, "site.publish", `${project.name} → ${name}.vercel.app`.slice(0, 200), { approved: true });

    // 5. The site's project on the host (created on the first publish, kept public and in step with the files).
    let site = await host.findProject(siteKey(id));
    if (!site) site = await host.createProject(name, plan.framework, plan.buildCommand);
    else await host.updateProject(site.id, plan.framework, plan.buildCommand);

    const uploaded = await host.upload(plan.files);
    const fingerprint = await siteFingerprint(plan.files);
    const d = await host.deploy(site, uploaded, { orbisProject: id, orbisFingerprint: fingerprint }, plan.framework, plan.buildCommand);
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
    const { host } = hostFor();
    const site = await host.findProject(siteKey(id));
    if (site) await host.deleteProject(site.id);
    return NextResponse.json({ ok: true, removed: !!site });
  } catch (err) {
    return errorResponse(err);
  }
}
