import "server-only";
import { isAdmin } from "../admin";
import type { AuthContext } from "../auth";
import type { TargetRow } from "../db/security";
import { publicEnv } from "../env";
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

export async function proveOwnership(
  target: Pick<TargetRow, "hostname" | "token">,
  auth: AuthContext,
  signal?: AbortSignal,
  /** The website scanner's local test lab passes its own transport; everything else uses the guarded defaults. */
  io: { request?: typeof safeRequest; txt?: typeof txtRecords } = {},
): Promise<Proof> {
  if (siteHosts().includes(target.hostname) && (await isAdmin(auth))) return { ok: true, method: "site_admin" };
  const request = io.request ?? safeRequest;
  const txt = io.txt ?? txtRecords;
  try {
    const r = await request(`https://${target.hostname}${VERIFY_PATH}`, { signal, maxBytes: 4096, timeoutMs: 6000 });
    if (r.status === 200 && r.body.includes(target.token)) return { ok: true, method: "http_file" };
  } catch {
    /* try DNS next */
  }
  const records = [...(await txt(`_orbis-verify.${target.hostname}`)), ...(await txt(target.hostname))];
  if (records.some((r) => r.includes(target.token))) return { ok: true, method: "dns_txt" };
  return {
    ok: false,
    reason: `Couldn't confirm you control ${target.hostname}. Publish the token at ${VERIFY_PATH} or in a TXT record on _orbis-verify.${target.hostname}, then try again.`,
  };
}
