"use client";
/**
 * Browser storage for guests (no Supabase). Everything is wrapped in try/catch
 * so private windows and blocked storage degrade to "nothing saved" rather
 * than crashing. Signed-in users' data lives in Supabase instead.
 */
import type { Arena } from "@/lib/claims/hypothesis";
import type { ClaimReport } from "@/lib/claims/types";
import type { BenchmarkRun, TrialRecord } from "@/lib/intel/types";

const KEYS = {
  reports: "nova.claimReports.v1",
  arenas: "nova.arenas.v1",
  trials: "nova.trials.v1",
  benchmarks: "nova.benchmarks.v1",
  customSets: "nova.customTestSets.v1",
  handoff: "nova.claimHandoff.v1",
} as const;

const LIMITS = { reports: 20, arenas: 30, trials: 1000, benchmarks: 200, customSets: 20 };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable */
  }
}

function upsert<T extends { id: string }>(key: string, item: T, limit: number) {
  const list = read<T[]>(key, []).filter((x) => x.id !== item.id);
  write(key, [item, ...list].slice(0, limit));
}

function remove(key: string, id: string) {
  write(key, read<{ id: string }[]>(key, []).filter((x) => x.id !== id));
}

export const localReports = {
  list: () => read<ClaimReport[]>(KEYS.reports, []),
  save: (r: ClaimReport) => upsert(KEYS.reports, r, LIMITS.reports),
  remove: (id: string) => remove(KEYS.reports, id),
};
export const localArenas = {
  list: () => read<Arena[]>(KEYS.arenas, []),
  save: (a: Arena) => upsert(KEYS.arenas, a, LIMITS.arenas),
  remove: (id: string) => remove(KEYS.arenas, id),
};
export const localTrials = {
  list: () => read<TrialRecord[]>(KEYS.trials, []),
  save: (t: TrialRecord) => upsert(KEYS.trials, t, LIMITS.trials),
  remove: (id: string) => remove(KEYS.trials, id),
};
export const localBenchmarks = {
  list: () => read<BenchmarkRun[]>(KEYS.benchmarks, []),
  save: (r: BenchmarkRun) => upsert(KEYS.benchmarks, r, LIMITS.benchmarks),
  remove: (id: string) => remove(KEYS.benchmarks, id),
};

export interface ClaimHandoff {
  question: string;
  answer: string;
  sources: { index: number; url: string; title: string; text: string; publishedAt: string | null; provider: string | null }[];
}

/** Search → Claim DNA handoff, kept in sessionStorage so it never outlives the tab. */
export const handoff = {
  set(h: ClaimHandoff) {
    try {
      sessionStorage.setItem(KEYS.handoff, JSON.stringify(h));
    } catch {
      /* ignore */
    }
  },
  take(): ClaimHandoff | null {
    try {
      const raw = sessionStorage.getItem(KEYS.handoff);
      sessionStorage.removeItem(KEYS.handoff);
      return raw ? (JSON.parse(raw) as ClaimHandoff) : null;
    } catch {
      return null;
    }
  },
};
