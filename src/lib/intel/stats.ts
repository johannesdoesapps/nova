/**
 * Statistics used by Model Intelligence. Everything here is small, exact and
 * documented in docs/MODEL_INTELLIGENCE.md so results can be audited.
 */

/** Wilson score interval for a binomial proportion. */
export function wilson(successes: number, n: number, z = 1.96): { p: number; low: number; high: number } {
  if (n <= 0) return { p: 0, low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** Exact two-sided binomial test p-value for k successes in n trials at p=0.5 (sign test / McNemar). */
export function binomialTwoSided(k: number, n: number): number {
  if (n === 0) return 1;
  const probs = Array.from({ length: n + 1 }, (_, i) => Math.exp(logChoose(n, i) - n * Math.LN2));
  const observed = probs[k]!;
  let p = 0;
  for (const x of probs) if (x <= observed * (1 + 1e-9)) p += x;
  return Math.min(1, p);
}

export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Exponential time decay: an observation `halfLifeDays` old counts half. */
export function decayWeight(createdAt: string, now: string, halfLifeDays = 90): number {
  const age = (new Date(now).getTime() - new Date(createdAt).getTime()) / 86_400_000;
  return Math.pow(0.5, Math.max(0, age) / halfLifeDays);
}

/** Deterministic PRNG (mulberry32) so bootstrap results are reproducible. */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Comparison {
  a: string;
  b: string;
  /** Weight of a beating b (ties count half to each). */
  w: number;
}

/**
 * Bradley–Terry strengths via the MM algorithm, normalised so the geometric
 * mean is 1. Used only to order models; decisions use pairwise intervals.
 */
export function bradleyTerry(models: string[], comparisons: Comparison[], iterations = 200): Map<string, number> {
  const s = new Map(models.map((m) => [m, 1]));
  const wins = new Map(models.map((m) => [m, 0]));
  const pairN = new Map<string, number>();
  const key = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  for (const c of comparisons) {
    wins.set(c.a, (wins.get(c.a) ?? 0) + c.w);
    pairN.set(key(c.a, c.b), (pairN.get(key(c.a, c.b)) ?? 0) + c.w);
  }
  for (let it = 0; it < iterations; it++) {
    for (const i of models) {
      let denom = 0;
      for (const j of models) {
        if (i === j) continue;
        const n = pairN.get(key(i, j)) ?? 0;
        if (n) denom += n / (s.get(i)! + s.get(j)!);
      }
      // A tiny prior (0.5 win vs a virtual average opponent) keeps undefeated/winless models finite.
      const next = (wins.get(i)! + 0.5) / (denom + 1 / (s.get(i)! + 1));
      s.set(i, next);
    }
    const g = Math.exp(models.reduce((acc, m) => acc + Math.log(s.get(m)!), 0) / Math.max(1, models.length));
    for (const m of models) s.set(m, s.get(m)! / g);
  }
  return s;
}

/** Bootstrap the rank of each model (seeded). Returns the 2.5th and 97.5th percentile ranks. */
export function bootstrapRanks(models: string[], comparisons: Comparison[], resamples = 200, seed = 7): Map<string, { low: number; high: number }> {
  const rand = prng(seed);
  const ranks = new Map(models.map((m) => [m, [] as number[]]));
  if (!comparisons.length) return new Map(models.map((m) => [m, { low: 1, high: models.length }]));
  for (let r = 0; r < resamples; r++) {
    const sample = Array.from({ length: comparisons.length }, () => comparisons[Math.floor(rand() * comparisons.length)]!);
    const s = bradleyTerry(models, sample, 60);
    const order = [...models].sort((a, b) => s.get(b)! - s.get(a)!);
    order.forEach((m, i) => ranks.get(m)!.push(i + 1));
  }
  return new Map(models.map((m) => [m, { low: quantile(ranks.get(m)!, 0.025)!, high: quantile(ranks.get(m)!, 0.975)! }]));
}
