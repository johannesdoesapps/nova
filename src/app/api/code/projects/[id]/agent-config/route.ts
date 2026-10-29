import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgentSettings, getOrbisFiles, MAX_MCP_SERVERS, publicSettings, saveAgentSettings, sealedServer } from "@/lib/code/agent-settings";
import { cleanRules, MAX_RULES, parseRule, projectAgents, projectCommands, projectInstructions, projectSkills, settingsState } from "@/lib/code/agent/settings";
import { codeContext, getProjectRow } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/code/projects/[id]/agent-config">;

/**
 * GET /api/code/projects/[id]/agent-config — what the project tells the agent (ORBIS.md, its commands, skills and
 * helper agents, and its .orbis/settings.json with whether it's trusted) and the user's own settings for it.
 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("code-agent-read", 120);
    await getProjectRow(auth, id);
    const [files, settings] = await Promise.all([getOrbisFiles(auth, id), getAgentSettings(auth, id)]);
    const ins = projectInstructions(files);
    const state = settingsState(files, settings.trustedSettings);
    return NextResponse.json({
      instructions: ins?.path ? { path: ins.path, chars: ins.content.length, truncated: ins.truncated } : null,
      commands: projectCommands(files).map((c) => ({ name: c.name, description: c.description, argHint: c.argHint, body: c.body })),
      skills: projectSkills(files),
      agents: projectAgents(files).map((a) => ({ name: a.name, description: a.description })),
      projectSettings: { status: state.status, hash: state.hash, error: state.error ?? null, found: state.found },
      settings: publicSettings(settings),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const rule = z.string().trim().min(1).max(300).refine((r) => !!parseRule(r), "A rule looks like bash(npm test*), edit(src/**), read(secrets/**), mcp(server/tool) or web(example.com).");

const body = z.object({
  rules: z.object({ allow: z.array(rule).max(MAX_RULES), deny: z.array(rule).max(MAX_RULES) }).optional(),
  /** Trust this exact version of .orbis/settings.json (its hash, as shown), or null to stop trusting it. */
  trust: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  addMcp: z.object({ name: z.string().trim().min(1).max(24), url: z.string().trim().url().max(500), token: z.string().max(4_000).nullable().optional() }).optional(),
  removeMcp: z.string().max(24).optional(),
});

/** PATCH /api/code/projects/[id]/agent-config — save the user's rules, trust the project's settings file, add or remove MCP servers. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const input = await parseJsonBody(req, body, 12_000);
    const auth = await codeContext("code-agent", 30);
    await getProjectRow(auth, id);
    const current = await getAgentSettings(auth, id);
    const next = { ...current };
    if (input.rules) next.rules = cleanRules(input.rules);
    if (input.trust !== undefined) {
      if (input.trust) {
        const state = settingsState(await getOrbisFiles(auth, id), null);
        if (state.hash !== input.trust) throw new ApiError("conflict", "The project's settings file changed since you looked at it. Review it again before trusting it.");
      }
      next.trustedSettings = input.trust;
    }
    if (input.removeMcp) next.mcp = (next.mcp ?? []).filter((m) => m.name !== input.removeMcp);
    if (input.addMcp) {
      const mcp = (next.mcp ?? []).filter((m) => m.name !== input.addMcp!.name);
      if (mcp.length >= MAX_MCP_SERVERS) throw new ApiError("bad_request", `A project can have up to ${MAX_MCP_SERVERS} MCP servers.`);
      next.mcp = [...mcp, sealedServer(auth, id, input.addMcp)];
    }
    return NextResponse.json({ settings: publicSettings(await saveAgentSettings(auth, id, next)) });
  } catch (err) {
    return errorResponse(err);
  }
}
