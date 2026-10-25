/**
 * The Security dashboard's pieces render with realistic data: agents with each status, posture counts, events,
 * connections and schedules — and say "no activity" honestly when nothing has run.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) }));

import { AgentGrid, NextActions, PostureCard, RecentEvents, ScheduleManager, TeamStrip } from "@/components/security/team-overview";
import { teamAgents } from "@/lib/security/team-agents";

const agents = teamAgents({
  runs: [
    { id: "r1", parent_id: null, agent: "sentinel", action: "cloudflare", status: "failed", asset: "cloudflare:shop.com", tools: [], error: "Token can't list zones.", started_at: "2026-10-25T10:00:00Z", finished_at: "2026-10-25T10:01:00Z" },
    { id: "r2", parent_id: null, agent: "code_guardian", action: "pr_audit", status: "running", asset: "github:acme/app/tree/pull/7/head", tools: [], error: null, started_at: "2026-10-25T11:00:00Z", finished_at: null },
  ],
  events: [],
  integrations: [{ id: "github", status: "connected", writeEnabled: false }],
  fixesAwaitingApproval: 1,
  activeSchedules: 0,
  alertsByEmail: true,
});
const team = {
  agents,
  integrations: [
    { id: "github" as const, available: true, status: "connected", account: "@acme", writeEnabled: false, lastCheckedAt: null, lastError: null },
    { id: "vercel" as const, available: false, status: "not_connected", account: null, writeEnabled: false, lastCheckedAt: null, lastError: null },
    { id: "cloudflare" as const, available: true, status: "reauth_required", account: null, writeEnabled: false, lastCheckedAt: null, lastError: "Token expired" },
  ],
  bySeverity: { critical: 1, high: 2, medium: 0, low: 3, info: 0 },
  byVerification: { confirmed: 1, likely: 2, needs_verification: 3, informational: 0 },
  status: { open: 6, awaitingVerification: 1, fixedVerified: 2, acceptedRisk: 0, falsePositive: 1 },
  newThisWeek: 4,
  reopenedAlertsThisWeek: 0,
  lastAudit: { id: "r1", agent: "sentinel", action: "cloudflare", asset: "cloudflare:shop.com", at: "2026-10-25T10:01:00Z" },
  events: [{ id: 1, label: "Raised an alert", at: "2026-10-25T10:02:00Z", runId: "r1", findingId: null }],
  next: [{ text: "3 open finding(s) still need verification", href: "/agents/security?tab=findings" }, { text: "Run a Cloudflare protection review.", action: "cloudflare" }],
};

describe("Security dashboard pieces", () => {
  it("render agents with real statuses, summaries and permissions", () => {
    const html = renderToStaticMarkup(h(AgentGrid, { team }));
    expect(html.match(/<article/g)).toHaveLength(11);
    expect(html).toContain("Working");
    expect(html).toContain("Needs approval");
    expect(html).toContain("Error");
    expect(html).toContain("Token can&#x27;t list zones.");
    expect(html).toContain("GitHub: read-only");
    expect(html).toContain("No activity yet.");
    // Every agent has its own logo badge and an engine line, like the engine cards.
    expect(html.match(/bg-gradient-to-br/g)).toHaveLength(11);
    expect(html).toContain("Code Guardian on GitHub");
  });

  it("render the overview: posture, next actions, team strip, events and schedules", () => {
    const html = [
      renderToStaticMarkup(h(PostureCard, { team, onSeverity: () => {} })),
      renderToStaticMarkup(h(NextActions, { team, onLaunch: () => {} })),
      renderToStaticMarkup(h(TeamStrip, { team, onOpen: () => {} })),
      renderToStaticMarkup(h(RecentEvents, { team })),
      renderToStaticMarkup(h(ScheduleManager, { sched: { schedules: [], alerts: { email: true, minSeverity: "high" } }, integrations: team.integrations, onChanged: () => {} })),
    ].join("");
    expect(html).toContain("Open findings");
    expect(html).toContain("need verification");
    expect(html).toContain("See all 11 agents");
    expect(html).toContain("No scheduled audits yet.");
    expect(html).toContain('href="/agents/security?tab=findings"');
  });
});
