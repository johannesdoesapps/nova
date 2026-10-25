/**
 * Security Team stage 6: background audits stay inside one person's data (the scoped service client), schedules and
 * alert settings are reconstructed from the append-only log, due-ness is computed honestly, and alerts fire only for
 * new or reopened serious findings that are confirmed or likely — with no evidence in the email.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { alertText, alertWorthy, currentAlertSettings, currentSchedules, DEFAULT_ALERTS, isDue, lastRuns, nextRun, scheduleInput, type AuditEvent, type Schedule } from "@/lib/security/schedules";
import { userScopedDb } from "@/lib/security/scoped-db";
import type { FindingDraft } from "@/lib/security/types";

const U = "11111111-2222-3333-4444-555555555555";

/** A fake query builder that records every call. */
function fakeDb() {
  const calls: { table: string; op: string; args: unknown[]; filters: [string, unknown][] }[] = [];
  const builder = (rec: (typeof calls)[number]) => {
    const b: Record<string, unknown> = {};
    b.eq = (col: string, v: unknown) => (rec.filters.push([col, v]), b);
    b.select = () => b;
    return b;
  };
  return {
    calls,
    from(table: string) {
      const make = (op: string) => (...args: unknown[]) => {
        const rec = { table, op, args, filters: [] as [string, unknown][] };
        calls.push(rec);
        return builder(rec);
      };
      return { select: make("select"), insert: make("insert"), upsert: make("upsert"), update: make("update"), delete: make("delete") };
    },
  };
}

describe("scoped service client (tenant isolation for background audits)", () => {
  it("filters every read, update and delete by the user, and forces the user on inserts", () => {
    const f = fakeDb();
    const db = userScopedDb(f as never, U) as unknown as ReturnType<typeof fakeDb>;
    db.from("security_findings").select("id");
    db.from("security_findings").update({ status: "open", user_id: "someone-else" });
    db.from("security_runs").delete();
    db.from("security_audit").insert({ action: "x", user_id: "someone-else" });
    db.from("connector_accounts").upsert([{ connector_id: "github" }]);
    expect(f.calls.map((c) => [c.op, c.filters])).toEqual([
      ["select", [["user_id", U]]],
      ["update", [["user_id", U]]],
      ["delete", [["user_id", U]]],
      ["insert", []],
      ["upsert", []],
    ]);
    expect(f.calls[1]!.args[0]).toEqual({ status: "open" });
    expect(f.calls[3]!.args[0]).toEqual({ action: "x", user_id: U });
    expect(f.calls[4]!.args[0]).toEqual([{ connector_id: "github", user_id: U }]);
  });

  it("refuses other tables and database functions", () => {
    const db = userScopedDb(fakeDb() as never, U);
    expect(() => db.from("profiles" as never)).toThrow(/can't use the profiles table/);
    expect(() => (db as unknown as { rpc: () => void }).rpc()).toThrow(/database functions/);
  });

  it("needs a real user id", () => {
    expect(() => userScopedDb(fakeDb() as never, "")).toThrow();
    expect(() => userScopedDb(fakeDb() as never, "x' or 1=1")).toThrow();
  });
});

const ev = (action: string, detail: Record<string, unknown>, at: string): AuditEvent => ({ action, detail, created_at: at });

describe("schedules from the event log", () => {
  const a = { kind: "repository", repo: "acme/app", frequency: "daily", enabled: true };
  it("applies sets in order and removals, ignoring malformed entries", () => {
    const s = currentSchedules([
      ev("schedule.set", { id: "s1", schedule: a }, "2026-10-01T00:00:00Z"),
      ev("schedule.set", { id: "s2", schedule: { kind: "cloudflare", zone: null, frequency: "weekly" } }, "2026-10-02T00:00:00Z"),
      ev("schedule.set", { id: "s1", schedule: { ...a, frequency: "weekly" } }, "2026-10-03T00:00:00Z"),
      ev("schedule.set", { id: "s3", schedule: { kind: "repository", repo: "../etc/passwd", frequency: "daily" } }, "2026-10-03T00:00:00Z"),
      ev("schedule.removed", { id: "s2" }, "2026-10-04T00:00:00Z"),
    ]);
    expect(s.map((x) => [x.id, x.frequency, x.createdAt])).toEqual([["s1", "weekly", "2026-10-01T00:00:00Z"]]);
  });

  it("validates targets strictly", () => {
    expect(scheduleInput.safeParse({ kind: "deployment", project: "shop", teamId: "team_abc", frequency: "daily" }).success).toBe(true);
    expect(scheduleInput.safeParse({ kind: "deployment", project: "shop?x=1", teamId: null, frequency: "daily" }).success).toBe(false);
    expect(scheduleInput.safeParse({ kind: "website", host: "x.com", frequency: "daily" }).success).toBe(false);
  });

  it("is due by frequency, never when paused, and reports the next run", () => {
    const s = { ...a, id: "s1", createdAt: "", updatedAt: "" } as Schedule;
    const now = Date.parse("2026-10-25T07:17:00Z");
    expect(isDue(s, undefined, now)).toBe(true);
    expect(isDue(s, { at: "2026-10-24T07:17:30Z" }, now)).toBe(true);
    expect(isDue(s, { at: "2026-10-25T01:00:00Z" }, now)).toBe(false);
    expect(isDue({ ...s, frequency: "weekly" }, { at: "2026-10-20T07:17:00Z" }, now)).toBe(false);
    expect(isDue({ ...s, enabled: false }, undefined, now)).toBe(false);
    expect(nextRun({ ...s, enabled: false }, undefined, now)).toBeNull();
    const last = lastRuns([ev("schedule.ran", { id: "s1", runId: "r1", outcome: "completed" }, "2026-10-20T07:17:00Z"), ev("schedule.ran", { id: "s1", runId: "r2", outcome: "failed: x" }, "2026-10-21T07:17:00Z")]);
    expect(last.get("s1")).toEqual({ at: "2026-10-21T07:17:00Z", runId: "r2", outcome: "failed: x" });
  });
});

const draft = (over: Partial<FindingDraft>): FindingDraft => ({
  agent: "sentinel",
  ruleId: "x",
  fingerprint: Math.random().toString(36),
  title: "T",
  description: "D",
  severity: "high",
  confidence: "confirmed",
  rationale: "",
  asset: "a",
  location: "src/a.ts:1",
  evidence: [{ source: "s", detail: "SECRET_EVIDENCE sk_live_abc" }],
  evidenceSource: "e",
  remediation: "",
  references: [],
  ...over,
});

describe("alerts", () => {
  beforeEach(() => vi.useRealTimers());

  it("alert only on new or reopened serious findings that are confirmed or likely", () => {
    const fresh = draft({ title: "new high" });
    const reopened = draft({ title: "reopened critical", severity: "critical", confidence: "firm" });
    const lead = draft({ title: "unverified", confidence: "tentative" });
    const old = draft({ title: "seen before" });
    const low = draft({ title: "low", severity: "low" });
    const r = alertWorthy([fresh, reopened, lead, old, low], { createdFingerprints: [fresh.fingerprint, lead.fingerprint, low.fingerprint], reopenedFingerprints: [reopened.fingerprint] }, DEFAULT_ALERTS);
    expect(r.map((x) => [x.finding.title, x.reopened])).toEqual([
      ["reopened critical", true],
      ["new high", false],
    ]);
    expect(alertWorthy([fresh], { createdFingerprints: [fresh.fingerprint], reopenedFingerprints: [] }, { email: true, minSeverity: "critical" })).toEqual([]);
  });

  it("keeps evidence out of the email", () => {
    const { subject, text } = alertText([{ finding: draft({ title: "Origin exposed" }), reopened: false }], "https://tryorbis.app/agents/security/runs/1");
    expect(subject).toMatch(/Origin exposed/);
    expect(text).not.toContain("SECRET_EVIDENCE");
    expect(text).toContain("https://tryorbis.app/agents/security/runs/1");
  });

  it("reads the latest valid alert settings, with safe defaults", () => {
    expect(currentAlertSettings([])).toEqual(DEFAULT_ALERTS);
    expect(currentAlertSettings([ev("alerts.settings", { email: false, minSeverity: "critical" }, "2026-10-02T00:00:00Z"), ev("alerts.settings", { email: true, minSeverity: "high" }, "2026-10-01T00:00:00Z")])).toEqual({ email: false, minSeverity: "critical" });
  });
});

describe("running due schedules", () => {
  it("runs each due schedule as its owner, without AI, through the scoped client, and records the attempt", async () => {
    const seen: { kind: string; userId: string; noAi: boolean | undefined; scopedOk: boolean }[] = [];
    vi.doMock("@/lib/ai/settings", () => ({ getPlatformSettings: async () => ({ pausedAgents: [] }) }));
    vi.doMock("@/lib/observability", () => ({ reportError: () => {} }));
    vi.doMock("@/lib/security/runners", () => {
      const run = (kind: string) => async (ctx: { auth: { user: { id: string }; supabase: { from: (t: string) => unknown } }; noAi?: boolean; send: (e: Record<string, unknown>) => void }) => {
        let scopedOk = false;
        try {
          ctx.auth.supabase.from("profiles");
        } catch {
          scopedOk = true;
        }
        seen.push({ kind, userId: ctx.auth.user.id, noAi: ctx.noAi, scopedOk });
        ctx.send({ type: "run", runId: `run-${kind}` });
        if (kind === "cloudflare") throw new Error("token expired");
      };
      return { runGuardianAgent: run("repository"), runDeploymentAudit: run("deployment"), runCloudflareAudit: run("cloudflare") };
    });
    const { runDueSchedules } = await import("@/lib/security/scheduler");
    const U2 = "99999999-2222-3333-4444-555555555555";
    const rows = [
      { user_id: U, ...ev("schedule.set", { id: "a", schedule: { kind: "repository", repo: "acme/app", frequency: "daily", enabled: true } }, "2026-10-01T00:00:00Z") },
      { user_id: U2, ...ev("schedule.set", { id: "b", schedule: { kind: "cloudflare", zone: "x.com", frequency: "daily", enabled: true } }, "2026-10-01T00:00:00Z") },
      { user_id: U2, ...ev("schedule.set", { id: "c", schedule: { kind: "deployment", project: "shop", teamId: null, frequency: "weekly", enabled: true } }, "2026-10-01T00:00:00Z") },
    ];
    const ran = [{ user_id: U2, ...ev("schedule.ran", { id: "c", outcome: "completed" }, "2026-10-24T07:17:00Z") }];
    const inserts: { table: string; row: Record<string, unknown>; filters: string }[] = [];
    const service = {
      from(table: string) {
        const q = {
          _ran: false,
          select: () => q,
          in: () => q,
          order: () => q,
          gte: () => ((q._ran = true), q),
          eq: () => q,
          limit: async () => ({ data: q._ran ? ran : rows, error: null }),
          insert: (row: Record<string, unknown>) => (inserts.push({ table, row, filters: "" }), Promise.resolve({ error: null })),
        };
        return q;
      },
    };
    const r = await runDueSchedules(service as never, { budgetMs: 60_000, now: Date.parse("2026-10-25T07:17:00Z") });
    expect(seen).toEqual([
      { kind: "repository", userId: U, noAi: true, scopedOk: true },
      { kind: "cloudflare", userId: U2, noAi: true, scopedOk: true },
    ]);
    expect("ran" in r && r.ran.map((x) => [x.id, x.outcome.split(":")[0], x.runId])).toEqual([
      ["a", "completed", "run-repository"],
      ["b", "failed", "run-cloudflare"],
    ]);
    expect(inserts.map((i) => [i.table, i.row.user_id, (i.row.detail as { id: string }).id])).toEqual([
      ["security_audit", U, "a"],
      ["security_audit", U2, "b"],
    ]);
  });
});
