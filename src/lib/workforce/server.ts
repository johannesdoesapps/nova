import "server-only";
import { z } from "zod";
import { isAdmin } from "../admin";
import { requireUser, type AuthContext } from "../auth";
import { ApiError, errorResponse } from "../http";
import { WorkforceError, type Runtime } from "./commander";
import { novaModelRunner } from "./models-nova";
import { vercelWorkspaces } from "./sandbox-vercel";
import { SupabaseStore } from "./supabase-store";
import { AUTONOMY } from "./types";

/**
 * Every Workforce endpoint goes through this: a signed-in administrator
 * (checked here and again by Row Level Security) and a runtime bound to them.
 */
export async function requireOperator(): Promise<{ auth: Extract<AuthContext, { mode: "authenticated" }>; rt: Runtime; store: SupabaseStore }> {
  const auth = await requireUser();
  if (!(await isAdmin(auth))) throw new ApiError("forbidden", "The Workforce is limited to Nova operators (administrators).");
  const store = new SupabaseStore(auth.supabase, auth.user.id);
  return { auth, store, rt: { store, models: novaModelRunner(auth), workspaces: vercelWorkspaces } };
}

export function wfError(err: unknown) {
  if (err instanceof WorkforceError) {
    const code = err.code === "conflict" ? "bad_request" : err.code;
    return errorResponse(new ApiError(code, err.message));
  }
  return errorResponse(err);
}

const criterion = z.string().trim().min(3).max(500);

export const taskCreateSchema = z.object({
  projectId: z.uuid(),
  title: z.string().trim().min(3).max(200),
  objective: z.string().trim().min(10).max(8000),
  acceptanceCriteria: z.array(criterion).max(15).default([]),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  autonomy: z.enum(AUTONOMY).default("collaborate"),
  budgetUsd: z.number().min(0.01).max(1000).optional(),
  tokenBudget: z.number().int().min(10_000).max(20_000_000).optional(),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(2000).nullable().default(null),
  payloadHash: z.string().min(16).max(128),
});

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  repo: z.string().trim().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "Use the owner/name form, e.g. acme/web."),
  branch: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._\/-]+$/, "Invalid branch name.").default("main"),
  notes: z.string().trim().max(4000).nullable().default(null),
});

export const checkSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  label: z.string().trim().min(1).max(60),
  commands: z.array(z.array(z.string().max(100)).min(1).max(5)).min(1).max(4),
  required: z.boolean(),
  network: z.array(z.string().max(100)).max(4).optional(),
  timeoutMs: z.number().int().min(10_000).max(1_800_000).optional(),
});

/** Read package.json from GitHub to detect checks. Private repos need GITHUB_TOKEN (admins only). */
export async function fetchPackageJson(repo: string, branch: string): Promise<Record<string, unknown>> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const res = token
    ? await fetch(`https://api.github.com/repos/${repo}/contents/package.json?ref=${encodeURIComponent(branch)}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github.raw+json", "user-agent": "nova-workforce" } })
    : await fetch(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/package.json`);
  if (res.status === 404) throw new ApiError("bad_request", `No package.json found on ${repo}@${branch}. The repository may be private (needs GITHUB_TOKEN) or not a Node project — only npm projects are supported so far.`);
  if (!res.ok) throw new ApiError("upstream_error", `GitHub returned HTTP ${res.status}.`);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new ApiError("bad_request", "package.json isn't valid JSON.");
  }
}
