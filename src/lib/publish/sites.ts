import "server-only";
import { ApiError } from "@/lib/http";
import { publicUrl, siteKey, siteProjectName, type SitePlan } from "./site";
import type { HostDeployment, HostProject, PublishConfig, VercelHost } from "./vercel";

/**
 * Where a Code project's site lives at the host, in either of the two set-ups (see vercel.ts):
 *
 * - Dedicated: the site is its own Vercel project, named <name>-<key>; each publish is a production deployment and
 *   the address is the project's own *.vercel.app domain. Deleting the project takes the site down.
 * - Shared: every site is a deployment in one existing project (ORBIS_PUBLISH_VERCEL_PROJECT), because the account
 *   can't create projects through the API. Each deployment carries the Orbis project id and its address in its meta;
 *   once it's built, Orbis points the address (an alias, <name>-<key>.vercel.app) at it. The address is chosen on
 *   the first publish and reused, so renaming the project keeps it. Removing the alias takes the site down.
 *
 * Either way, a deployment only counts as this project's if it's in the right host project and its meta names it.
 */

export interface LiveSite {
  url: string;
  deployment: HostDeployment;
}

export interface SiteHost {
  /** The site's live version and any publish still in progress (both null before the first publish). */
  status(): Promise<{ live: LiveSite | null; pending: HostDeployment | null }>;
  /** Read a deployment, or null if it isn't one of this site's. */
  deployment(id: string): Promise<HostDeployment | null>;
  /** For a built deployment: its address, after making sure the address points at it (shared mode). */
  address(d: HostDeployment): Promise<{ url: string; assigned: boolean }>;
  publish(projectName: string, plan: SitePlan, uploaded: { file: string; sha: string; size: number }[], fingerprint: string): Promise<HostDeployment>;
  /** Take the site down; false if there was nothing published. */
  remove(): Promise<boolean>;
}

const TERMINAL = ["ERROR", "CANCELED", "BLOCKED", "READY"];

export function siteHost(host: VercelHost, cfg: PublishConfig, projectId: string): SiteHost {
  return cfg.sharedProject ? new SharedSite(host, cfg.sharedProject, projectId) : new DedicatedSite(host, projectId);
}

class DedicatedSite implements SiteHost {
  private site: Promise<HostProject | null> | null = null;
  constructor(
    private host: VercelHost,
    private projectId: string,
  ) {}

  private project() {
    return (this.site ??= this.host.findProject(siteKey(this.projectId)));
  }

  async status() {
    const site = await this.project();
    if (!site) return { live: null, pending: null };
    const [live, latest] = await Promise.all([this.host.latestProduction(site.id, "READY"), this.host.latestProduction(site.id)]);
    const pending = latest && latest.id !== live?.id && !TERMINAL.includes(latest.readyState) ? latest : null;
    return { live: live ? { url: publicUrl(live.alias, live.url, site.name), deployment: live } : null, pending };
  }

  async deployment(id: string) {
    const site = await this.project();
    const d = site ? await this.host.deployment(id) : null;
    return site && d && d.projectId === site.id && d.meta.orbisProject === this.projectId ? d : null;
  }

  async address(d: HostDeployment) {
    const site = (await this.project())!;
    return { url: publicUrl(d.alias, d.url, site.name), assigned: d.aliasAssigned };
  }

  async publish(projectName: string, plan: SitePlan, uploaded: { file: string; sha: string; size: number }[], fingerprint: string) {
    // The site's own project: created on the first publish, kept public and in step with the files.
    let site = await this.project();
    if (!site) site = await this.host.createProject(siteProjectName(projectName, this.projectId), plan.framework, plan.buildCommand);
    else await this.host.updateProject(site.id, plan.framework, plan.buildCommand);
    this.site = Promise.resolve(site);
    return this.host.deploy(site, uploaded, { orbisProject: this.projectId, orbisFingerprint: fingerprint }, plan.framework, plan.buildCommand);
  }

  async remove() {
    const site = await this.project();
    if (site) await this.host.deleteProject(site.id);
    return !!site;
  }
}

class SharedSite implements SiteHost {
  private shared: Promise<HostProject> | null = null;
  private recent: Promise<HostDeployment[]> | null = null;
  constructor(
    private host: VercelHost,
    private sharedName: string,
    private projectId: string,
  ) {}

  /** Only an address on the host's domain that ends with this project's key is ever used. */
  private ownAlias(alias: string | undefined): string | null {
    return alias && new RegExp(`^[a-z0-9](?:[a-z0-9-]{0,50}-)?${siteKey(this.projectId)}\\.vercel\\.app$`).test(alias) ? alias : null;
  }

  private project() {
    return (this.shared ??= this.host.getProject(this.sharedName).then((p) => {
      if (!p) throw new ApiError("not_configured", `Publishing is set to use the Vercel project "${this.sharedName}" (ORBIS_PUBLISH_VERCEL_PROJECT), but Orbis's publishing token can't see it. Either the project doesn't exist in the team, or ORBIS_PUBLISH_VERCEL_TOKEN is limited to other projects: replace it with a token scoped to the whole team.`);
      return p;
    }));
  }

  /** This site's newest deployments in the shared project, newest first. */
  private deployments() {
    return (this.recent ??= this.project().then((p) => this.host.deployments(p.id, { orbisProject: this.projectId }, 20)));
  }

  /** The site's address: the one its deployments already use, if it has been published before. */
  private async knownAlias(): Promise<string | null> {
    for (const d of await this.deployments()) {
      const a = this.ownAlias(d.meta.orbisAlias);
      if (a) return a;
    }
    return null;
  }

  private belongs(d: HostDeployment | null, shared: HostProject): d is HostDeployment {
    return !!d && d.projectId === shared.id && d.meta.orbisProject === this.projectId && !!this.ownAlias(d.meta.orbisAlias);
  }

  async status() {
    const [shared, recent, alias] = await Promise.all([this.project(), this.deployments(), this.knownAlias()]);
    let live: LiveSite | null = null;
    const target = alias ? await this.host.aliasTarget(alias) : null;
    if (alias && target) {
      const d = recent.find((x) => x.id === target.deploymentId) ?? (await this.host.deployment(target.deploymentId));
      if (d && d.meta.orbisProject === this.projectId && (d.projectId ?? shared.id) === shared.id) live = { url: `https://${alias}`, deployment: d };
    }
    const latest = recent[0] ?? null;
    const pending = latest && latest.id !== live?.deployment.id && !TERMINAL.includes(latest.readyState) ? latest : null;
    return { live, pending };
  }

  async deployment(id: string) {
    const shared = await this.project();
    const d = await this.host.deployment(id);
    return this.belongs(d, shared) ? d : null;
  }

  async address(d: HostDeployment) {
    const alias = this.ownAlias(d.meta.orbisAlias)!;
    const target = await this.host.aliasTarget(alias);
    if (target?.deploymentId !== d.id) {
      // Never move the address back to an older version than the one it shows.
      const current = target ? await this.host.deployment(target.deploymentId) : null;
      const newer = current && current.meta.orbisProject === this.projectId && (current.createdAt ?? 0) > (d.createdAt ?? 0);
      if (!newer) await this.host.assignAlias(d.id, alias);
    }
    return { url: `https://${alias}`, assigned: true };
  }

  async publish(projectName: string, plan: SitePlan, uploaded: { file: string; sha: string; size: number }[], fingerprint: string) {
    const shared = await this.project();
    // Sites must open without a Vercel login; if the account won't allow the change, the check after publishing says so.
    await this.host.keepPublic(shared.id);
    const alias = (await this.knownAlias()) ?? `${siteProjectName(projectName, this.projectId)}.vercel.app`;
    return this.host.deploy(shared, uploaded, { orbisProject: this.projectId, orbisFingerprint: fingerprint, orbisAlias: alias }, plan.framework, plan.buildCommand, { shared: true });
  }

  async remove() {
    const alias = await this.knownAlias();
    if (!alias) return false;
    await this.host.removeAlias(alias);
    // The address is gone; also delete the site's deployments so their own URLs stop working (best effort).
    for (const d of await this.deployments()) await this.host.deleteDeployment(d.id).catch(() => {});
    return true;
  }
}
