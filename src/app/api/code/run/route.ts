import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { enforce } from "@/lib/bastion/server";
import { checkRunAllowance, recordCodeRun, releaseRun } from "@/lib/code/meter";
import { codeLanguage, MAX_CODE_CHARS } from "@/lib/code/languages";
import { maxCodeRunCostUsd } from "@/lib/code/pricing";
import { codeRunsAvailable, runCode } from "@/lib/code/run";
import { entitlementFor } from "@/lib/entitlements";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { limiter } from "@/lib/rate-limit";
import { enforceLimits } from "@/lib/usage";

export const maxDuration = 120;

const body = z.object({
  language: z.string().min(1).max(20),
  code: z.string().min(1).max(MAX_CODE_CHARS),
  requestId: z.string().uuid().optional(),
});

/**
 * POST /api/code/run — run a chat code block in an isolated sandbox (no
 * network, time and output limits). Signed-in users only; counted against the
 * plan's monthly code runs. Returns stdout, stderr, the exit code and timing.
 */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, body, MAX_CODE_CHARS * 2 + 4_000);
    const auth = await requireUser();
    const lang = codeLanguage(input.language);
    if (!lang) throw new ApiError("bad_request", "Orbis can run Python, JavaScript, TypeScript and Bash code.");
    if (!codeRunsAvailable()) throw new ApiError("not_configured", "Running code isn't set up on this server.");
    // Orbis Bastion: the user pressed Run on this block (that's the approval); an administrator can switch code runs off.
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "user", agent: "code_runner" }, "code.run", `${lang.id} (${input.code.length} chars)`, { approved: true });
    if (!limiter("code-run", 10, 60_000).check(`u:${auth.user.id}`, 1).ok) {
      throw new ApiError("rate_limited", "Too many code runs in a minute. Please wait a moment.");
    }
    const entitlement = await entitlementFor(auth);
    const billing = entitlement?.billing;
    if (!billing) throw new ApiError("not_configured", "Code runs need accounts to be set up.");

    // Reserve like an AI request: refuses duplicates and holds the run's cost against the budget and caps.
    const ticket = await enforceLimits(req, auth, 0, undefined, {
      requestId: input.requestId,
      purpose: "code_run",
      inputTokens: 0,
      maxOutputTokens: 0,
      extraCostUsd: maxCodeRunCostUsd(billing.codeRunSeconds),
      ttlSeconds: billing.codeRunSeconds + 90,
      countsAsMessage: false,
    });
    const allowance = await checkRunAllowance(auth, ticket.requestId);

    let result;
    try {
      result = await runCode({ language: lang.id, code: input.code, seconds: billing.codeRunSeconds, signal: req.signal });
    } catch (err) {
      await releaseRun(auth, ticket.requestId);
      if (req.signal.aborted) throw new ApiError("bad_request", "The run was cancelled.");
      reportError(err, { where: "code_run.sandbox" });
      throw new ApiError("upstream_error", "The code runner isn't available right now. Your run wasn't counted.");
    }
    await recordCodeRun(auth, ticket.requestId, lang, result, maxCodeRunCostUsd(billing.codeRunSeconds));
    return Response.json({ ...result, runsLeft: allowance.left, runsLimit: allowance.limit, timeLimitSeconds: billing.codeRunSeconds });
  } catch (err) {
    return errorResponse(err);
  }
}
