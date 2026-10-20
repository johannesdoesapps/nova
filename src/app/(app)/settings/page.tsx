import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck, CircleAlert } from "lucide-react";
import { SettingsClient } from "@/components/common/settings-client";
import { Badge, Card, PageHeader } from "@/components/ui/primitives";
import { integrationStatus, serverEnv } from "@/lib/env";
import { loadShellData } from "@/lib/session-data";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { auth, integrations } = await loadShellData();
  const status = integrationStatus();
  const env = serverEnv();

  return (
    <div className="mx-auto max-w-4xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Settings" description="Account, appearance and the integrations this deployment has configured." />

      <div className="space-y-6">
        <Card className="p-5">
          <h2 className="font-medium">Account</h2>
          {auth.mode === "authenticated" ? (
            <SettingsClient email={auth.user.email} displayName={auth.user.displayName} />
          ) : integrations.supabase ? (
            <p className="mt-2 text-sm text-muted"><Link href="/login" className="text-accent hover:underline">Sign in</Link> to manage your account.</p>
          ) : (
            <p className="mt-2 text-sm text-muted">Accounts are disabled until Supabase is configured. Orbis is running in guest/demo mode — nothing is saved.</p>
          )}
          {auth.mode !== "authenticated" && <SettingsClient themeOnly />}
        </Card>

        <Card className="p-5">
          <h2 className="font-medium">Integrations</h2>
          <p className="mt-1 text-sm text-muted">Values are read from environment variables on the server and are never sent to the browser — only whether each one is set.</p>
          <ul className="mt-4 divide-y divide-border">
            {status.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  {s.configured ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{s.label}</div>
                    <div className="text-xs text-faint">{s.purpose}</div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 pl-7 sm:pl-0">
                  {s.envVars.map((v) => <code key={v} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{v}</code>)}
                  {s.configured ? <Badge tone="success">Configured</Badge> : <Badge tone="warning">{s.id === "sentry" ? "Optional" : "Missing"}</Badge>}
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5">
          <h2 className="font-medium">Limits</h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-bg-elev p-3"><dt className="text-xs text-faint">Requests per minute</dt><dd className="mt-1 font-semibold">{env.ratePerMinute}</dd></div>
            <div className="rounded-xl border border-border bg-bg-elev p-3"><dt className="text-xs text-faint">Model runs per day</dt><dd className="mt-1 font-semibold">{env.dailyRequestLimit}</dd></div>
            <div className="rounded-xl border border-border bg-bg-elev p-3"><dt className="text-xs text-faint">Models per battle</dt><dd className="mt-1 font-semibold">{env.maxCompareModels}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-faint">Set with NOVA_RATE_LIMIT_PER_MINUTE, NOVA_DAILY_REQUEST_LIMIT and NOVA_MAX_COMPARE_MODELS. Also set spending limits in each provider&apos;s dashboard.</p>
        </Card>
      </div>
    </div>
  );
}
