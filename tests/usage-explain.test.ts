import { describe, expect, it } from "vitest";
import { explainCharge, type ChargeRecord } from "@/lib/usage-explain";

const rec = (o: Partial<ChargeRecord>): ChargeRecord => ({
  feature: "chat",
  status: "success",
  units: 1,
  baseUnits: 1,
  inputTokens: 2000,
  outputTokens: 800,
  paidWithCredits: false,
  notCounted: false,
  ...o,
});

describe("why a request used its units", () => {
  it("a typical-size message is charged the model's rate", () => {
    expect(explainCharge(rec({ units: 20, baseUnits: 20 }))).toBe("A typical message to this model uses 20 units; this one was charged at that rate (2,000 tokens read, 800 written).");
  });

  it("a larger request says how much larger and what it used", () => {
    expect(explainCharge(rec({ units: 3.2, baseUnits: 1, inputTokens: 9000, outputTokens: 1500 }))).toBe(
      "A typical message to this model uses 1 unit; this one was about 3.2× that size (9,000 tokens read, 1,500 written), so it used 3.2.",
    );
  });

  it("failed requests, background steps and admin accounts aren't charged", () => {
    expect(explainCharge(rec({ status: "error", units: 0 }))).toMatch(/^Not charged: the request failed/);
    expect(explainCharge(rec({ units: 0 }))).toMatch(/^Not charged: a background step/);
    expect(explainCharge(rec({ notCounted: true }))).toMatch(/^Not counted/);
  });

  it("monthly allowances are explained in their own terms, not units", () => {
    expect(explainCharge(rec({ feature: "code_workspace" }))).toMatch(/workspace minutes/);
    expect(explainCharge(rec({ feature: "code_run" }))).toMatch(/monthly code runs/);
  });

  it("extra usage is said to be outside the plan's limits", () => {
    expect(explainCharge(rec({ paidWithCredits: true }))).toMatch(/extra usage, so it didn't count toward your plan's limits\.$/);
  });
});
