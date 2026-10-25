import "server-only";
import { getProvider, resolveModelChoice, withTimeout } from "../ai";
import { estimateTokens } from "../ai/cost";
import { autoIdFor } from "../ai/platform";
import type { ChatMessage } from "../ai/types";
import type { AuthContext } from "../auth";
import * as store from "../db/security";
import { ApiError, clientIp } from "../http";
import { limiter } from "../rate-limit";
import { enforceLimits, planLimits, recordRunLater } from "../usage";
import { agentDef } from "./agents";
import { proveOwnership } from "./authz";
import { runCodeRules, type SourceFile } from "./code-rules";
import { correlate } from "./correlate";
import { checkDependencies, parseManifests } from "./deps";
import { githubReadToken, requireService } from "./connections";
import { asOpenFindings, configFindings, DEFAULT_DEPLOY_GATE, deployGate, previewProbe, productionHost, readVercelProject, VERCEL_CHECKED, vercelAsset, type DeployGateConfig } from "./vercel-audit";
import { ConnectorError } from "../connectors/http";
import { accessFindings, AREA_LABEL, AREA_PREFIX, coverageGaps, listZones, MANAGED_RULESETS, readAccess, readZone, zoneAsset, accountAsset, zoneFindings, type Area, type ZoneSnapshot } from "./cloudflare-audit";
import { safeRequest } from "./net";
import { applyVerification, parseVerification, selectForVerification, verificationMessages } from "./verify";
import { fetchPullRequest, prAsset, prCovers, prEvidence, scopeToPr, type PrInfo } from "./pr";
import { fetchRepoFiles } from "./github";
import { parseIndicators } from "./logs";
import { analyseLogs, huntSections, type Analysis } from "./hunt/analyse";
import { SOURCE_LABEL, type SourceKind } from "./hunt/events";
import { ipRecord, uncheckedRecord, type IndicatorRecord } from "./hunt/intel";
import { analyseEngineering, fitGuardianSummary } from "./guardian/analyse";
import { buildMemory, countFindings, type Counts, type MemorySummary, type StoredFindingRow } from "./guardian/memory";
import { fitHuntStats, relatedPrior, type Investigation } from "./hunt/investigate";
import { qaCheck, type QaIssue } from "./hunt/qa";
import { HUNT_RULES } from "./hunt/rules";
import { normalizeHost } from "./net";
import { analyseAudit, auditSections, compactAnalysis, fitStats, type StoredAnalysis } from "./audit-report";
import { aiReviewMessages, auditReportMessages, huntReportMessages, compactFindings, fixMessages, parseAiReview, parseFixes, reportMessages, selectFilesForReview, unifiedReportMessages } from "./prompts";
import { abuseIpLookup, reputationFindings, type IpReputation } from "./reputation";
import { crawlBudget, MODE_INFO, type AuditMode, type TimeBudget } from "./audit";
import { auditConfig, type AuditConfig } from "./schema";
import { codeMapFindings, compactMap, mapCode } from "./code-map";
import { runSentinel, type SentinelScope } from "./sentinel";
import { SEVERITY_ORDER, type FindingDraft, type SecurityAgentId, type ToolRun } from "./types";

export type Send = (event: Record<string, unknown>) => void;

export interface RunContext {
  req: Request;
  auth: Extract<AuthContext, { mode: "authenticated" }>;
  send: Send;
  signal: AbortSignal;
  modelId?: string;
  parentId?: string | null;
}

/** At most 12 agent runs per user per 10 minutes, across all agents. */
export function checkRunLimit(req: Request, auth: AuthContext) {
  const who = auth.mode === "authenticated" ? `u:${auth.user.id}` : `ip:${clientIp(req)}`;
  if (!limiter("security-runs", 12, 10 * 60_000).check(who, 1).ok) throw new ApiError("rate_limited", "Too many security runs. Please wait a few minutes.");
}

/** The running coordinated parent, and its audit settings when it's a Sentinel audit (they override the request's). */
async function verifyParent(ctx: RunContext): Promise<AuditConfig | null> {
  if (!ctx.parentId) return null;
  const parent = await store.getRunRow(ctx.auth.supabase, ctx.auth.user.id, ctx.parentId);
  if (parent.agent !== "coordinated" || parent.status !== "running") throw new ApiError("bad_request", "That coordinated investigation isn't running.");
  const cfg = auditConfig.safeParse(parent.stats.audit);
  return cfg.success ? cfg.data : null;
}

class Steps {
  tools: ToolRun[] = [];
  constructor(
    private send: Send,
    private agent: string,
  ) {}
  start(id: string, label: string) {
    this.send({ type: "step", agent: this.agent, id, label, status: "running" });
    return performance.now();
  }
  finish(id: string, label: string, status: ToolRun["status"], detail: string, started?: number) {
    const durationMs = started ? Math.round(performance.now() - started) : undefined;
    this.tools.push({ tool: label, status, detail, durationMs });
    this.send({ type: "step", agent: this.agent, id, label, status: status === "ok" ? "done" : status, detail });
  }
}

const countBy = (fs: FindingDraft[]) => fs.reduce<Record<string, number>>((acc, f) => ((acc[f.severity] = (acc[f.severity] ?? 0) + 1), acc), {});

/** One AI call with the user's chosen model. Demo models are skipped, never presented as analysis. */
async function aiText(ctx: RunContext, opts: { defaultMode: "deep" | "coding"; messages: ChatMessage[]; purpose: string; prompt: string; maxOutputTokens: number }): Promise<{ text: string; modelId: string; modelName: string } | { skipped: string }> {
  const tiers = (await planLimits(ctx.auth)).tiers;
  const choice = await resolveModelChoice(ctx.modelId ?? autoIdFor(opts.defaultMode), { prompt: opts.prompt, needs: ["reasoning"], tiers }).catch(
    () => resolveModelChoice(ctx.modelId ?? autoIdFor(opts.defaultMode), { prompt: opts.prompt, tiers }),
  );
  const model = choice.model;
  if (model.provider === "demo") return { skipped: "No AI model is configured, so results are shown without an AI explanation." };
  await enforceLimits(ctx.req, ctx.auth, 1, [model], { purpose: opts.purpose, inputTokens: Math.ceil(opts.messages.reduce((n, m) => n + m.content.length, 0) / 4) + 200, maxOutputTokens: opts.maxOutputTokens });
  const started = performance.now();
  const r = await getProvider(model.provider).generate({ model, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens, temperature: 0.2, signal: withTimeout(40_000, ctx.signal) });
  recordRunLater(ctx.auth, {
    model,
    prompt: opts.prompt.slice(0, 400),
    response: r.text,
    latencyMs: performance.now() - started,
    usage: r.usage.inputTokens === null ? { inputTokens: estimateTokens(opts.messages), outputTokens: estimateTokens(r.text), estimated: true } : r.usage,
    status: "success",
    purpose: opts.purpose,
    category: "security",
    servedModel: r.servedModel ?? null,
  });
  return { text: r.text, modelId: model.id, modelName: model.displayName };
}

async function writeReport(ctx: RunContext, steps: Steps, agent: SecurityAgentId, context: string, findings: FindingDraft[], extra = "") {
  const def = agentDef(agent)!;
  const t = steps.start("report", "AI report");
  try {
    const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    const r = await aiText(ctx, { defaultMode: agent === "code_guardian" ? "coding" : "deep", messages: reportMessages(def.name, def.role, context, compactFindings(sorted), extra), purpose: "security", prompt: `[${agent} report] ${context}`, maxOutputTokens: 1800 });
    if ("skipped" in r) {
      steps.finish("report", "AI report", "skipped", r.skipped, t);
      return { summary: null, modelId: null };
    }
    steps.finish("report", "AI report", "ok", `Written by ${r.modelName}`, t);
    ctx.send({ type: "report", text: r.text });
    return { summary: r.text, modelId: r.modelId };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    steps.finish("report", "AI report", "failed", err instanceof ApiError ? err.message : "The AI model call failed; scanner results are still saved.", t);
    return { summary: null, modelId: null };
  }
}

async function guarded<T>(ctx: RunContext, runId: string, agent: string, steps: Steps, body: () => Promise<T>): Promise<T> {
  const { supabase: db, user } = ctx.auth;
  try {
    return await body();
  } catch (err) {
    const cancelled = ctx.signal.aborted;
    const message = cancelled ? "Cancelled by the user." : err instanceof ApiError ? err.message : "The run failed unexpectedly.";
    await store.finishRun(db, runId, { status: cancelled ? "cancelled" : "failed", tools: steps.tools, error: message });
    await store.audit(db, user.id, cancelled ? "run.cancelled" : "run.failed", { runId, detail: { agent, message } });
    throw err;
  }
}

/* ---------------------------------------------------------------- Sentinel */

export async function runSentinelAgent(ctx: RunContext, input: { targetId: string; scope: SentinelScope; mode?: AuditMode; timeBudget?: TimeBudget }) {
  const { supabase: db, user } = ctx.auth;
  const cfg = await verifyParent(ctx);
  if (cfg) input = { ...input, mode: cfg.mode, timeBudget: cfg.timeBudget, scope: cfg.active ? "active" : "passive" };
  const target = await store.getTarget(db, user.id, input.targetId);
  const host = normalizeHost(target.hostname);
  const runId = await store.startRun(db, user.id, { agent: "sentinel", action: "scan", asset: host, scope: input.scope, parentId: ctx.parentId });
  ctx.send({ type: "run", agent: "sentinel", runId });
  const steps = new Steps(ctx.send, "sentinel");
  return guarded(ctx, runId, "sentinel", steps, async () => {
    let t = steps.start("authorize", "Ownership check");
    const proof = await proveOwnership(target, ctx.auth, ctx.signal);
    if (!proof.ok) {
      steps.finish("authorize", "Ownership check", "failed", proof.reason, t);
      await store.setTargetVerified(db, target.id, null);
      throw new ApiError("forbidden", proof.reason);
    }
    await store.setTargetVerified(db, target.id, proof.method);
    steps.finish("authorize", "Ownership check", "ok", `Confirmed by ${proof.method.replace("_", " ")}`, t);
    if (!limiter("sentinel-host", 4, 10 * 60_000).check(host, 1).ok) throw new ApiError("rate_limited", `${host} was scanned several times recently. Please wait a few minutes.`);
    await store.audit(db, user.id, "scan.started", { runId, detail: { host, scope: input.scope, proof: proof.method } });

    const budget = input.mode ? crawlBudget(input.mode, input.timeBudget ?? "standard", input.scope === "active") : undefined;
    const label = budget
      ? input.scope === "active"
        ? "Site map, header, config, exposure & endpoint checks"
        : "Site map, header & config checks"
      : input.scope === "active"
        ? "Header, config & exposure checks"
        : "Header & config checks";
    t = steps.start("scan", label);
    const result = await runSentinel(host, input.scope, { signal: ctx.signal, budget, progress: (s) => ctx.send({ type: "progress", agent: "sentinel", text: s }) });
    const mapped = result.map
      ? `, ${result.map.pagesFetched} pages and ${result.map.scriptsFetched} scripts mapped${result.map.endpointResults.length ? `, ${result.map.endpointResults.length} endpoints checked` : ""}`
      : "";
    steps.finish("scan", label, "ok", `${result.requests} read-only requests${mapped}, ${result.findings.length} findings`, t);
    for (const n of result.notes) ctx.send({ type: "notice", agent: "sentinel", text: n });

    const saved = await store.saveFindings(db, user.id, runId, result.findings);
    // Mapped-site findings are only "not detected" where this run looked again (a smaller crawl doesn't clear them).
    const covered = new Set(result.map?.covered ?? []);
    const resolved = await store.markNotDetected(db, user.id, runId, "sentinel", host, result.checked, { prefix: "surface.", covers: (loc) => !!loc && covered.has(loc) });
    ctx.send({ type: "findings", agent: "sentinel", count: result.findings.length, bySeverity: countBy(result.findings), resolved, reopened: saved.reopened });

    const report = await writeReport(
      ctx,
      steps,
      "sentinel",
      `Website ${host}, scope ${input.scope}. ${result.requests} HTTP requests made. Notes: ${result.notes.join(" ") || "none"}.`,
      result.findings,
    );
    const base = {
      findings: result.findings.length,
      bySeverity: countBy(result.findings),
      requests: result.requests,
      created: saved.created,
      resolved,
      reopened: saved.reopened,
      scope: input.scope,
      mode: input.mode ?? null,
      notes: result.notes.slice(0, 20),
    };
    const stats = fitStats({
      ...base,
      ...(result.map ? { surface: result.map.surface, pagesFetched: result.map.pagesFetched, scriptsFetched: result.map.scriptsFetched, endpointResults: result.map.endpointResults } : {}),
    });
    await store.finishRun(db, runId, { status: "completed", summary: report.summary, tools: steps.tools, stats, modelId: report.modelId });
    await store.audit(db, user.id, "scan.finished", { runId, detail: base });
    ctx.send({ type: "done", agent: "sentinel", runId });
    return { runId, findings: result.findings };
  });
}

/* ------------------------------------------------- Vercel deployment audit */

/**
 * Application Protection for a Vercel project (Workflows B and C): read-only settings and variable metadata through
 * the person's Vercel connection, a passive check that previews are protected, passive header/TLS checks on the
 * production domain (ownership: it's a verified domain of a project the person's own token can read), then an
 * advisory deploy gate that also weighs open findings of the linked repository. Nothing on Vercel is changed.
 */
export async function runDeploymentAudit(ctx: RunContext, input: { project: string; teamId?: string | null; gate?: DeployGateConfig; siteChecks?: boolean }) {
  const { supabase: db, user } = ctx.auth;
  const teamId = input.teamId ?? null;
  const gateCfg = input.gate ?? DEFAULT_DEPLOY_GATE;
  const runId = await store.startRun(db, user.id, { agent: "sentinel", action: "deployment", asset: `vercel:${teamId ?? "personal"}/${input.project}`, scope: "passive", parentId: ctx.parentId });
  ctx.send({ type: "run", agent: "sentinel", runId });
  const steps = new Steps(ctx.send, "sentinel");
  return guarded(ctx, runId, "sentinel", steps, async () => {
    const planned: { label: string; status: string }[] = [];
    let t = steps.start("connect", "Vercel connection");
    const { ctx: vctx, row } = await requireService(ctx.auth, "vercel", ctx.signal);
    steps.finish("connect", "Vercel connection", "ok", `Connected${row.account_label ? ` as ${row.account_label}` : ""}; read-only calls only`, t);

    t = steps.start("project", "Project settings");
    const snap = await readVercelProject(vctx, input.project, teamId).catch((err) => {
      throw err instanceof ConnectorError ? new ApiError(err.kind === "auth" || err.kind === "permission" ? "forbidden" : err.kind === "not_found" ? "not_found" : "upstream_error", err.message) : err;
    });
    const asset = vercelAsset(snap.project);
    steps.finish(
      "project",
      "Project settings",
      snap.missing.length ? "failed" : "ok",
      `${snap.project.name}${snap.project.framework ? ` (${snap.project.framework})` : ""}: ${snap.envs.length} environment variable names (values not read), ${snap.domains.length} domains, ${snap.deployments.length} recent deployments${snap.missing.length ? ` · not read: ${snap.missing.join("; ")}` : ""}`,
      t,
    );
    planned.push({ label: "Project settings", status: snap.missing.length ? "failed" : "completed" });
    await store.audit(db, user.id, "deployment_audit.started", { runId, detail: { project: snap.project.name, teamId, gate: gateCfg } });

    const findings = configFindings(snap);
    const notes: string[] = [];

    // Workflow B evidence: is a real preview reachable without signing in?
    const preview = snap.deployments.find((d) => d.target !== "production" && d.state === "READY" && d.url);
    t = steps.start("preview", "Preview protection check");
    if (preview?.url) {
      const url = `https://${preview.url}/`;
      const status = await safeRequest(url, { method: "GET", signal: ctx.signal, maxBytes: 4096 })
        .then((r) => r.status)
        .catch(() => null);
      const note = previewProbe(findings, url, status);
      notes.push(note);
      steps.finish("preview", "Preview protection check", status == null ? "failed" : "ok", `${note} One read-only request.`, t);
      planned.push({ label: "Preview protection check", status: status == null ? "failed" : "completed" });
    } else steps.finish("preview", "Preview protection check", "skipped", "No ready preview deployment to check.", t);

    // Workflow C: passive checks on the live production site.
    let siteFindings: FindingDraft[] = [];
    let siteChecked: string[] = [];
    const host = productionHost(snap);
    t = steps.start("site", "Production site checks");
    if (input.siteChecks === false) steps.finish("site", "Production site checks", "skipped", "Turned off for this audit.", t);
    else if (!host) {
      steps.finish("site", "Production site checks", "skipped", "No verified production domain found.", t);
      planned.push({ label: "Production site checks", status: "missing" });
    } else if (!limiter("sentinel-host", 4, 10 * 60_000).check(host, 1).ok) {
      steps.finish("site", "Production site checks", "skipped", `${host} was checked several times recently; try again in a few minutes.`, t);
      planned.push({ label: "Production site checks", status: "skipped" });
    } else {
      const r = await runSentinel(host, "passive", { signal: ctx.signal, progress: (s) => ctx.send({ type: "progress", agent: "sentinel", text: s }) });
      siteFindings = r.findings;
      siteChecked = r.checked;
      notes.push(...r.notes);
      steps.finish("site", "Production site checks", r.finalUrl ? "ok" : "failed", `${host} (a verified domain of this project): ${r.requests} read-only requests, ${r.findings.length} findings. Headers, TLS, cookies and CORS only; nothing was submitted or probed.`, t);
      planned.push({ label: "Production site checks", status: r.finalUrl ? "completed" : "failed" });
    }

    const all = [...findings, ...siteFindings];
    const saved = await store.saveFindings(db, user.id, runId, all);
    let resolved = await store.markNotDetected(db, user.id, runId, "sentinel", asset, snap.missing.length ? [] : VERCEL_CHECKED);
    if (host && siteChecked.length) resolved += await store.markNotDetected(db, user.id, runId, "sentinel", host, siteChecked.filter((p) => p !== "surface."));
    ctx.send({ type: "findings", agent: "sentinel", count: all.length, bySeverity: countBy(all), resolved, reopened: saved.reopened });

    // The gate also weighs the linked repository's open code findings, if Code Guardian has audited it.
    t = steps.start("gate", "Deploy gate");
    const repoAsset = snap.project.link?.repo ? `github:${snap.project.link.repo}` : null;
    const repoFindings = repoAsset ? (await store.listFindings(db, user.id, { asset: repoAsset, scope: "security" })).filter((f) => ["open", "investigating", "fix_proposed"].includes(f.status)) : [];
    const { data: repoRuns } = repoAsset ? await db.from("security_runs").select("id").eq("user_id", user.id).eq("agent", "code_guardian").eq("asset", repoAsset).eq("status", "completed").limit(1) : { data: [] };
    const gate = deployGate(
      { deployment: asOpenFindings(all), repository: repoFindings as unknown as Parameters<typeof deployGate>[0]["repository"], steps: planned, repoAudited: !!repoRuns?.length },
      gateCfg,
    );
    steps.finish("gate", "Deploy gate", "ok", `${gate.decision.toUpperCase()} (${gateCfg.mode === "block" ? "blocking" : "warning"} mode, advisory: Orbis doesn't stop Vercel builds). ${gate.reasons.join(" ") || "No blocking findings."}`, t);
    await store.audit(db, user.id, "deployment_gate.evaluated", { runId, detail: { project: snap.project.name, decision: gate.decision, blocking: gate.gate.blocking.length, mode: gateCfg.mode } });

    const prod = snap.deployments.find((d) => d.target === "production");
    const report = await writeReport(
      ctx,
      steps,
      "sentinel",
      `Vercel project ${snap.project.name}: settings and environment-variable metadata (names, types and targets only; values were never read), ${host ? `passive checks of ${host}` : "no production domain checked"}. Deploy gate: ${gate.decision}. Not read: ${snap.missing.join("; ") || "nothing"}. Notes: ${notes.join(" ") || "none"}.`,
      all,
    );
    const p = snap.project;
    const base = {
      findings: all.length,
      bySeverity: countBy(all),
      created: saved.created,
      resolved,
      reopened: saved.reopened,
      notes: notes.slice(0, 20),
    };
    const stats = fitStats({
      ...base,
      vercel: {
        project: p.name,
        projectId: p.id,
        teamId,
        framework: p.framework,
        nodeVersion: p.nodeVersion,
        repo: p.link?.repo ?? null,
        protection: { vercelAuth: p.ssoProtection ?? null, password: p.passwordProtection ?? null, forkProtection: p.gitForkProtection ?? null, publicSource: p.publicSource ?? null, bypassSecrets: p.bypassSecrets, firewall: p.firewallEnabled ?? null },
        envs: { total: snap.envs.length, byType: snap.envs.reduce<Record<string, number>>((a, e) => ((a[e.type] = (a[e.type] ?? 0) + 1), a), {}), public: snap.envs.filter((e) => /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_)/.test(e.key)).length },
        domains: snap.domains.slice(0, 20),
        production: prod ? { id: prod.id, state: prod.state, commit: prod.commit, branch: prod.branch, created: prod.created } : null,
        checkedHost: host,
        missing: snap.missing,
      },
      deployGate: { decision: gate.decision, mode: gateCfg.mode, blockSeverities: gateCfg.blockSeverities, reasons: gate.reasons, blocking: gate.gate.blocking.slice(0, 20), considered: gate.considered },
    });
    await store.finishRun(db, runId, { status: "completed", summary: report.summary, tools: steps.tools, stats, modelId: report.modelId });
    await store.audit(db, user.id, "deployment_audit.finished", { runId, detail: { ...base, decision: gate.decision } });
    ctx.send({ type: "done", agent: "sentinel", runId });
    return { runId, findings: all, gate };
  });
}

/* ------------------------------------------------------- Cloudflare review */

/**
 * Application Protection on Cloudflare (Workflow G): read-only review of up to five zones (or one chosen zone) and
 * their accounts' Access policies through the person's scoped API token. Areas the token can't read are listed as not
 * checked, and the audit says it's incomplete; their earlier findings are left as they were.
 */
export async function runCloudflareAudit(ctx: RunContext, input: { zone?: string | null }) {
  const { supabase: db, user } = ctx.auth;
  const runId = await store.startRun(db, user.id, { agent: "sentinel", action: "cloudflare", asset: input.zone ? zoneAsset(input.zone) : "cloudflare:all zones", scope: "passive", parentId: ctx.parentId });
  ctx.send({ type: "run", agent: "sentinel", runId });
  const steps = new Steps(ctx.send, "sentinel");
  return guarded(ctx, runId, "sentinel", steps, async () => {
    let t = steps.start("connect", "Cloudflare connection");
    const { ctx: cctx, row } = await requireService(ctx.auth, "cloudflare", ctx.signal);
    const wrap = (err: unknown) => (err instanceof ConnectorError ? new ApiError(err.kind === "auth" || err.kind === "permission" ? "forbidden" : "upstream_error", err.message) : err);
    const all = await listZones(cctx).catch((err) => {
      throw wrap(err);
    });
    const chosen = input.zone ? all.filter((z) => z.name === input.zone || z.id === input.zone) : all.filter((z) => z.status === "active").slice(0, 5);
    if (!chosen.length) throw new ApiError("not_found", input.zone ? `The token can't see the zone ${input.zone}.` : "The token can't see any active zones. Give it Zone: Read for the zones to check.");
    steps.finish("connect", "Cloudflare connection", "ok", `${row.account_label ?? "API token"}: ${all.length} zone(s) visible; checking ${chosen.map((z) => z.name).join(", ")}${!input.zone && all.length > chosen.length ? ` (the first ${chosen.length} active)` : ""}. Read-only.`, t);
    await store.audit(db, user.id, "cloudflare_review.started", { runId, detail: { zones: chosen.map((z) => z.name) } });

    const findings: FindingDraft[] = [];
    const snaps: ZoneSnapshot[] = [];
    for (const z of chosen) {
      t = steps.start(`zone-${z.id}`, `Zone ${z.name}`);
      const snap = await readZone(cctx, z).catch((err) => {
        throw wrap(err);
      });
      snaps.push(snap);
      const fs = zoneFindings(snap);
      findings.push(...fs);
      const gaps = coverageGaps(snap.coverage).filter((g) => g.area !== "access");
      steps.finish(
        `zone-${z.id}`,
        `Zone ${z.name}`,
        gaps.some((g) => g.area !== "events") ? "failed" : "ok",
        `${z.plan} plan · ${fs.length} finding(s)${gaps.length ? ` · not checked: ${gaps.map((g) => `${AREA_LABEL[g.area]}${g.fix ? ` (needs ${g.fix})` : ` (${g.status.replace("_", " ")})`}`).join("; ")}` : " · every area checked"}`,
        t,
      );
    }

    const accounts = [...new Map(chosen.filter((z) => z.accountId).map((z) => [z.accountId!, z.accountName ?? z.accountId!])).entries()];
    const accessResults: { id: string; name: string; status: string; apps: number; fix: string | null }[] = [];
    for (const [id, name] of accounts.slice(0, 3)) {
      t = steps.start(`access-${id}`, `Zero Trust Access · ${name}`);
      const r = await readAccess(cctx, id);
      if (r.ok) {
        const fs = accessFindings(name, r.value ?? []);
        findings.push(...fs);
        accessResults.push({ id, name, status: "checked", apps: r.value?.length ?? 0, fix: null });
        steps.finish(`access-${id}`, `Zero Trust Access · ${name}`, "ok", `${r.value?.length ?? 0} application(s), ${fs.length} finding(s). Policies are reviewed only; Orbis never changes them.`, t);
      } else {
        accessResults.push({ id, name, status: r.status, apps: 0, fix: r.status === "missing_permission" ? "Access: Apps and Policies Read" : null });
        steps.finish(`access-${id}`, `Zero Trust Access · ${name}`, r.status === "missing_permission" ? "skipped" : "failed", r.status === "missing_permission" ? "Not checked: the token needs Access: Apps and Policies Read." : `Not checked: ${r.detail}`, t);
      }
    }

    const saved = await store.saveFindings(db, user.id, runId, findings);
    let resolved = 0;
    for (const s of snaps) {
      const checked = (Object.keys(AREA_PREFIX) as Exclude<Area, "events">[]).filter((a) => s.coverage[a]?.status === "checked").map((a) => AREA_PREFIX[a]);
      resolved += await store.markNotDetected(db, user.id, runId, "sentinel", zoneAsset(s.zone.name), checked);
    }
    for (const a of accessResults.filter((x) => x.status === "checked")) resolved += await store.markNotDetected(db, user.id, runId, "sentinel", accountAsset(a.name), [AREA_PREFIX.access]);
    ctx.send({ type: "findings", agent: "sentinel", count: findings.length, bySeverity: countBy(findings), resolved, reopened: saved.reopened });

    const gaps = [
      ...snaps.flatMap((s) => coverageGaps(s.coverage).filter((g) => g.area !== "access" && g.area !== "events").map((g) => ({ scope: s.zone.name, ...g }))),
      ...accessResults.filter((a) => a.status !== "checked").map((a) => ({ scope: a.name, area: "access" as Area, status: a.status, fix: a.fix })),
    ];
    const complete = gaps.length === 0;
    const report = await writeReport(
      ctx,
      steps,
      "sentinel",
      `Cloudflare configuration review of ${chosen.map((z) => z.name).join(", ")} (read-only, via the person's API token). ${complete ? "Every area was checked." : `INCOMPLETE — not checked: ${gaps.map((g) => `${g.scope} ${AREA_LABEL[g.area]}`).join("; ")}.`} Unchecked areas must not be described as protected.`,
      findings,
    );
    const base = { findings: findings.length, bySeverity: countBy(findings), created: saved.created, resolved, reopened: saved.reopened, complete };
    const stats = fitStats({
      ...base,
      cloudflare: {
        zones: snaps.map((s) => ({
          name: s.zone.name,
          plan: s.zone.plan,
          status: s.zone.paused ? "paused" : s.zone.status,
          coverage: Object.fromEntries(Object.entries(s.coverage).filter(([a]) => a !== "access").map(([a, c]) => [a, c.status])),
          ssl: s.settings ? String(s.settings.ssl ?? "?") : null,
          alwaysHttps: s.settings ? String(s.settings.always_use_https ?? "?") : null,
          minTls: s.settings ? String(s.settings.min_tls_version ?? "?") : null,
          waf: s.phases.http_request_firewall_managed === undefined ? null : (s.phases.http_request_firewall_managed ?? []).filter((r) => r.enabled && r.executes && MANAGED_RULESETS[r.executes]).map((r) => MANAGED_RULESETS[r.executes!]!),
          customRules: s.phases.http_request_firewall_custom === undefined ? null : (s.phases.http_request_firewall_custom ?? []).filter((r) => r.enabled).length,
          rateLimits: s.phases.http_ratelimit === undefined ? null : (s.phases.http_ratelimit ?? []).filter((r) => r.enabled).length,
          ddos: s.phases.ddos_l7 === undefined ? null : s.phases.ddos_l7 == null ? "default" : `${s.phases.ddos_l7.length} override(s)`,
          botFightMode: s.bot?.fightMode ?? null,
          dnsOnly: s.dns ? s.dns.filter((d) => !d.proxied && (d.type === "A" || d.type === "AAAA" || d.type === "CNAME")).length : null,
          events: s.events?.slice(0, 10) ?? null,
        })),
        accounts: accessResults,
        gaps,
      },
    });
    await store.finishRun(db, runId, { status: "completed", summary: report.summary, tools: steps.tools, stats, modelId: report.modelId });
    await store.audit(db, user.id, "cloudflare_review.finished", { runId, detail: { ...base, gaps: gaps.length } });
    ctx.send({ type: "done", agent: "sentinel", runId });
    return { runId, findings, complete };
  });
}

/* ----------------------------------------------------------- Threat Hunter */

export async function runHunterAgent(ctx: RunContext, input: { logs: { name: string; content: string }[]; indicators: string; asset: string }) {
  const { supabase: db, user } = ctx.auth;
  await verifyParent(ctx);
  const asset = input.asset || (input.logs.length ? input.logs.map((l) => l.name).join(", ").slice(0, 120) : "Indicators");
  const runId = await store.startRun(db, user.id, { agent: "threat_hunter", action: "investigate", asset, parentId: ctx.parentId });
  ctx.send({ type: "run", agent: "threat_hunter", runId });
  const steps = new Steps(ctx.send, "threat_hunter");
  return guarded(ctx, runId, "threat_hunter", steps, async () => {
    await store.audit(db, user.id, "investigation.started", { runId, detail: { files: input.logs.map((l) => ({ name: l.name, bytes: l.content.length })), indicators: input.indicators.length > 0 } });
    let analysis: Analysis | null = null;
    if (input.logs.length) {
      const t = steps.start("parse", "Parse & inventory sources");
      analysis = analyseLogs(input.logs, asset);
      const inv = analysis.parsed.inventory;
      const formats = [...new Set(inv.flatMap((f) => Object.keys(f.formats)))].map((k) => SOURCE_LABEL[k as SourceKind] ?? k);
      if (!analysis.parsed.events.length)
        steps.finish("parse", "Parse & inventory sources", "failed", `No supported log lines found (${inv.reduce((n, f) => n + f.unparsed, 0)} lines skipped). Supported: ${Object.values(SOURCE_LABEL).join("; ")}.`, t);
      else {
        steps.finish("parse", "Parse & inventory sources", "ok", `${analysis.parsed.events.length} events from ${inv.length} file(s): ${formats.join(", ")}; ${inv.reduce((n, f) => n + f.unparsed, 0)} lines not recognised`, t);
        const d = steps.start("detect", "Detection library");
        steps.finish("detect", "Detection library", "ok", `${HUNT_RULES.length} rules; ${analysis.findings.length} signal(s)`, d);
        ctx.send({ type: "timeline", agent: "threat_hunter", entries: analysis.timeline.slice(0, 100) });
      }
    }

    // Enrichment: third-party reputation for addresses (context, never proof).
    const pasted = parseIndicators(input.indicators);
    if (pasted.invalid.length) ctx.send({ type: "notice", agent: "threat_hunter", text: `Ignored ${pasted.invalid.length} value(s) that aren't IPs, domains or URLs.` });
    const ips = [...new Set([...pasted.ips, ...(analysis?.indicators ?? [])])];
    const key = (process.env.ABUSEIPDB_API_KEY ?? "").trim();
    const seen = (ip: string) => analysis?.parsed.events.filter((e) => e.ip === ip).length ?? 0;
    const intel: IndicatorRecord[] = [];
    const repFindings: FindingDraft[] = [];
    let reputation: IpReputation[] = [];
    if (ips.length) {
      if (!key) {
        steps.finish("reputation", "IP reputation", "skipped", "No reputation service connected (add ABUSEIPDB_API_KEY). Addresses were not enriched.");
        for (const ip of ips.slice(0, 15)) intel.push(uncheckedRecord("ip", ip, "No IP reputation service is connected.", seen(ip)));
      } else {
        const t = steps.start("reputation", "IP reputation");
        const rep = await abuseIpLookup(ips, key, { signal: ctx.signal });
        reputation = rep.results;
        repFindings.push(...reputationFindings(rep.results, asset));
        for (const r of rep.results) intel.push(ipRecord(r, seen(r.ip)));
        for (const ip of rep.failed) intel.push(uncheckedRecord("ip", ip, "The lookup failed.", seen(ip)));
        steps.finish("reputation", "IP reputation", rep.results.length ? "ok" : "failed", `${rep.results.length} looked up${rep.failed.length ? `, ${rep.failed.length} failed` : ""}${ips.length > 15 ? " (first 15 only)" : ""}`, t);
      }
    }
    if (pasted.domains.length || pasted.urls.length) {
      steps.finish("domains", "Domain & URL reputation", "skipped", "No domain or URL reputation service is connected yet, so these weren't checked.");
      for (const d of pasted.domains.slice(0, 10)) intel.push(uncheckedRecord("domain", d, "No domain reputation service is connected."));
      for (const u of pasted.urls.slice(0, 10)) intel.push(uncheckedRecord("url", u, "No URL reputation service is connected."));
    }
    // Rebuild investigations with reputation context when there is any (cheap: pure, in-memory).
    if (analysis && reputation.length) analysis = analyseLogs(input.logs, asset, { reputation });

    const findings = [...(analysis?.findings ?? []), ...repFindings];
    const saved = await store.saveFindings(db, user.id, runId, findings);
    ctx.send({ type: "findings", agent: "threat_hunter", count: findings.length, bySeverity: countBy(findings) });

    // Investigations: signals point at saved finding ids; link earlier investigations that share entities.
    let investigations: Investigation[] = [];
    if (analysis) {
      const t = steps.start("investigate", "Investigations");
      const earlier = (await store.listRuns(db, user.id, 40))
        .filter((r) => r.agent === "threat_hunter" && r.id !== runId && Array.isArray(r.stats.investigations))
        .map((r) => ({ runId: r.id, at: r.started_at, investigations: r.stats.investigations as Investigation[] }));
      investigations = analysis.investigations.map((i) => {
        const withIds = { ...i, signals: i.signals.map((s) => ({ ...s, id: saved.ids.get(s.id) ?? s.id })) };
        return { ...withIds, prior: relatedPrior(withIds, earlier) };
      });
      const likely = investigations.filter((i) => i.state === "likely_malicious").length;
      steps.finish("investigate", "Investigations", "ok", `${investigations.length} investigation(s)${likely ? `, ${likely} likely malicious` : ""}; ${analysis.shared.length} shared address(es) not used to link signals`, t);
    }

    let summary: string | null = null;
    let modelId: string | null = null;
    let qa: QaIssue[] = [];
    const t = steps.start("report", "Investigation report");
    try {
      const sections = analysis ? huntSections({ ...analysis, investigations }, intel) : `No logs analysed. Indicators checked: ${intel.map((r) => `${r.value}: ${r.rating ?? "not checked"}`).join("; ") || "none"}.`;
      const r = await aiText(ctx, { defaultMode: "deep", messages: huntReportMessages(sections), purpose: "security", prompt: `[threat hunt] ${asset}`, maxOutputTokens: 2400 });
      if ("skipped" in r) steps.finish("report", "Investigation report", "skipped", r.skipped, t);
      else {
        summary = r.text;
        modelId = r.modelId;
        // Quality check: unsupported attribution, overconfidence and claims about data Orbis never saw.
        qa = qaCheck(r.text, investigations, sections);
        ctx.send({ type: "report", text: r.text });
        steps.finish("report", "Investigation report", "ok", `Written by ${r.modelName}${qa.length ? `; quality check flagged ${qa.length} statement(s)` : "; quality check passed"}`, t);
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      steps.finish("report", "Investigation report", "failed", err instanceof ApiError ? err.message : "The AI model call failed; the investigations are still saved.", t);
    }

    const runStats = fitHuntStats({
      ...(analysis?.stats ?? {}),
      findings: findings.length,
      bySeverity: countBy(findings),
      created: saved.created,
      inventory: analysis?.parsed.inventory ?? [],
      baselines: analysis?.baselines ?? null,
      sharedAddresses: analysis?.shared ?? [],
      investigations,
      intel,
      qa,
      timeline: analysis?.timeline ?? [],
    });
    await store.finishRun(db, runId, { status: "completed", summary, tools: steps.tools, stats: runStats, modelId });
    await store.audit(db, user.id, "investigation.finished", { runId, detail: { findings: findings.length, investigations: investigations.length } });
    ctx.send({ type: "done", agent: "threat_hunter", runId });
    return { runId, findings };
  });
}

/* ----------------------------------------------------------- Code Guardian */

export async function runGuardianAgent(
  ctx: RunContext,
  input: { source: { type: "upload"; files: SourceFile[] } | { type: "github"; repo: string } | { type: "github_pr"; repo: string; number: number }; asset: string; aiReview: boolean; proposeFixes: boolean },
) {
  const { supabase: db, user } = ctx.auth;
  const cfg = await verifyParent(ctx);
  // Quick scans and the release gate don't use AI judgement for code findings.
  if (cfg && !MODE_INFO[cfg.mode].aiReview) input = { ...input, aiReview: false };
  const runId = await store.startRun(db, user.id, {
    agent: "code_guardian",
    action: input.source.type === "github_pr" ? "pr_audit" : "audit",
    asset: input.source.type === "github" ? `github:${input.source.repo}` : input.source.type === "github_pr" ? prAsset(input.source.repo, input.source.number) : input.asset || "Uploaded code",
    parentId: ctx.parentId,
  });
  ctx.send({ type: "run", agent: "code_guardian", runId });
  const steps = new Steps(ctx.send, "code_guardian");
  return guarded(ctx, runId, "code_guardian", steps, async () => {
    let files: SourceFile[];
    let asset: string;
    let pr: PrInfo | null = null;
    if (input.source.type === "github_pr") {
      const t = steps.start("fetch", "Pull request");
      const { token, via } = await githubReadToken(ctx.auth, ctx.signal);
      pr = await fetchPullRequest(input.source.repo, input.source.number, { token, signal: ctx.signal }).catch((e: Error) => {
        throw new ApiError("bad_request", e.message);
      });
      // The whole repository at the pull request's head, so changed code is read in context. Nothing is executed.
      const repo = await fetchRepoFiles(`${input.source.repo}/tree/pull/${input.source.number}/head`, { token, signal: ctx.signal }).catch((e: Error) => {
        throw new ApiError("bad_request", e.message);
      });
      files = repo.files;
      asset = prAsset(input.source.repo, input.source.number);
      steps.finish(
        "fetch",
        "Pull request",
        "ok",
        `#${pr.number} (${pr.state}${pr.draft ? ", draft" : ""}) ${pr.headRef} → ${pr.baseRef} at ${pr.headSha.slice(0, 7)}: ${pr.files.length} changed file(s)${pr.filesTruncated ? " (GitHub listed only the first 300)" : ""}; ${repo.files.length} repository files read for context · ${via === "connection" ? "with your GitHub connection" : via === "site_token" ? "with the site's GitHub token (administrator)" : "anonymously (public repository)"}`,
        t,
      );
    } else if (input.source.type === "github") {
      const t = steps.start("fetch", "GitHub snapshot");
      const { token, via } = await githubReadToken(ctx.auth, ctx.signal);
      const repo = await fetchRepoFiles(input.source.repo, { token, signal: ctx.signal }).catch((e: Error) => {
        throw new ApiError("bad_request", e.message);
      });
      files = repo.files;
      asset = `github:${repo.label}`;
      steps.finish("fetch", "GitHub snapshot", "ok", `${repo.files.length} files at ${repo.ref}${repo.truncated ? " (size limit reached; some files skipped)" : ""} · read ${via === "connection" ? "with your GitHub connection" : via === "site_token" ? "with the site's GitHub token (administrator)" : "anonymously (public repository)"}`, t);
    } else {
      files = input.source.files;
      asset = input.asset || "Uploaded code";
    }
    await store.audit(db, user.id, "audit.started", { runId, detail: { asset, files: files.length, aiReview: input.aiReview, proposeFixes: input.proposeFixes } });

    let t = steps.start("rules", "Code & secret rules");
    const rules = runCodeRules(files, asset);
    steps.finish("rules", "Code & secret rules", "ok", `${rules.filesScanned} files, ${rules.linesScanned.toLocaleString("en-US")} lines, ${rules.findings.length} findings`, t);
    const findings: FindingDraft[] = [...rules.findings];
    const checked = ["secret.", "code.", "py.", "php.", "map.", "config."];

    t = steps.start("map", "Application map");
    const map = mapCode(files);
    const mapFindings = codeMapFindings(map, files, asset);
    findings.push(...mapFindings);
    steps.finish(
      "map",
      "Application map",
      "ok",
      `${map.routes.length} routes${map.serverActions.length ? `, ${map.serverActions.length} server-action files` : ""}, ${map.configFiles.length} config files, ${map.boundaries.length} trust boundaries; ${mapFindings.length} findings`,
      t,
    );

    // Engineering analysis: defects, dependency compatibility, maintainability (kept apart from security counts).
    t = steps.start("engineering", "Engineering analysis");
    const complete = input.source.type === "github";
    const eng = analyseEngineering(files, asset, { completeSnapshot: complete });
    const engCounts = countFindings(eng.findings.map((f) => f.ruleId));
    checked.push("quality.", "compat.", "arch.");
    steps.finish(
      "engineering",
      "Engineering analysis",
      "ok",
      `${eng.summary.graph.modules} modules mapped; ${engCounts.defects} defect(s), ${engCounts.dependencies} dependency issue(s), ${engCounts.maintainability} maintainability note(s). Nothing executed: tests and builds weren't run.`,
      t,
    );

    const manifests = parseManifests(files);
    for (const n of manifests.notes) ctx.send({ type: "notice", agent: "code_guardian", text: n });
    if (manifests.packages.length) {
      t = steps.start("deps", "OSV dependency check");
      try {
        const deps = await checkDependencies(manifests.packages, asset, { signal: withTimeout(25_000, ctx.signal) });
        findings.push(...deps.findings);
        checked.push("deps.");
        steps.finish("deps", "OSV dependency check", "ok", `${deps.queried} packages checked, ${deps.vulnerable} with known vulnerabilities${deps.detailsSkipped ? ` (${deps.detailsSkipped} advisories not expanded)` : ""}`, t);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        steps.finish("deps", "OSV dependency check", "failed", `OSV.dev couldn't be reached: ${(err as Error).message}`.slice(0, 300), t);
      }
    } else {
      steps.finish("deps", "OSV dependency check", "skipped", "No package-lock.json, yarn.lock, package.json or requirements.txt found.");
    }

    if (input.aiReview) {
      const changedPaths = pr ? new Set(pr.files.filter((x) => x.status !== "removed").map((x) => x.path)) : null;
      const chosen = selectFilesForReview(changedPaths ? files.filter((x) => changedPaths.has(x.path)) : files);
      if (!chosen.length) steps.finish("ai-review", "AI code review", "skipped", "No source files suitable for review.");
      else {
        t = steps.start("ai-review", "AI code review");
        try {
          const r = await aiText(ctx, { defaultMode: "coding", messages: aiReviewMessages(chosen), purpose: "security", prompt: `[code review] ${asset}`, maxOutputTokens: 3500 });
          if ("skipped" in r) steps.finish("ai-review", "AI code review", "skipped", r.skipped, t);
          else {
            const parsed = parseAiReview(r.text, chosen, asset);
            const known = new Set(findings.map((f) => f.location));
            const extra = parsed.findings.filter((f) => !known.has(f.location));
            findings.push(...extra);
            steps.finish("ai-review", "AI code review", parsed.error ? "failed" : "ok", parsed.error ?? `${r.modelName} reviewed ${chosen.length} files: ${extra.length} kept, ${parsed.rejected} discarded (quoted code not found)`, t);
          }
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          steps.finish("ai-review", "AI code review", "failed", err instanceof ApiError ? err.message : "The AI model call failed.", t);
        }
      }
    }

    // A pull request: keep what the change touches, and say whether each finding is on a line it adds.
    let prStats: Record<string, unknown> | null = null;
    if (pr) {
      const sec = scopeToPr(findings, pr.files);
      const engScoped = scopeToPr(eng.findings, pr.files);
      findings.length = 0;
      for (const k of sec.kept) findings.push({ ...k.finding, evidence: [prEvidence(pr, k.introduced), ...k.finding.evidence] });
      eng.findings = engScoped.kept.map((k) => ({ ...k.finding, evidence: [prEvidence(pr!, k.introduced), ...k.finding.evidence] }));
      const introduced = sec.kept.filter((k) => k.introduced).length;
      prStats = {
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        headSha: pr.headSha,
        headRef: pr.headRef.slice(0, 120),
        baseRef: pr.baseRef.slice(0, 120),
        state: pr.state,
        changedFiles: pr.files.length,
        filesTruncated: pr.filesTruncated,
        patchesMissing: pr.files.filter((x) => x.patchMissing).length,
        introduced,
        existing: sec.kept.length - introduced,
        outsideChange: sec.dropped,
      };
      ctx.send({ type: "notice", agent: "code_guardian", text: `Pull request scope: ${sec.kept.length} finding(s) in changed files (${introduced} on added lines); ${sec.dropped} elsewhere in the repository not counted here.` });
    }

    // Phase 4 — independent verification of serious, not-yet-certain code findings (AI audits only).
    let disproven: string[] = [];
    let verifyStats: Record<string, unknown> | null = null;
    {
      const cands = selectForVerification(findings, files);
      if (!input.aiReview) steps.finish("verify", "Independent verification", "skipped", cands.length ? `${cands.length} finding(s) stay "needs verification": this audit mode doesn't use AI.` : "Nothing to verify.");
      else if (!cands.length) steps.finish("verify", "Independent verification", "skipped", "No medium-or-worse findings needed a second look.");
      else {
        t = steps.start("verify", "Independent verification");
        try {
          const r = await aiText(ctx, { defaultMode: "coding", messages: verificationMessages(cands), purpose: "security", prompt: `[verification] ${asset}`, maxOutputTokens: 1800 });
          if ("skipped" in r) steps.finish("verify", "Independent verification", "skipped", r.skipped, t);
          else {
            const results = parseVerification(r.text, cands);
            const applied = applyVerification(findings, cands, results, r.modelName);
            disproven = applied.disproven;
            verifyStats = { model: r.modelName, ...applied.counts };
            const c = applied.counts;
            steps.finish("verify", "Independent verification", "ok", `${r.modelName} challenged ${cands.length}: ${c.confirmed} confirmed, ${c.likely} likely, ${c.unverified} unverified, ${c.disproven} disproven (marked false positive; you can reopen them). Static reading only; nothing was run.`, t);
          }
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          steps.finish("verify", "Independent verification", "failed", err instanceof ApiError ? err.message : "The verification call failed; findings keep their original status.", t);
        }
      }
    }

    // Security findings first: the store keeps at most 400 per run.
    const saved = await store.saveFindings(db, user.id, runId, [...findings, ...eng.findings]);
    if (disproven.length) {
      await db.from("security_findings").update({ status: "false_positive", verification_note: "Disproven by independent verification (see evidence). Reopen it if you disagree." }).eq("user_id", user.id).in("fingerprint", disproven).eq("status", "open");
      await store.audit(db, user.id, "verification.disproven", { runId, detail: { count: disproven.length } });
    }
    // Only compare against earlier audits of the same named source; unnamed uploads may be unrelated projects.
    const named = input.source.type === "github" || input.source.type === "github_pr" || !!input.asset;
    const resolved = named ? await store.markNotDetected(db, user.id, runId, "code_guardian", asset, checked, pr ? { prefix: "", covers: prCovers(pr.files) } : undefined) : 0;
    ctx.send({ type: "findings", agent: "code_guardian", count: findings.length, bySeverity: countBy(findings), resolved, reopened: saved.reopened });

    t = steps.start("memory", "Regression memory");
    let memory: MemorySummary | null = null;
    try {
      const { data: rows } = await db
        .from("security_findings")
        .select("fingerprint,rule_id,title,location,status,occurrences,first_seen,last_run_id")
        .eq("user_id", user.id)
        .eq("agent", "code_guardian")
        .eq("asset", asset)
        .limit(1000);
      const prev = named ? (await store.listRuns(db, user.id, 40)).find((r) => r.agent === "code_guardian" && r.asset === asset && r.id !== runId && r.status === "completed") : undefined;
      const prevCounts = (prev?.stats.guardian as { memory?: { counts?: Counts } } | undefined)?.memory?.counts;
      memory = buildMemory({ rows: (rows ?? []) as StoredFindingRow[], runId, reopened: saved.reopenedFingerprints, resolvedThisScan: resolved, previous: prev && prevCounts ? { at: prev.started_at, counts: prevCounts } : null });
      steps.finish(
        "memory",
        "Regression memory",
        "ok",
        named
          ? `${memory.regressions.length} regression(s) (fixed before, found again), ${resolved} finding(s) no longer detected, ${memory.fragile.length} fragile file(s)${memory.previous ? "; compared with the previous scan" : "; first scan of this source"}`
          : "Unnamed upload: not compared with earlier scans (it may be a different project).",
        t,
      );
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      steps.finish("memory", "Regression memory", "failed", "History couldn't be read; this scan's results are saved.", t);
    }

    if (input.proposeFixes) {
      const byPath = new Map(files.map((f) => [f.path, f]));
      const candidates = findings
        .filter((f) => f.ruleId !== "deps.osv" && f.location && (f.severity === "critical" || f.severity === "high" || f.severity === "medium"))
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
        .slice(0, 3)
        .map((f, i) => {
          const [path, line] = [f.location!.slice(0, f.location!.lastIndexOf(":")), Number(f.location!.slice(f.location!.lastIndexOf(":") + 1))];
          return { n: i + 1, f, file: byPath.get(path), line };
        })
        .filter((c) => c.file);
      if (!candidates.length) steps.finish("fixes", "Proposed fixes", "skipped", "No code findings of medium severity or above to fix.");
      else {
        t = steps.start("fixes", "Proposed fixes");
        try {
          const r = await aiText(ctx, {
            defaultMode: "coding",
            messages: fixMessages(candidates.map((c) => ({ n: c.n, title: c.f.title, location: c.f.location!, description: c.f.description, remediation: c.f.remediation, file: c.file!, line: c.line }))),
            purpose: "security",
            prompt: `[fix proposals] ${asset}`,
            maxOutputTokens: 4000,
          });
          if ("skipped" in r) steps.finish("fixes", "Proposed fixes", "skipped", r.skipped, t);
          else {
            const fixes = parseFixes(r.text);
            let attached = 0;
            for (const fx of fixes) {
              const c = candidates.find((x) => x.n === fx.n);
              const id = c && saved.ids.get(c.f.fingerprint);
              if (!id || !fx.patch) continue;
              await db
                .from("security_findings")
                .update({ patch: fx.patch, tests: [fx.test, fx.notes && `Notes: ${fx.notes}`].filter(Boolean).join("\n\n") || null, status: "fix_proposed" })
                .eq("id", id)
                .in("status", ["open", "investigating", "fix_proposed"]);
              await store.audit(db, user.id, "patch.proposed", { runId, findingId: id, detail: { model: r.modelId } });
              attached++;
            }
            steps.finish("fixes", "Proposed fixes", attached ? "ok" : "failed", attached ? `${attached} patch(es) proposed by ${r.modelName} — not applied, not tested` : "The model didn't return usable patches.", t);
          }
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          steps.finish("fixes", "Proposed fixes", "failed", err instanceof ApiError ? err.message : "The AI model call failed.", t);
        }
      }
    }

    const report = await writeReport(
      ctx,
      steps,
      "code_guardian",
      `Code audit of ${asset}: ${rules.filesScanned} files scanned with rules; ${map.routes.length} routes mapped (frameworks: ${map.frameworks.join(", ") || "none recognised"}); dependencies: ${manifests.packages.length} packages. Route findings marked tentative come from reading code, not from running it. Engineering findings (defects, dependency compatibility, maintainability: ${engCounts.defects}/${engCounts.dependencies}/${engCounts.maintainability}) are reported separately in the Code Guardian workspace and aren't part of this security report.`,
      findings,
    );
    const base = {
      findings: findings.length,
      engineeringFindings: eng.findings.length,
      engineering: pr ? countFindings(eng.findings.map((f) => f.ruleId)) : engCounts,
      ...(verifyStats ? { verification: verifyStats } : {}),
      bySeverity: countBy(findings),
      files: rules.filesScanned,
      lines: rules.linesScanned,
      packages: manifests.packages.length,
      created: saved.created,
      resolved,
      reopened: saved.reopened,
      routes: map.routes.length,
    };
    const guardian = fitGuardianSummary({ ...eng.summary, memory }, 8_500);
    const stats = fitStats({ ...base, ...(prStats ? { pr: prStats } : {}), codeMap: compactMap(map), guardian });
    await store.finishRun(db, runId, { status: "completed", summary: report.summary, tools: steps.tools, stats, modelId: report.modelId });
    await store.audit(db, user.id, "audit.finished", { runId, detail: base });
    ctx.send({ type: "done", agent: "code_guardian", runId });
    return { runId, findings };
  });
}

/* ----------------------------------------------------- Coordinated report */

export async function runCoordinatedReport(ctx: RunContext, parentId: string) {
  const { supabase: db, user } = ctx.auth;
  const { run, children } = await store.getRun(db, user.id, parentId);
  if (run.agent !== "coordinated") throw new ApiError("bad_request", "Not a coordinated investigation.");
  const steps = new Steps(ctx.send, "coordinated");
  return guarded(ctx, parentId, "coordinated", steps, async () => {
    const childFindings = (await Promise.all(children.map((c) => store.listFindings(db, user.id, { runId: c.id, includeDuplicates: true, scope: "security" })))).flat();
    let t = steps.start("correlate", "Correlate findings");
    const links = correlate(childFindings);
    await store.linkRelated(db, links.pairs);
    steps.finish("correlate", "Correlate findings", "ok", `${links.pairs.length} link(s) between agents' findings`, t);

    const plan = (run.stats.plan as string[] | undefined) ?? [];
    const cfg = auditConfig.safeParse(run.stats.audit);
    if (cfg.success) return finishAudit(ctx, steps, run, children, plan, cfg.data, links);
    const sections = plan
      .map((agent) => {
        const c = children.filter((x) => x.agent === agent).pop();
        if (!c) return `### ${agentDef(agent)?.name ?? agent}\nNot run (skipped by the user or not started).`;
        const fs = childFindings.filter((f) => f.last_run_id === c.id || f.run_id === c.id);
        return `### ${agentDef(agent)?.name ?? agent}\nStatus: ${c.status}${c.error ? ` (${c.error})` : ""}. Asset: ${c.asset}. Tools: ${c.tools.map((x) => `${x.tool}=${x.status}`).join(", ")}.\n${compactFindings(fs.map((f) => ({ ...f, ruleId: f.rule_id, evidenceSource: f.evidence_source })), 25)}`;
      })
      .join("\n\n");
    let summary: string | null = null;
    let modelId: string | null = null;
    t = steps.start("report", "Unified report");
    try {
      const r = await aiText(ctx, { defaultMode: "deep", messages: unifiedReportMessages(`${sections}\n\nCorrelations found by rules:\n${links.notes.join("\n") || "none"}`), purpose: "security", prompt: "[coordinated report]", maxOutputTokens: 2200 });
      if ("skipped" in r) steps.finish("report", "Unified report", "skipped", r.skipped, t);
      else {
        summary = r.text;
        modelId = r.modelId;
        ctx.send({ type: "report", text: r.text });
        steps.finish("report", "Unified report", "ok", `Written by ${r.modelName}`, t);
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      steps.finish("report", "Unified report", "failed", err instanceof ApiError ? err.message : "The AI model call failed.", t);
    }
    const failed = children.filter((c) => c.status !== "completed").length;
    const stats = { ...run.stats, findings: childFindings.length, links: links.pairs.length, linkNotes: links.notes.slice(0, 30), childFailures: failed };
    await store.finishRun(db, parentId, { status: "completed", summary, tools: steps.tools, stats, modelId });
    await store.audit(db, user.id, "coordinated.finished", { runId: parentId, detail: { findings: childFindings.length, links: links.pairs.length } });
    ctx.send({ type: "done", agent: "coordinated", runId: parentId });
  });
}

/* ------------------------------------------------------ Sentinel audit report */

async function finishAudit(ctx: RunContext, steps: Steps, run: store.RunRow, children: store.RunRow[], plan: string[], cfg: AuditConfig, links: { pairs: [string, string][]; notes: string[] }) {
  const { supabase: db, user } = ctx.auth;
  const parentId = run.id;
  let t = steps.start("analyse", "Attack paths, coverage" + (cfg.mode === "release_gate" ? " & gate" : ""));
  // Re-read after linking so classifications see the new cross-source links.
  const findings = (await Promise.all(children.map((c) => store.listFindings(db, user.id, { runId: c.id, scope: "security" })))).flat();
  const unique = [...new Map(findings.map((f) => [f.id, f])).values()];
  const assets = [...new Set(children.map((c) => c.asset).filter((a): a is string => !!a))];
  const childIds = new Set(children.map((c) => c.id));
  const earlier = (await Promise.all(assets.map((asset) => store.listFindings(db, user.id, { asset, scope: "security" })))).flat();
  const notRechecked = earlier.filter((f) => !childIds.has(f.last_run_id ?? "") && ["open", "investigating", "fix_proposed"].includes(f.status)).length;
  const previous = (await store.listRuns(db, user.id, 60)).find(
    (r) => r.id !== parentId && r.agent === "coordinated" && r.action === run.action && r.asset === run.asset && r.status === "completed" && r.stats.posture,
  );
  const analysis = analyseAudit({
    cfg,
    plan,
    children: children.map((c) => ({ id: c.id, agent: c.agent, status: c.status, error: c.error, tools: c.tools, stats: c.stats })),
    findings: unique,
    notRechecked,
    previous: previous ? { runId: previous.id, at: previous.started_at, stats: previous.stats } : null,
  });
  const gateText = analysis.gate ? ` Gate: ${analysis.gate.outcome}.` : "";
  steps.finish(
    "analyse",
    "Attack paths, coverage" + (cfg.mode === "release_gate" ? " & gate" : ""),
    "ok",
    `${analysis.paths.length} attack path(s); ${analysis.coverage.filter((c) => c.state !== "not_assessed").length} of ${analysis.coverage.length} areas assessed.${gateText}`,
    t,
  );
  ctx.send({ type: "audit", analysis: compactAnalysis(analysis) });

  let summary: string | null = null;
  let modelId: string | null = null;
  t = steps.start("report", "Audit report");
  try {
    const r = await aiText(ctx, {
      defaultMode: "deep",
      messages: auditReportMessages(MODE_INFO[cfg.mode].label, `${auditSections(analysis, unique, children, plan)}\n\nCross-source links:\n${links.notes.join("\n") || "none"}`),
      purpose: "security",
      prompt: `[audit report] ${cfg.mode}`,
      maxOutputTokens: 2600,
    });
    if ("skipped" in r) steps.finish("report", "Audit report", "skipped", r.skipped, t);
    else {
      summary = r.text;
      modelId = r.modelId;
      ctx.send({ type: "report", text: r.text });
      steps.finish("report", "Audit report", "ok", `Written by ${r.modelName}`, t);
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    steps.finish("report", "Audit report", "failed", err instanceof ApiError ? err.message : "The AI model call failed; the analysis above is still saved.", t);
  }
  const failed = children.filter((c) => c.status !== "completed").length;
  const stats = fitAudit({ ...run.stats, findings: unique.length, links: links.pairs.length, linkNotes: links.notes.slice(0, 20), childFailures: failed, ...compactAnalysis(analysis) });
  await store.finishRun(db, parentId, { status: "completed", summary, tools: steps.tools, stats, modelId });
  await store.audit(db, user.id, "audit_mode.finished", { runId: parentId, detail: { mode: cfg.mode, findings: unique.length, paths: analysis.paths.length, gate: analysis.gate?.outcome ?? null } });
  ctx.send({ type: "done", agent: "coordinated", runId: parentId });
}

/** Keep the audit record within the stats limit: drop path step text first, then paths beyond the top five. */
function fitAudit(stats: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(stats).length <= 19_000) return stats;
  const paths = (stats.paths as StoredAnalysis["paths"]) ?? [];
  let out = { ...stats, paths: paths.map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s, text: s.text.slice(0, 120) })) })), linkNotes: [] };
  if (JSON.stringify(out).length <= 19_000) return out;
  out = { ...out, paths: out.paths.slice(0, 5) };
  if (JSON.stringify(out).length <= 19_000) return out;
  return { ...out, coverage: (stats.coverage as StoredAnalysis["coverage"]).map((c) => ({ ...c, checked: c.checked.slice(0, 3), notChecked: c.notChecked.slice(0, 3) })) };
}
