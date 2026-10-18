/**
 * Fixed-window, in-memory rate limiter.
 *
 * Good enough for a single instance and for local development. On serverless
 * (Vercel) each instance has its own memory, so for production put a shared
 * store behind the same interface (e.g. Upstash Redis or a Postgres function).
 */
export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;
}

export class MemoryRateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  check(key: string, cost = 1): RateLimitResult {
    const t = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, entry);
    }
    if (entry.count + cost > this.limit) {
      return { ok: false, remaining: Math.max(0, this.limit - entry.count), resetAt: entry.resetAt };
    }
    entry.count += cost;
    if (this.hits.size > 10_000) this.sweep(t);
    return { ok: true, remaining: this.limit - entry.count, resetAt: entry.resetAt };
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

const limiters = new Map<string, MemoryRateLimiter>();

export function limiter(name: string, limit: number, windowMs: number): MemoryRateLimiter {
  const key = `${name}:${limit}:${windowMs}`;
  let l = limiters.get(key);
  if (!l) {
    l = new MemoryRateLimiter(limit, windowMs);
    limiters.set(key, l);
  }
  return l;
}
