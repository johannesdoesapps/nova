import "server-only";
import { isAdmin } from "../admin";
import type { AuthContext } from "../auth";
import type { TargetRow } from "../db/security";
import { publicEnv } from "../env";
import { serviceSupabase } from "../supabase/admin";
import { safeRequest, txtRecords } from "./net";

/**
 * Proof that the user controls a website, checked by the server immediately
 * before every scan (never trusted from the database or the browser):
 *  - http_file: https://HOST/.well-known/orbis-security-verification.txt contains the token
 *  - dns_txt:   a TXT record on _orbis-verify.HOST (or HOST) contains the token
 *  - site_admin: an administrator scanning this Orbis deployment's own domain
 */
export const VERIFY_PATH = "/.well-known/orbis-security-verification.txt";

export function siteHosts(): string[] {
  const hosts = new Set<string>();
  try {
    hosts.add(new URL(publicEnv.siteUrl).hostname);
  } catch {
    /* ignore */
  }
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prod) hosts.add(prod.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  hosts.delete("localhost");
  return [...hosts];
}

export type Proof = { ok: true; method: "http_file" | "dns_txt" | "site_admin" } | { ok: false; reason: string };

/** The shape of a token Orbis issues (addTarget). The row is writable by its owner, so nothing else is accepted. */
export const TOKEN_FORMAT = /^orbis-verify-[0-9a-f]{32}$/;

/** The verification file or TXT record holds exactly the token (one line of it, for a file), not merely contains it. */
export function publishesToken(published: string, token: string): boolean {
  return TOKEN_FORMAT.test(token) && published.split(/\r?\n/).some((line) => line.trim().replace(/^"|"$/g, "") === token);
}

/**
 * Tokens are public once published, so a token copied from someone else's site into your own row proves nothing:
 * the token belongs to whoever was issued it first.
 */
async function tokenIssuedTo(token: string, userId: string): Promise<boolean> {
  const db = serviceSupabase();
  if (!db) return true; // no service role (local development): the format and exact match still apply
  const { data, error } = await db.from("security_targets").select("user_id").eq("token", token).order("created_at", { ascending: true }).limit(1);
  return !error && data?.[0]?.user_id === userId;
}

export async function proveOwnership(target: Pick<TargetRow, "hostname" | "token">, auth: AuthContext, signal?: AbortSignal): Promise<Proof> {
  if (siteHosts().includes(target.hostname) && (await isAdmin(auth))) return { ok: true, method: "site_admin" };
  if (!auth.user || !TOKEN_FORMAT.test(target.token) || !(await tokenIssuedTo(target.token, auth.user.id))) {
    return { ok: false, reason: `This target's verification token isn't valid. Remove ${target.hostname} from your targets and add it again to get a new token.` };
  }
  try {
    const r = await safeRequest(`https://${target.hostname}${VERIFY_PATH}`, { signal, maxBytes: 4096, timeoutMs: 6000 });
    if (r.status === 200 && publishesToken(r.body, target.token)) return { ok: true, method: "http_file" };
  } catch {
    /* try DNS next */
  }
  const records = [...(await txtRecords(`_orbis-verify.${target.hostname}`)), ...(await txtRecords(target.hostname))];
  if (records.some((r) => publishesToken(r, target.token))) return { ok: true, method: "dns_txt" };
  return {
    ok: false,
    reason: `Couldn't confirm you control ${target.hostname}. Publish the token at ${VERIFY_PATH} or in a TXT record on _orbis-verify.${target.hostname}, then try again.`,
  };
}
