/** The engine proxy's admin-only gate on AI model use can't be slipped past with other spellings of "yes". */
import { describe, expect, it } from "vitest";
import { engineRequestUsesModel } from "@/lib/engine-guard";

describe("engine AI model gate", () => {
  it("catches every truthy use_model, as the engine reads it", () => {
    for (const v of ["true", "1", '"yes"', "[1]", '{"a":1}', "2.5"]) expect(engineRequestUsesModel("lab/plan", `{"goal":"x","use_model": ${v}}`), v).toBe(true);
    expect(engineRequestUsesModel("lab/plan", '{"use_\\u006dodel":true}')).toBe(true);
  });

  it("lets the rule-based planner through", () => {
    for (const v of ["false", "0", '""', "[]", "{}", "null"]) expect(engineRequestUsesModel("lab/plan", `{"goal":"x","use_model": ${v}}`), v).toBe(false);
    expect(engineRequestUsesModel("lab/plan", '{"goal":"x"}')).toBe(false);
  });

  it("treats live Lab runs as model use, dry runs not", () => {
    expect(engineRequestUsesModel("lab/workflows/abc/runs", '{"mode":"live"}')).toBe(true);
    expect(engineRequestUsesModel("lab/workflows/abc/runs", '{"mode":"dry_run"}')).toBe(false);
    expect(engineRequestUsesModel("lab/workflows/abc/runs", '{"inputs":{}}')).toBe(true); // the engine's default is live
    expect(engineRequestUsesModel("lab/workflows/abc/runs", "")).toBe(true);
    expect(engineRequestUsesModel("lab/workflows/abc/runs", undefined)).toBe(true);
    expect(engineRequestUsesModel("radar/items", '{"mode":"live"}')).toBe(false);
  });

  it("fails closed on unreadable bodies, and ignores JSON that isn't an object", () => {
    // Anything this side can't read is treated as a model request (admins only): Python's json.loads accepts NaN
    // and Infinity, which JSON.parse rejects, and bool(NaN) is True in the engine.
    expect(engineRequestUsesModel("lab/plan", "not json")).toBe(true);
    expect(engineRequestUsesModel("lab/plan", '{"goal":"x","use_model":NaN}')).toBe(true);
    expect(engineRequestUsesModel("lab/workflows/abc/runs", '{"mode":"live","x":Infinity}')).toBe(true);
    expect(engineRequestUsesModel("lab/plan", "[true]")).toBe(false);
    expect(engineRequestUsesModel("lab/plan", undefined)).toBe(false);
  });
});
