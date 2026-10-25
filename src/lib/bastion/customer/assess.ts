import "server-only";
import { withTimeout } from "../../ai";
import { finishRun, markNotDetected, saveFindings, startRun } from "../../db/security";
import { ApiError } from "../../http";
import { codeMapFindings, mapCode } from "../../security/code-map";
import { runCodeRules } from "../../security/code-rules";
import { checkDependencies, parseManifests } from "../../security/deps";
import type { FindingDraft, ToolRun } from "../../security/types";
import type { ServerSupabase } from "../../supabase/server";
import { checkedPrefixes, evaluateGate, recheckDepth, type AppMode } from "./gate";
import { notifySecurity } from "./notify";
import { recordEvent, type WorkspaceCtx } from "./workspace";

/**
 * Application protection for Orbis Code projects: Code Guardian's rules over the project's files, stored as a
 * normal Code Guardian run (so findings, re-scan verification, Aegis and the finding pages all work as for any
 * audit). Reads the workspace owner's project only; nothing is executed.
 */

export async function assessProject(ctx: WorkspaceCtx, projectId: string, mode: AppMode, opts: { findingIds?: string[]; signal?: AbortSignal } = {}) {
  const db = ctx.db as unknown as ServerSupabase;
  const { data: project } = await ctx.db.from("code_projects").select("id,name").eq("id", projectId).eq("user_id", ctx.ownerId).maybeSingle();
  if (!project) throw new ApiError("not_found", "Project not found.");
  const asset = `orbis:${projectId}`;

  // A recheck re-runs only what's needed for the chosen findings (theirs, on this project).
  let depth: "quick" | "deep" = mode === "quick" ? "quick" : "deep";
  let rechecking: { id: string; rule_id: string }[] = [];
  if (mode === "recheck") {
    if (!opts.findingIds?.length) throw new ApiError("bad_request", "Choose the findings to recheck.");
    const { data } = await ctx.db.from("security_findings").select("id,rule_id").eq("user_id", ctx.ownerId).eq("asset", asset).in("id", opts.findingIds.slice(0, 50));
    rechecking = (data ?? []) as { id: string; rule_id: string }[];
    if (!rechecking.length) throw new ApiError("not_found", "Those findings aren't on this project.");
    depth = recheckDepth(rechecking.map((f) => f.rule_id));
  }

  const { data: fileRows, error } = await ctx.db.from("code_files").select("path,content").eq("project_id", projectId).limit(3000);
  if (error) throw new ApiError("internal", "The project's files couldn't be read.");
  const files = (fileRows ?? []) as { path: string; content: string }[];
  if (!files.length) throw new ApiError("bad_request", "The project has no files to check.");

  const runId = await startRun(db, ctx.ownerId, { agent: "code_guardian", action: "audit", asset, scope: `bastion:${mode}` });
  const tools: ToolRun[] = [];
  const drafts: FindingDraft[] = [];
  try {
    const rules = runCodeRules(files, asset);
    drafts.push(...rules.findings);
    tools.push({ tool: "Code & secret rules", status: "ok", detail: `${rules.filesScanned} files, ${rules.linesScanned.toLocaleString("en-US")} lines, ${rules.findings.length} findings` } as ToolRun);
    let depsRan = false;
    if (depth === "deep") {
      const map = mapCode(files);
      const mf = codeMapFindings(map, files, asset);
      drafts.push(...mf);
      tools.push({ tool: "Application map", status: "ok", detail: `${map.routes.length} routes, ${map.configFiles.length} config files; ${mf.length} findings` } as ToolRun);
      const manifests = parseManifests(files);
      if (manifests.packages.length) {
        try {
          const deps = await checkDependencies(manifests.packages, asset, { signal: withTimeout(20_000, opts.signal) });
          drafts.push(...deps.findings);
          depsRan = true;
          tools.push({ tool: "OSV dependency check", status: "ok", detail: `${deps.queried} packages checked, ${deps.vulnerable} with known vulnerabilities` } as ToolRun);
        } catch (err) {
          tools.push({ tool: "OSV dependency check", status: "failed", detail: `OSV.dev couldn't be reached: ${(err as Error).message}`.slice(0, 300) } as ToolRun);
        }
      } else tools.push({ tool: "OSV dependency check", status: "skipped", detail: "No package manifest found." } as ToolRun);
    }
    const saved = await saveFindings(db, ctx.ownerId, runId, drafts);
    const resolved = await markNotDetected(db, ctx.ownerId, runId, "code_guardian", asset, checkedPrefixes(depth === "quick" ? "quick" : "deep", depsRan));

    // The gate decides on everything open on this project after this run.
    let gate: ReturnType<typeof evaluateGate> | null = null;
    if (mode === "gate") {
      const { data: open } = await ctx.db
        .from("security_findings")
        .select("rule_id,severity,confidence,status,title,verification")
        .eq("user_id", ctx.ownerId)
        .eq("asset", asset)
        .is("duplicate_of", null)
        .limit(500);
      gate = evaluateGate(
        ((open ?? []) as (Parameters<typeof evaluateGate>[0][number] & { verification: string })[]).filter((f) => f.verification !== "not_detected"),
        { depsChecked: depsRan },
      );
    }
    let recheck: { id: string; result: "still_present" | "not_detected" }[] | null = null;
    if (rechecking.length) {
      const { data } = await ctx.db
        .from("security_findings")
        .select("id,verification,last_run_id")
        .eq("user_id", ctx.ownerId)
        .in(
          "id",
          rechecking.map((f) => f.id),
        );
      recheck = ((data ?? []) as { id: string; verification: string; last_run_id: string | null }[]).map((f) => ({ id: f.id, result: f.last_run_id === runId ? "still_present" : "not_detected" }));
    }
    const counts = { found: drafts.length, created: saved.created, resolved };
    const summary =
      mode === "gate"
        ? `Pre-deployment gate ${gate!.passed ? "passed" : "failed"}: ${gate!.blocking} blocking finding(s). Static checks only.`
        : `${drafts.length} finding(s); ${saved.created} new, ${resolved} no longer detected.`;
    await finishRun(db, runId, { status: "completed", summary, tools, stats: { bastion: { mode, depth, gate, counts, recheck } } });
    await recordEvent(ctx, "bastion.assessment", {
      mode: "application",
      app: mode,
      target: asset,
      label: (project as { name: string }).name,
      runId,
      counts,
      gate: gate ? { passed: gate.passed, blocking: gate.blocking } : null,
    });
    // Detected — not a confirmed incident.
    const secrets = drafts.filter((d) => d.ruleId.startsWith("secret."));
    if (secrets.length)
      await notifySecurity(
        ctx,
        "credentialExposure",
        `cred:${asset}:${secrets
          .map((s) => s.fingerprint)
          .sort()
          .join(",")
          .slice(0, 40)}`,
        `Possible credential in ${(project as { name: string }).name}`,
        `${secrets.length} possible credential(s) were found in the project's files by a ${mode} check. Review them in Bastion → Findings; if one is real, rotate it.`,
      );
    const critical = drafts.filter((d) => d.severity === "critical");
    if (critical.length)
      await notifySecurity(
        ctx,
        "critical",
        `crit:${asset}:${critical
          .map((s) => s.fingerprint)
          .sort()
          .join(",")
          .slice(0, 40)}`,
        `Critical finding in ${(project as { name: string }).name}`,
        `${critical.length} critical finding(s) were detected by a ${mode} check. This is a detection to review, not a confirmed incident.`,
      );
    return { runId, mode, summary, tools, counts, gate, recheck };
  } catch (err) {
    await finishRun(db, runId, { status: "failed", tools, error: (err as Error).message.slice(0, 500) }).catch(() => {});
    throw err;
  }
}
