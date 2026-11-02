import { timingSafeEqual } from "node:crypto";

/**
 * Whether a request carries the `Bearer <CRON_SECRET>` header, compared in constant time so the comparison can't
 * leak the secret through response timing. Without CRON_SECRET set, nothing is authorized (the caller refuses).
 */
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
