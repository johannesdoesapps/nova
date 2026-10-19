import "server-only";
import { getProvider, resolveModelChoice, withTimeout } from "../ai";
import { estimateTokens } from "../ai/cost";
import { autoIdFor } from "../ai/platform";
import type { ChatMessage } from "../ai/types";
import { isAdmin } from "../admin";
import type { AuthContext } from "../auth";
import * as store from "../db/security";
import { ApiError, clientIp } from "../http";
import { limiter } from "../rate-limit";
import { enforceLimits, recordRun } from "../usage";
import { agentDef } from "./agents";
import { proveOwnership } from "./authz";
import { runCodeRules, type SourceFile } from "./code-rules";
import { correlate } from "./correlate";
import { checkDependencies, parseManifests } from "./deps";
import { fetchRepoFiles } from "./github";
import { huntThreats, parseIndicators, parseLogs, type TimelineEntry } from "./logs";
import { normalizeHost } from "./net";
import { aiReviewMessages, compactFindings, fixMessages, parseAiReview, parseFixes, reportMessages, selectFilesForReview, unifiedReportMessages } from "./prompts";
import { abuseIpLookup, reputationFindings } from "./reputation";
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

async function verifyParent(ctx: RunContext) {
  if (!ctx.parentId) return;
  const parent = await store.getRunRow(ctx.auth.supabase, ctx.auth.user.id, ctx.parentId);
  if (parent.agent !== "coordinated" || parent.status !== "running") throw new ApiError("bad_request", "That coordinated investigation isn't running.");
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
  const choice = await resolveModelChoice(ctx.modelId ?? autoIdFor(opts.defaultMode), { prompt: opts.prompt, needs: ["reasoning"] }).catch(
    () => resolveModelChoice(ctx.modelId ?? autoIdFor(opts.defaultMode), { prompt: opts.prompt }),
  );
  const model = choice.model;
  if (model.provider === "demo") return { skipped: "No AI model is configured, so results are shown without an AI explanation." };
  await enforceLimits(ctx.req, ctx.auth, 1, [model]);
  const started = performance.now();
  const r = await getProvider(model.provider).generate({ model, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens, temperature: 0.2, signal: withTimeout(40_000, ctx.signal) });
  void recordRun(ctx.auth, {
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

export async function runSentinelAgent(ctx: RunContext, input: { targetId: string; scope: SentinelScope }) {
  const { supabase: db, user } = ctx.auth;
  await verifyParent(ctx);
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

    t = steps.start("scan", input.scope === "active" ? "Header, config & exposure checks" : "Header & config checks");
    const result = await runSentinel(host, input.scope, { signal: ctx.signal, progress: (s) => ctx.send({ type: "progress", agent: "sentinel", text: s }) });
    steps.finish("scan", input.scope === "active" ? "Header, config & exposure checks" : "Header & config checks", "ok", `${result.requests} requests, ${result.findings.length} findings`, t);
    for (const n of result.notes) ctx.send({ type: "notice", agent: "sentinel", text: n });

    const saved = await store.saveFindings(db, user.id, runId, result.findings);
    const resolved = await store.markNotDetected(db, user.id, runId, "sentinel", host, result.checked);
    ctx.send({ type: "findings", agent: "sentinel", count: result.findings.length, bySeverity: countBy(result.findings), resolved, reopened: saved.reopened });

    const report = await writeReport(ctx, steps, "sentinel", `Website ${host}, scope ${input.scope}. ${result.requests} HTTP requests made. Notes: ${result.notes.join(" ") || "none"}.`, result.findings);
    const stats = { findings: result.findings.length, bySeverity: countBy(result.findings), requests: result.requests, created: saved.created, resolved, reopened: saved.reopened };
    await store.finishRun(db, runId, { status: "completed", summary: report.summary, tools: steps.tools, stats, modelId: report.modelId });
    await store.audit(db, user.id, "scan.finished", { runId, detail: stats });
    ctx.send({ type: "done", agent: "sentinel", runId });
    return { runId, findings: result.findings };
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
    const findings: FindingDraft[] = [];
    let timeline: TimelineEntry[] = [];
    let stats: Record<string, unknown> = {};
    let indicators: string[] = [];

    if (input.logs.length) {
      const t = steps.start("parse", "Log analyzer");
      const parsed = parseLogs(input.logs);
      if (!parsed.events.length) {
        steps.finish("parse", "Log analyzer", "failed", `No supported log lines found (${parsed.unparsed} lines skipped). Supported: web access logs, SSH auth logs, JSON lines.`, t);
      } else {
        const hunt = huntThreats(parsed.events, asset);
        findings.push(...hunt.findings);
        timeline = hunt.timeline;
        indicators = hunt.indicators;
        stats = { ...hunt.stats, unparsedLines: parsed.unparsed, formats: parsed.formats };
        steps.finish("parse", "Log analyzer", "ok", `${parsed.events.length} events parsed (${parsed.unparsed} lines skipped), ${hunt.findings.length} detections`, t);
        ctx.send({ type: "timeline", agent: "threat_hunter", entries: timeline.slice(0, 100) });
      }
    }

    const pasted = parseIndicators(input.indicators);
    if (pasted.invalid.length) ctx.send({ type: "notice", agent: "threat_hunter", text: `Ignored ${pasted.invalid.length} value(s) that aren't IPs, domains or URLs.` });
    const ips = [...new Set([...pasted.ips, ...indicators])];
    const key = (process.env.ABUSEIPDB_API_KEY ?? "").trim();
    if (ips.length) {
      if (!key) {
        steps.finish("reputation", "IP reputation", "skipped", "No reputation service connected (add ABUSEIPDB_API_KEY). Indicators were not enriched.");
      } else {
        const t = steps.start("reputation", "IP reputation");
        const rep = await abuseIpLookup(ips, key, { signal: ctx.signal });
        findings.push(...reputationFindings(rep.results, asset));
        steps.finish("reputation", "IP reputation", rep.results.length ? "ok" : "failed", `${rep.results.length} looked up${rep.failed.length ? `, ${rep.failed.length} failed` : ""}${ips.length > 15 ? " (first 15 only)" : ""}`, t);
        stats = { ...stats, reputation: rep.results };
      }
    }
    if (pasted.domains.length || pasted.urls.length) {
      steps.finish("domains", "Domain & URL reputation", "skipped", "No domain or URL reputation service is connected yet, so these weren't checked.");
    }

    const saved = await store.saveFindings(db, user.id, runId, findings);
    ctx.send({ type: "findings", agent: "threat_hunter", count: findings.length, bySeverity: countBy(findings) });
    const timelineText = timeline
      .slice(0, 40)
      .map((e) => `${e.time ?? "?"} ${e.ip ?? ""} ${e.label} (${e.ref})`)
      .join("\n");
    const report = await writeReport(
      ctx,
      steps,
      "threat_hunter",
      `Investigation of ${asset}. Stats: ${JSON.stringify(stats).slice(0, 800)}. Pasted indicators: ${pasted.ips.length} IPs, ${pasted.domains.length} domains, ${pasted.urls.length} URLs. Continuous monitoring is NOT connected; only the uploaded data was analysed.`,
      findings,
      timelineText ? `Timeline:\n${timelineText}` : "",
    );
    const runStats = { ...stats, findings: findings.length, bySeverity: countBy(findings), created: saved.created, timeline: timeline.slice(0, 100) };
    await store.finishRun(db, runId, { status: "completed", summary: report.summary, tools: steps.tools, stats: runStats, modelId: report.modelId });
    await store.audit(db, user.id, "investigation.finished", { runId, detail: { findings: findings.length } });
    ctx.send({ type: "done", agent: "threat_hunter", runId });
    return { runId, findings };
  });
}

/* ----------------------------------------------------------- Code Guardian */

export async function runGuardianAgent(
  ctx: RunContext,
  input: { source: { type: "upload"; files: SourceFile[] } | { type: "github"; repo: string }; asset: string; aiReview: boolean; proposeFixes: boolean },
) {
  const { supabase: db, user } = ctx.auth;
  await verifyParent(ctx);
  const runId = await store.startRun(db, user.id, {
    agent: "code_guardian",
    action: "audit",
    asset: input.source.type === "github" ? `github:${input.source.repo}` : input.asset || "Uploaded code",
    parentId: ctx.parentId,
  });
  ctx.send({ type: "run", agent: "code_guardian", runId });
  const steps = new Steps(ctx.send, "code_guardian");
  return guarded(ctx, runId, "code_guardian", steps, async () => {
    let files: SourceFile[];
    let asset: string;
    if (input.source.type === "github") {
      const t = steps.start("fetch", "GitHub snapshot");
      const token = (await isAdmin(ctx.auth)) ? (process.env.GITHUB_TOKEN ?? "").trim() || null : null;
      const repo = await fetchRepoFiles(input.source.repo, { token, signal: ctx.signal }).catch((e: Error) => {
        throw new ApiError("bad_request", e.message);
      });
      files = repo.files;
      asset = `github:${repo.label}`;
      steps.finish("fetch", "GitHub snapshot", "ok", `${repo.files.length} files at ${repo.ref}${repo.truncated ? " (size limit reached; some files skipped)" : ""}`, t);
    } else {
      files = input.source.files;
      asset = input.asset || "Uploaded code";
    }
    await store.audit(db, user.id, "audit.started", { runId, detail: { asset, files: files.length, aiReview: input.aiReview, proposeFixes: input.proposeFixes } });

    let t = steps.start("rules", "Code & secret rules");
    const rules = runCodeRules(files, asset);
    steps.finish("rules", "Code & secret rules", "ok", `${rules.filesScanned} files, ${rules.linesScanned.toLocaleString("en-US")} lines, ${rules.findings.length} findings`, t);
    const findings: FindingDraft[] = [...rules.findings];
    const checked = ["secret.", "code.", "py.", "php."];

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
      const chosen = selectFilesForReview(files);
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

    const saved = await store.saveFindings(db, user.id, runId, findings);
    // Only compare against earlier audits of the same named source; unnamed uploads may be unrelated projects.
    const resolved = input.source.type === "github" || input.asset ? await store.markNotDetected(db, user.id, runId, "code_guardian", asset, checked) : 0;
    ctx.send({ type: "findings", agent: "code_guardian", count: findings.length, bySeverity: countBy(findings), resolved, reopened: saved.reopened });

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

    const report = await writeReport(ctx, steps, "code_guardian", `Code audit of ${asset}: ${rules.filesScanned} files scanned with rules; dependencies: ${manifests.packages.length} packages.`, findings);
    const stats = { findings: findings.length, bySeverity: countBy(findings), files: rules.filesScanned, lines: rules.linesScanned, packages: manifests.packages.length, created: saved.created, resolved, reopened: saved.reopened };
    await store.finishRun(db, runId, { status: "completed", summary: report.summary, tools: steps.tools, stats, modelId: report.modelId });
    await store.audit(db, user.id, "audit.finished", { runId, detail: stats });
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
    const childFindings = (await Promise.all(children.map((c) => store.listFindings(db, user.id, { runId: c.id, includeDuplicates: true })))).flat();
    let t = steps.start("correlate", "Correlate findings");
    const links = correlate(childFindings);
    await store.linkRelated(db, links.pairs);
    steps.finish("correlate", "Correlate findings", "ok", `${links.pairs.length} link(s) between agents' findings`, t);

    const plan = (run.stats.plan as string[] | undefined) ?? [];
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
