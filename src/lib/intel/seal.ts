import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ApiError } from "../http";

/**
 * Sealed tokens keep the A/B → model mapping on the client without revealing
 * it: AES-256-GCM encrypted and authenticated, with an expiry. The key comes
 * from NOVA_TRIAL_SECRET; without it a per-process random key is used, so
 * pending trials expire when the server restarts (documented in the README).
 */
let processKey: Buffer | null = null;

function key(): Buffer {
  const secret = process.env.NOVA_TRIAL_SECRET?.trim();
  if (secret) return createHash("sha256").update(`nova-trial:${secret}`).digest();
  processKey ??= randomBytes(32);
  return processKey;
}

export function seal(payload: unknown, ttlMs = 24 * 3600_000): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.from(JSON.stringify({ p: payload, exp: Date.now() + ttlMs }), "utf8");
  const enc = Buffer.concat([cipher.update(body), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function unseal<T>(token: string): T {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ApiError("bad_request", "Invalid trial token.");
  try {
    const [iv, tag, enc] = parts.map((p) => Buffer.from(p, "base64url")) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    const json = JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8")) as { p: T; exp: number };
    if (json.exp < Date.now()) throw new ApiError("bad_request", "This trial has expired. Start a new one.");
    return json.p;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("bad_request", "Invalid or expired trial token (the server may have restarted).");
  }
}
