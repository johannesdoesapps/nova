import { describe, expect, it } from "vitest";
import { featureLabel, groupUsage, type UsageRow } from "@/lib/usage-labels";

const row = (p: Partial<UsageRow>): UsageRow => ({
  at: "2026-10-21T10:00:00Z",
  model: "Claude Haiku 5.5",
  requested: null,
  fallbackFrom: null,
  feature: "chat",
  units: 1,
  status: "success",
  errorCode: null,
  notCounted: false,
  ...p,
});

describe("usage history", () => {
  it("names features from the recorded purposes, and keeps unknown ones as recorded", () => {
    expect(featureLabel("chat")).toBe("Chat");
    expect(featureLabel(null)).toBe("Chat");
    expect(featureLabel("council-synthesis")).toBe("Council");
    expect(featureLabel("arena-final")).toBe("Arena");
    expect(featureLabel("compare")).toBe("Arena");
    expect(featureLabel("code_agent")).toBe("Coding agent");
    expect(featureLabel("connector_plan")).toBe("Connectors");
    expect(featureLabel("something_new")).toBe("something_new");
  });

  it("totals units by model and feature from the records only", () => {
    const rows = [
      row({ model: "Claude Sonnet 5.5", units: 20 }),
      row({ units: 1 }),
      row({ feature: "council", units: 1 }),
      row({ status: "error", units: 0, errorCode: "timeout" }),
      row({ units: null }),
      row({ model: "Claude Opus 5.5", units: 40, notCounted: true }),
    ];
    expect(groupUsage(rows, "model")).toEqual([
      { key: "Claude Sonnet 5.5", requests: 1, units: 20, failed: 0 },
      { key: "Claude Haiku 5.5", requests: 4, units: 2, failed: 1 },
      { key: "Claude Opus 5.5", requests: 1, units: 0, failed: 0 },
    ]);
    expect(groupUsage(rows, "feature").map((g) => [g.key, g.units])).toEqual([
      ["Chat", 21],
      ["Council", 1],
    ]);
  });

  it("keeps days in date order", () => {
    const days = groupUsage([row({ at: "2026-10-21T09:00:00Z" }), row({ at: "2026-10-20T09:00:00Z", units: 5 })], "day", "en-GB");
    expect(days.map((d) => d.units)).toEqual([1, 5]);
  });
});
