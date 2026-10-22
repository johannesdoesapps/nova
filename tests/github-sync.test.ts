/**
 * "Update from GitHub" and "Push to GitHub" never lose anyone's work: GitHub's
 * changes come in only where Orbis didn't change the file, and a push sends
 * only Orbis's own changes.
 */
import { describe, expect, it } from "vitest";
import { changedSinceBase, planUpdate, pushConflicts } from "@/lib/code/github-sync";
import { gitBlobSha } from "@/lib/github/app";

describe("git blob ids", () => {
  it("match git's own (git hash-object)", () => {
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobSha("héllo")).toHaveLength(40); // bytes, not characters, are counted
  });
});

describe("update from GitHub", () => {
  const base = { "same.ts": "a1", "gh.ts": "b1", "orbis.ts": "c1", "both.ts": "d1", "ghdel.ts": "e1", "ghdel-orbis-changed.ts": "f1", "orbisdel.ts": "g1", "orbisdel-gh-changed.ts": "h1" };
  const local = { "same.ts": "a1", "gh.ts": "b1", "orbis.ts": "c2", "both.ts": "d2", "ghdel.ts": "e1", "ghdel-orbis-changed.ts": "f2", "new-in-orbis.ts": "n1", "same-new.ts": "s1" };
  const remote = { "same.ts": "a1", "gh.ts": "b2", "orbis.ts": "c1", "both.ts": "d3", "orbisdel.ts": "g1", "orbisdel-gh-changed.ts": "h2", "new-on-github.ts": "m1", "same-new.ts": "s1" };
  const plan = planUpdate({ base, local, remote });

  it("takes GitHub's version only where Orbis didn't change the file", () => {
    expect(plan.take).toEqual(["gh.ts", "new-on-github.ts"]);
  });
  it("removes a file GitHub deleted only if Orbis didn't change it", () => {
    expect(plan.remove).toEqual(["ghdel.ts"]);
  });
  it("keeps Orbis's version and reports files changed on both sides", () => {
    expect(plan.conflicts.sort()).toEqual(["both.ts", "ghdel-orbis-changed.ts", "orbisdel-gh-changed.ts"]);
    expect(plan.keptLocal).toBe(1); // orbis.ts
  });
  it("never touches files made in Orbis or deleted in Orbis", () => {
    for (const p of ["new-in-orbis.ts", "orbisdel.ts"]) {
      expect(plan.take).not.toContain(p);
      expect(plan.remove).not.toContain(p);
    }
  });
  it("records the new base: GitHub's id where in step, the old one where Orbis keeps its own", () => {
    expect(plan.base).toMatchObject({ "same.ts": "a1", "gh.ts": "b2", "new-on-github.ts": "m1", "same-new.ts": "s1", "orbis.ts": "c1", "both.ts": "d1", "orbisdel.ts": "g1" });
    expect(plan.base).not.toHaveProperty("ghdel.ts");
    expect(plan.base).not.toHaveProperty("new-in-orbis.ts");
  });
  it("a second update right after changes nothing", () => {
    const after = { ...local, "gh.ts": "b2", "new-on-github.ts": "m1" } as Record<string, string>;
    delete after["ghdel.ts"];
    const again = planUpdate({ base: plan.base, local: after, remote });
    expect(again.take).toEqual([]);
    expect(again.remove).toEqual([]);
  });
  it("without a base (an older project) only adds files that are new on GitHub", () => {
    const p = planUpdate({ base: null, local: { "a.ts": "1" }, remote: { "a.ts": "2", "b.ts": "3" } });
    expect(p.take).toEqual(["b.ts"]);
    expect(p.conflicts).toEqual(["a.ts"]);
  });
});

describe("push to GitHub", () => {
  it("sends only files changed or added in Orbis since the base", () => {
    expect(changedSinceBase({ "a.ts": "1", "b.ts": "2" }, { "a.ts": "1", "b.ts": "9", "c.ts": "3" }).sort()).toEqual(["b.ts", "c.ts"]);
    expect(changedSinceBase(null, { "a.ts": "1" })).toEqual(["a.ts"]);
  });
  it("spots files GitHub changed too, so a push can't undo them unnoticed", () => {
    const base = { "a.ts": "1", "b.ts": "2" };
    expect(pushConflicts(base, { "a.ts": "5", "b.ts": "6" }, { "a.ts": "1", "b.ts": "7" })).toEqual(["b.ts"]);
    expect(pushConflicts(base, { "a.ts": "5" }, { "a.ts": "5" })).toEqual([]); // same change on both sides
    expect(pushConflicts(null, { "a.ts": "5" }, { "a.ts": "7" })).toEqual([]);
  });
});
