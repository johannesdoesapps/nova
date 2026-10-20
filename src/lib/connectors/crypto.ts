import "server-only";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets for connectors, from one server-only key (ORBIS_CONNECTOR_KEY, 32+
 * random bytes, base64). Separate keys are derived for each use:
 * - tokens are sealed with AES-256-GCM before they're stored, bound to the
 *   user and connector (so a sealed token can't be moved to another row);
 * - the OAuth state cookie is signed with HMAC-SHA256.
 * The browser never sees a token or this key; the database holds only
 * sealed tokens, which are useless without the key.
 */

export function connectorKeyConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return rawKey(env) !== null;
}

function rawKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const v = env.ORBIS_CONNECTOR_KEY?.trim();
  if (!v) return null;
  const b = Buffer.from(v, "base64");
  return b.length >= 32 ? b : null;
}

function derive(purpose: string, env?: Record<string, string | undefined>): Buffer {
  const k = rawKey(env);
  if (!k) throw new Error("ORBIS_CONNECTOR_KEY is not set (32 random bytes, base64).");
  return Buffer.from(hkdfSync("sha256", k, Buffer.from("orbis-connectors"), Buffer.from(purpose), 32));
}

const b64u = (b: Buffer) => b.toString("base64url");

/** Seal a secret for one user's connection. Output: "v1." + base64url(iv | tag | ciphertext). */
export function seal(plain: string, binding: string, env?: Record<string, string | undefined>): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive("tokens", env), iv);
  c.setAAD(Buffer.from(binding));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${b64u(Buffer.concat([iv, c.getAuthTag(), ct]))}`;
}

/** Open a sealed secret; throws if it was changed, sealed for another binding, or with another key. */
export function open(sealed: string, binding: string, env?: Record<string, string | undefined>): string {
  if (!sealed.startsWith("v1.")) throw new Error("Unknown token format.");
  const raw = Buffer.from(sealed.slice(3), "base64url");
  if (raw.length < 29) throw new Error("Sealed token is too short.");
  const d = createDecipheriv("aes-256-gcm", derive("tokens", env), raw.subarray(0, 12));
  d.setAAD(Buffer.from(binding));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

/** What binds a sealed token to its row. */
export const tokenBinding = (userId: string, connectorId: string) => `${userId}:${connectorId}`;

/** Sign a value (for the OAuth state cookie): "payload.signature". */
export function sign(payload: string, env?: Record<string, string | undefined>): string {
  return `${payload}.${b64u(createHmac("sha256", derive("oauth-state", env)).update(payload).digest())}`;
}

/** The payload if the signature is valid, else null. */
export function verify(signed: string, env?: Record<string, string | undefined>): string | null {
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const payload = signed.slice(0, i);
  const want = createHmac("sha256", derive("oauth-state", env)).update(payload).digest();
  const got = Buffer.from(signed.slice(i + 1), "base64url");
  return got.length === want.length && timingSafeEqual(got, want) ? payload : null;
}

export const randomToken = (bytes = 32) => b64u(randomBytes(bytes));
