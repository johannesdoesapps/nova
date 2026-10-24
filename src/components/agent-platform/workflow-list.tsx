"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api } from "@/components/code/api";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { TEMPLATE_INFO, type WorkflowStatus } from "@/lib/agent-platform/workflow";
import type { WorkflowView } from "@/lib/agent-platform/workflow-server";
import { ago } from "@/lib/home";

const STATUS: Record<WorkflowStatus, string> = {
  running: "Working",
  waiting: "Waiting for you",
  needs_approval: "Ready for your decision",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
};

/** The templates and the user's workflows, newest first. */
export function WorkflowList() {
  const { user } = useApp();
  const [list, setList] = useState<WorkflowView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!user) return;
    api<{ workflows: WorkflowView[] }>("/api/workflows")
      .then((r) => setList(r.workflows))
      .catch((e: Error) => setError(e.message));
  }, [user]);
  const t = TEMPLATE_INFO.fix_and_verify;
  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">
          <Link href="/agents" className="hover:text-s-ink">
            Agents
          </Link>{" "}
          / Workflows
        </span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-20 pt-2 sm:px-8">
          <h1 className="font-serif text-[clamp(30px,4.5vw,40px)] leading-[1.08] tracking-[-0.01em]">Workflows</h1>
          <p className="mt-1.5 text-[15px] text-s-ink-2">
            Agents working in a fixed order on one project. Each step is an ordinary task with its own approvals; the workflow ends with your decision, and never pushes or deploys anything.
          </p>

          <article className="glass mt-6 rounded-[22px] p-5">
            <h2 className="text-[16px] font-semibold">{t.name}</h2>
            <p className="mt-1 text-[13.5px] text-s-ink-2">{t.description}</p>
            <ol className="mt-3 list-decimal space-y-0.5 pl-5 text-[13.5px] text-s-ink-2">
              {t.steps.map((s) => (
                <li key={s.key}>{s.label}</li>
              ))}
            </ol>
            <Link
              href="/agents/bug-fixer?workflow=1"
              className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-xl bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink hover:brightness-110"
            >
              Start: describe the bug <ArrowRight className="h-4 w-4" />
            </Link>
          </article>

          <section aria-labelledby="past-workflows" className="mt-8">
            <h2 id="past-workflows" className="text-[17px] font-semibold">
              Your workflows
            </h2>
            {!user ? (
              <p className="mt-3 text-[13.5px] text-s-ink-2">
                <Link href="/login?next=/agents/workflows" className="text-s-accent underline-offset-4 hover:underline">
                  Sign in
                </Link>{" "}
                to see your workflows.
              </p>
            ) : error ? (
              <p role="alert" className="mt-3 text-[13.5px] text-s-danger">
                {error}
              </p>
            ) : list === null ? (
              <div className="s-skeleton mt-3 h-16 rounded-2xl" />
            ) : list.length === 0 ? (
              <p className="mt-3 rounded-2xl border border-dashed border-s-line-strong px-4 py-6 text-center text-[13.5px] text-s-ink-2">No workflows yet.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {list.map((w) => (
                  <li key={w.id} className="rounded-2xl border border-s-line p-3.5 hover:border-s-line-strong">
                    <Link href={`/agents/workflows/${w.id}`} className="block text-[14px] font-medium hover:underline">
                      {w.summary}
                    </Link>
                    <p className="mt-0.5 text-[12.5px] text-s-ink-3">
                      <span className="font-medium text-s-ink-2">{STATUS[w.status]}</span>
                      {w.projectName ? ` · ${w.projectName}` : ""} · step {Math.min(w.current + 1, w.steps.length)} of {w.steps.length} · <span suppressHydrationWarning>{ago(w.updated_at)}</span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
