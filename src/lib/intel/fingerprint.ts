import { binomialTwoSided, bootstrapRanks, bradleyTerry, decayWeight, mean, quantile, wilson, type Comparison } from "./stats";
import type { BenchmarkRun, TaskCategory, TrialRecord, UsageRow } from "./types";
import { TASK_CATEGORIES } from "./types";

/**
 * Model Fingerprint: what this user's own evidence says about each model, per
 * task category. Two evidence streams are kept apart throughout:
 *   personal  — blind-trial votes and ratings (your preference)
 *   general   — deterministic benchmark scores (measured performance)
 * Neither stream produces a recommendation until it has enough data.
 */

export interface FingerprintOptions {
  now: string;
  /** Minimum blind trials between two models before a preference is reported. */
  minPairTrials: number;
  /** Minimum scored benchmark items per model before a measurement is reported. */
  minBenchmarkItems: number;
  /** Minimum discordant item pairs before a paired benchmark difference is tested. */
  minDiscordant: number;
  halfLifeDays: number;
  /** Weight applied to observations from an older served version of the same model. */
  priorVersionWeight: number;
}

export const DEFAULT_OPTIONS: Omit<FingerprintOptions, "now"> = {
  minPairTrials: 10,
  minBenchmarkItems: 20,
  minDiscordant: 6,
  halfLifeDays: 90,
  priorVersionWeight: 0.5,
};

export interface ModelRef {
  id: string;
  displayName: string;
  available?: boolean;
}

export type Sufficiency = "insufficient" | "tentative" | "clear";

export interface PersonalStats {
  trials: number;
  wins: number;
  losses: number;
  ties: number;
  bothBad: number;
  winRate: { p: number; low: number; high: number } | null;
  avgRating: number | null;
  ratingN: number;
}

export interface BenchmarkStats {
  items: number;
  passed: number;
  passRate: { p: number; low: number; high: number } | null;
  meanScore: number | null;
  testSets: { id: string; name: string; hash: string; items: number; passed: number }[];
  sufficient: boolean;
}

export interface OperationalStats {
  latencyN: number;
  p50: number | null;
  p95: number | null;
  costN: number;
  meanCost: number | null;
  costPartial: boolean;
  calls: number;
  errorRate: number | null;
}

export interface VersionInfo {
  current: string | null;
  seen: string[];
  priorObservations: number;
  drift: DriftResult | null;
}

export interface DriftResult {
  testSetId: string;
  from: string;
  to: string;
  improved: number;
  regressed: number;
  pValue: number | null;
  verdict: "changed" | "no_detectable_change" | "insufficient";
}

export interface ModelStats {
  modelId: string;
  displayName: string;
  personal: PersonalStats;
  benchmark: BenchmarkStats;
  ops: OperationalStats;
  version: VersionInfo;
}

export interface PairwiseResult {
  a: string;
  b: string;
  n: number;
  aPreferred: number; // weighted share a was preferred (ties = ½)
  interval: { low: number; high: number } | null;
  verdict: "insufficient" | "no_clear_difference" | "a_preferred" | "b_preferred";
  needed: number;
}

export interface PairedBenchmark {
  a: string;
  b: string;
  testSetId: string;
  shared: number;
  aOnly: number;
  bOnly: number;
  pValue: number | null;
  verdict: "insufficient" | "no_clear_difference" | "a_better" | "b_better";
}

export interface CategoryRecommendation {
  modelId: string | null;
  sufficiency: Sufficiency;
  basis: "personal_preference" | "general_benchmark";
  reasons: string[];
}

export interface CategoryFingerprint {
  category: TaskCategory;
  models: ModelStats[];
  pairwise: PairwiseResult[];
  paired: PairedBenchmark[];
  ranking: { modelId: string; strength: number; rankLow: number; rankHigh: number }[];
  personal: CategoryRecommendation;
  general: CategoryRecommendation;
}

export interface Fingerprint {
  generatedAt: string;
  options: FingerprintOptions;
  categories: CategoryFingerprint[];
  totals: { trials: number; benchmarkRuns: number; usageRows: number };
}

function versionWeights(modelId: string, trials: TrialRecord[], runs: BenchmarkRun[]) {
  const obs: { at: string; v: string | null }[] = [
    ...trials.flatMap((t) => t.arms.filter((a) => a.modelId === modelId).map((a) => ({ at: t.createdAt, v: a.servedModel }))),
    ...runs.filter((r) => r.modelId === modelId).map((r) => ({ at: r.createdAt, v: r.servedModel })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const reported = obs.filter((o) => o.v);
  const current = reported.length ? reported[reported.length - 1]!.v : null;
  const seen = [...new Set(reported.map((o) => o.v!))];
  return { current, seen, isPrior: (v: string | null) => Boolean(current && v && v !== current) };
}

function drift(modelId: string, runs: BenchmarkRun[], current: string | null, opts: FingerprintOptions): DriftResult | null {
  if (!current) return null;
  const mine = runs.filter((r) => r.modelId === modelId && r.servedModel);
  const latest = mine.filter((r) => r.servedModel === current).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest) return null;
  const prior = mine.filter((r) => r.servedModel !== current && r.testSetHash === latest.testSetHash).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!prior) return null;
  const before = new Map(prior.results.filter((x) => !x.error).map((x) => [x.itemId, x.passed]));
  let improved = 0;
  let regressed = 0;
  for (const r of latest.results) {
    if (r.error || !before.has(r.itemId)) continue;
    const b = before.get(r.itemId)!;
    if (!b && r.passed) improved++;
    if (b && !r.passed) regressed++;
  }
  const n = improved + regressed;
  if (n < opts.minDiscordant) return { testSetId: latest.testSetId, from: prior.servedModel!, to: current, improved, regressed, pValue: null, verdict: "insufficient" };
  const p = binomialTwoSided(Math.min(improved, regressed), n);
  return { testSetId: latest.testSetId, from: prior.servedModel!, to: current, improved, regressed, pValue: p, verdict: p < 0.05 ? "changed" : "no_detectable_change" };
}

function latestItemResults(runs: BenchmarkRun[], modelId: string, testSetHash: string) {
  const out = new Map<string, boolean>();
  for (const r of runs.filter((x) => x.modelId === modelId && x.testSetHash === testSetHash).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    for (const it of r.results) if (!it.error) out.set(it.itemId, it.passed);
  return out;
}

export function computeFingerprint(
  input: { trials: TrialRecord[]; benchmarks: BenchmarkRun[]; usage?: UsageRow[]; models: ModelRef[] },
  options: Partial<FingerprintOptions> & { now: string },
): Fingerprint {
  const opts: FingerprintOptions = { ...DEFAULT_OPTIONS, ...options };
  const usage = input.usage ?? [];
  const names = new Map(input.models.map((m) => [m.id, m.displayName]));
  for (const t of input.trials) for (const a of t.arms) if (!names.has(a.modelId)) names.set(a.modelId, a.displayName);
  for (const r of input.benchmarks) if (!names.has(r.modelId)) names.set(r.modelId, r.displayName);

  const categories: CategoryFingerprint[] = TASK_CATEGORIES.map((category) => {
    const trials = input.trials.filter((t) => t.category === category && t.arms.length === 2 && t.arms.every((a) => !a.error));
    const runs = input.benchmarks.filter((r) => r.category === category);
    const ids = [...new Set([...trials.flatMap((t) => t.arms.map((a) => a.modelId)), ...runs.map((r) => r.modelId)])];

    const models: ModelStats[] = ids.map((id) => {
      const v = versionWeights(id, input.trials, input.benchmarks);
      // personal
      let wins = 0, losses = 0, ties = 0, bothBad = 0, prior = 0;
      const ratings: number[] = [];
      for (const t of trials) {
        const arm = t.arms.find((a) => a.modelId === id);
        if (!arm) continue;
        if (v.isPrior(arm.servedModel)) prior++;
        if (t.winner === "tie") ties++;
        else if (t.winner === "both_bad") bothBad++;
        else if (t.winner === arm.label) wins++;
        else losses++;
        const r = t.ratings[arm.label];
        if (typeof r === "number") ratings.push(r);
      }
      const decided = wins + losses + ties;
      // general
      const sets = new Map<string, { id: string; name: string; hash: string; items: number; passed: number }>();
      const scores: number[] = [];
      for (const r of runs.filter((x) => x.modelId === id)) {
        if (v.isPrior(r.servedModel)) { prior++; continue; } // benchmarks are only pooled within the current version
        const s = sets.get(r.testSetHash) ?? { id: r.testSetId, name: r.testSetName, hash: r.testSetHash, items: 0, passed: 0 };
        for (const it of r.results) {
          if (it.error) continue;
          s.items++;
          if (it.passed) s.passed++;
          scores.push(it.score);
        }
        sets.set(r.testSetHash, s);
      }
      const items = [...sets.values()].reduce((n, s) => n + s.items, 0);
      const passed = [...sets.values()].reduce((n, s) => n + s.passed, 0);
      // operational (all categories' calls for this model are relevant to latency/cost, but we keep it per category for clarity)
      const lat = [
        ...trials.flatMap((t) => t.arms.filter((a) => a.modelId === id && a.latencyMs !== null && !a.simulated).map((a) => a.latencyMs!)),
        ...runs.filter((r) => r.modelId === id && !r.simulated).flatMap((r) => r.results.filter((x) => x.latencyMs !== null && !x.error).map((x) => x.latencyMs!)),
        ...usage.filter((u) => u.modelId === id && u.category === category && u.latencyMs !== null && u.status === "success").map((u) => u.latencyMs!),
      ];
      const costRows = [
        ...trials.flatMap((t) => t.arms.filter((a) => a.modelId === id).map((a) => a.cost)),
        ...runs.filter((r) => r.modelId === id).flatMap((r) => r.results.map((x) => x.cost)),
      ];
      const known = costRows.filter((c): c is number => c !== null);
      const calls = usage.filter((u) => u.modelId === id && u.category === category);
      const benchCalls = runs.filter((r) => r.modelId === id).flatMap((r) => r.results);
      const errN = calls.filter((u) => u.status === "error").length + benchCalls.filter((x) => x.error).length;
      const callN = calls.length + benchCalls.length;
      return {
        modelId: id,
        displayName: names.get(id) ?? id,
        personal: {
          trials: decided + bothBad,
          wins,
          losses,
          ties,
          bothBad,
          winRate: decided ? wilson(wins + ties / 2, decided) : null,
          avgRating: mean(ratings),
          ratingN: ratings.length,
        },
        benchmark: {
          items,
          passed,
          passRate: items ? wilson(passed, items) : null,
          meanScore: mean(scores),
          testSets: [...sets.values()],
          sufficient: items >= opts.minBenchmarkItems,
        },
        ops: {
          latencyN: lat.length,
          p50: lat.length >= 3 ? quantile(lat, 0.5) : null,
          p95: lat.length >= 20 ? quantile(lat, 0.95) : null,
          costN: known.length,
          meanCost: mean(known),
          costPartial: known.length > 0 && known.length < costRows.length,
          calls: callN,
          errorRate: callN >= 10 ? errN / callN : null,
        },
        version: { current: v.current, seen: v.seen, priorObservations: prior, drift: drift(id, input.benchmarks, v.current, opts) },
      };
    });

    // Pairwise preferences (time-decayed, prior versions down-weighted; interval uses the raw count).
    const pairwise: PairwiseResult[] = [];
    const comparisons: Comparison[] = [];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [ids[i]!, ids[j]!];
        let wa = 0, wt = 0, n = 0;
        for (const t of trials) {
          const armA = t.arms.find((x) => x.modelId === a);
          const armB = t.arms.find((x) => x.modelId === b);
          if (!armA || !armB || t.winner === "both_bad") continue;
          const va = versionWeights(a, input.trials, input.benchmarks);
          const vb = versionWeights(b, input.trials, input.benchmarks);
          const w = decayWeight(t.createdAt, opts.now, opts.halfLifeDays) * (va.isPrior(armA.servedModel) ? opts.priorVersionWeight : 1) * (vb.isPrior(armB.servedModel) ? opts.priorVersionWeight : 1);
          n++;
          wt += w;
          const share = t.winner === "tie" ? 0.5 : t.winner === armA.label ? 1 : 0;
          wa += w * share;
          if (share > 0) comparisons.push({ a, b, w: share });
          if (share < 1) comparisons.push({ a: b, b: a, w: 1 - share });
        }
        if (n === 0) continue;
        const p = wt ? wa / wt : 0.5;
        const ci = wilson(p * n, n);
        const verdict: PairwiseResult["verdict"] =
          n < opts.minPairTrials ? "insufficient" : ci.low > 0.5 ? "a_preferred" : ci.high < 0.5 ? "b_preferred" : "no_clear_difference";
        pairwise.push({ a, b, n, aPreferred: Math.round(p * 1000) / 1000, interval: { low: ci.low, high: ci.high }, verdict, needed: Math.max(0, opts.minPairTrials - n) });
      }

    // Paired benchmark comparisons on identical test-set versions (McNemar exact).
    const paired: PairedBenchmark[] = [];
    const hashes = [...new Set(runs.map((r) => r.testSetHash))];
    for (const h of hashes) {
      const withSet = [...new Set(runs.filter((r) => r.testSetHash === h).map((r) => r.modelId))];
      for (let i = 0; i < withSet.length; i++)
        for (let j = i + 1; j < withSet.length; j++) {
          const [a, b] = [withSet[i]!, withSet[j]!];
          const ra = latestItemResults(runs, a, h);
          const rb = latestItemResults(runs, b, h);
          let shared = 0, aOnly = 0, bOnly = 0;
          for (const [item, pa] of ra) {
            if (!rb.has(item)) continue;
            shared++;
            const pb = rb.get(item)!;
            if (pa && !pb) aOnly++;
            if (!pa && pb) bOnly++;
          }
          const disc = aOnly + bOnly;
          const pValue = disc >= opts.minDiscordant ? binomialTwoSided(Math.min(aOnly, bOnly), disc) : null;
          paired.push({
            a,
            b,
            testSetId: runs.find((r) => r.testSetHash === h)!.testSetId,
            shared,
            aOnly,
            bOnly,
            pValue,
            verdict: pValue === null ? "insufficient" : pValue >= 0.05 ? "no_clear_difference" : aOnly > bOnly ? "a_better" : "b_better",
          });
        }
    }

    const strengths = bradleyTerry(ids, comparisons);
    const ranks = bootstrapRanks(ids, comparisons, 120);
    const ranking = ids
      .map((id) => ({ modelId: id, strength: Math.round((strengths.get(id) ?? 1) * 1000) / 1000, rankLow: ranks.get(id)!.low, rankHigh: ranks.get(id)!.high }))
      .sort((a, b) => b.strength - a.strength);

    return {
      category,
      models,
      pairwise,
      paired,
      ranking,
      personal: personalRecommendation(models, pairwise, ranking, names, opts),
      general: generalRecommendation(models, paired, names, opts),
    };
  });

  return {
    generatedAt: opts.now,
    options: opts,
    categories,
    totals: { trials: input.trials.length, benchmarkRuns: input.benchmarks.length, usageRows: usage.length },
  };
}

function personalRecommendation(
  models: ModelStats[],
  pairwise: PairwiseResult[],
  ranking: CategoryFingerprint["ranking"],
  names: Map<string, string>,
  opts: FingerprintOptions,
): CategoryRecommendation {
  const withTrials = models.filter((m) => m.personal.trials > 0);
  if (withTrials.length < 2 || !pairwise.length)
    return { modelId: null, sufficiency: "insufficient", basis: "personal_preference", reasons: ["No blind trials in this category yet. Run some to learn your own preference."] };
  const leader = ranking.find((r) => withTrials.some((m) => m.modelId === r.modelId))!.modelId;
  const vsLeader = pairwise.filter((p) => p.a === leader || p.b === leader);
  const beats = (p: PairwiseResult) => (p.a === leader ? p.verdict === "a_preferred" : p.verdict === "b_preferred");
  const name = names.get(leader) ?? leader;
  const total = pairwise.reduce((n, p) => n + p.n, 0);
  if (vsLeader.length && vsLeader.every(beats) && vsLeader.length === withTrials.length - 1)
    return {
      modelId: leader,
      sufficiency: "clear",
      basis: "personal_preference",
      reasons: [`In ${total} blind trials you preferred ${name} over every other model tested, and each 95% interval excludes a coin flip.`],
    };
  const thin = pairwise.filter((p) => p.verdict === "insufficient");
  if (vsLeader.every((p) => p.verdict === "insufficient"))
    return {
      modelId: leader,
      sufficiency: "insufficient",
      basis: "personal_preference",
      reasons: [
        `Too few blind trials to say anything yet: every pairing has fewer than ${opts.minPairTrials} (${thin.map((p) => `${names.get(p.a) ?? p.a} vs ${names.get(p.b) ?? p.b}: ${p.n}`).join("; ")}).`,
      ],
    };
  return {
    modelId: leader,
    sufficiency: "tentative",
    basis: "personal_preference",
    reasons: [
      `${name} leads by point estimate, but the evidence does not yet separate it from the alternatives.`,
      thin.length
        ? `${thin.length} pairing(s) have fewer than ${opts.minPairTrials} trials (${thin.map((p) => `${names.get(p.a) ?? p.a} vs ${names.get(p.b) ?? p.b}: ${p.n}`).join("; ")}).`
        : "Pairings have enough trials but the preference intervals overlap 50%.",
    ],
  };
}

function generalRecommendation(models: ModelStats[], paired: PairedBenchmark[], names: Map<string, string>, opts: FingerprintOptions): CategoryRecommendation {
  const measured = models.filter((m) => m.benchmark.items > 0).sort((a, b) => (b.benchmark.passRate?.p ?? 0) - (a.benchmark.passRate?.p ?? 0));
  if (!measured.length)
    return { modelId: null, sufficiency: "insufficient", basis: "general_benchmark", reasons: ["No benchmark runs in this category yet."] };
  const top = measured[0]!;
  const name = names.get(top.modelId) ?? top.modelId;
  if (!top.benchmark.sufficient)
    return {
      modelId: top.modelId,
      sufficiency: "insufficient",
      basis: "general_benchmark",
      reasons: [`${name} has the best pass rate so far, but only ${top.benchmark.items} scored items (minimum ${opts.minBenchmarkItems}).`],
    };
  if (measured.length === 1)
    return { modelId: top.modelId, sufficiency: "tentative", basis: "general_benchmark", reasons: [`Only ${name} has been benchmarked in this category; nothing to compare against.`] };
  const vs = paired.filter((p) => p.a === top.modelId || p.b === top.modelId);
  const wins = vs.filter((p) => (p.a === top.modelId ? p.verdict === "a_better" : p.verdict === "b_better"));
  const others = measured.slice(1).filter((m) => m.benchmark.sufficient);
  if (others.length && others.every((o) => wins.some((p) => p.a === o.modelId || p.b === o.modelId)))
    return {
      modelId: top.modelId,
      sufficiency: "clear",
      basis: "general_benchmark",
      reasons: [`${name} passed significantly more of the same test items than every other sufficiently-tested model (paired exact test, p < 0.05).`],
    };
  return {
    modelId: top.modelId,
    sufficiency: "tentative",
    basis: "general_benchmark",
    reasons: [`${name} has the highest pass rate (${Math.round((top.benchmark.passRate?.p ?? 0) * 100)}%), but paired comparisons on the same items are not significant yet.`],
  };
}
