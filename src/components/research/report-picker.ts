"use client";
import { useEffect, useState } from "react";
import { useApp } from "@/components/layout/app-context";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { ClaimReport } from "@/lib/claims/types";
import { localReports } from "./local-store";

/** Load one claim report (by id) plus a list of recent ones, from Supabase or this browser. */
export function useReports(reportId: string | null) {
  const { user } = useApp();
  const [list, setList] = useState<{ id: string; question: string; created_at: string }[]>([]);
  const [report, setReport] = useState<ClaimReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (user) {
      void jsonFetch<{ reports: { id: string; question: string; created_at: string }[] }>("/api/claims/reports").then((r) => alive && setList(r.reports)).catch(() => {});
      if (reportId)
        void jsonFetch<{ report: ClaimReport }>(`/api/claims/reports/${reportId}`)
          .then((r) => alive && setReport(r.report))
          .catch((e) => alive && setError((e as Error).message));
    } else {
      const local = localReports.list();
      // Reading browser storage on mount is the intended effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setList(local.map((r) => ({ id: r.id, question: r.question, created_at: r.createdAt })));
      setReport(reportId ? (local.find((r) => r.id === reportId) ?? null) : null);
    }
    return () => {
      alive = false;
    };
  }, [user, reportId]);

  return { list, report, error, setReport };
}
