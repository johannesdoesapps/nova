/**
 * Which engine requests spend money on AI models. The engine's own model
 * calls aren't metered by Orbis's allowance, so the proxy lets only
 * administrators make them. The engine treats any truthy value as "yes"
 * (Python's bool()), so this does too, on the parsed body rather than text.
 */

/** Python truthiness: false, 0, "", [], {} and null are false; everything else is true. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** Starting a Lab run: live unless it says "dry_run" (the engine's default is live). */
const LAB_RUN = /^lab\/workflows\/[^/]+\/runs$/;

/** True when the request asks the engine to call an AI model: AI planning, or a live Lab run. */
export function engineRequestUsesModel(path: string, body: string | undefined): boolean {
  if (!body?.trim()) return LAB_RUN.test(path); // an empty run request is a live run

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false; // The engine rejects bodies that aren't JSON.
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const b = parsed as Record<string, unknown>;
  if (truthy(b.use_model)) return true;
  return LAB_RUN.test(path) && b.mode !== "dry_run";
}
