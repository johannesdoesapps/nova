"use client";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/layout/app-context";
import { localBenchmarks, localTrials } from "@/components/research/local-store";
import type { BenchmarkRun, TrialRecord, UsageRow } from "@/lib/intel/types";

export interface IntelHistory {
  loading: boolean;
  error: string | null;
  guest: boolean;
  trials: TrialRecord[];
  benchmarks: BenchmarkRun[];
  usage: UsageRow[];
  reload: () => Promise<void>;
  addTrial: (t: TrialRecord, savedOnServer: boolean) => void;
  addBenchmark: (r: BenchmarkRun, savedOnServer: boolean) => void;
  remove: (kind: "trial" | "benchmark", id: string) => Promise<void>;
}

/** Evaluation history from Supabase (signed in) or this browser (guest). */
export function useIntelHistory(): IntelHistory {
  const { user } = useApp();
  const [state, setState] = useState<{ loading: boolean; error: string | null; trials: TrialRecord[]; benchmarks: BenchmarkRun[]; usage: UsageRow[] }>({ loading: true, error: null, trials: [], benchmarks: [], usage: [] });

  const reload = useCallback(async () => {
    if (!user) {
      setState({ loading: false, error: null, trials: localTrials.list(), benchmarks: localBenchmarks.list(), usage: [] });
      return;
    }
    try {
      const r = await fetch("/api/intel/history");
      if (!r.ok) throw new Error("Could not load your evaluation history.");
      const j = (await r.json()) as { trials: TrialRecord[]; benchmarks: BenchmarkRun[]; usage: UsageRow[] };
      setState({ loading: false, error: null, trials: j.trials, benchmarks: j.benchmarks, usage: j.usage });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, [user]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const addTrial = useCallback((t: TrialRecord, saved: boolean) => {
    if (!saved) localTrials.save(t);
    setState((s) => ({ ...s, trials: [t, ...s.trials.filter((x) => x.id !== t.id)] }));
  }, []);
  const addBenchmark = useCallback((r: BenchmarkRun, saved: boolean) => {
    if (!saved) localBenchmarks.save(r);
    setState((s) => ({ ...s, benchmarks: [r, ...s.benchmarks.filter((x) => x.id !== r.id)] }));
  }, []);
  const remove = useCallback(
    async (kind: "trial" | "benchmark", id: string) => {
      if (user) await fetch(`/api/intel/history?kind=${kind}&id=${encodeURIComponent(id)}`, { method: "DELETE" });
      else (kind === "trial" ? localTrials : localBenchmarks).remove(id);
      setState((s) => (kind === "trial" ? { ...s, trials: s.trials.filter((x) => x.id !== id) } : { ...s, benchmarks: s.benchmarks.filter((x) => x.id !== id) }));
    },
    [user],
  );

  return { ...state, guest: !user, reload, addTrial, addBenchmark, remove };
}
