/**
 * Security Team stage 4: Vercel deployment audit — variable values never survive parsing, settings become findings
 * with honest confidence, the deploy gate never blocks on unverified findings, and refused reads are reported.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { asOpenFindings, configFindings, deployGate, envMeta, previewProbe, productionHost, projectInfo, readVercelProject, secretLike, type VercelSnapshot } from "@/lib/security/vercel-audit";

const project = (over: Record<string, unknown> = {}) =>
  projectInfo({ id: "prj_1", name: "shop", framework: "nextjs", nodeVersion: "22.x", ssoProtection: { deploymentType: "preview" }, passwordProtection: null, gitForkProtection: true, publicSource: false, link: { type: "github", org: "acme", repo: "shop" }, ...over }, "team_abc");
const snap = (over: Partial<VercelSnapshot> = {}, p: Record<string, unknown> = {}): VercelSnapshot => ({ project: project(p), envs: [], domains: [], deployments: [], missing: [], ...over });
const rules = (s: VercelSnapshot) => configFindings(s).map((f) => f.ruleId);

describe("environment-variable metadata", () => {
  it("drops values, including plain ones Vercel returns", () => {
    const m = envMeta({ key: "API_URL", value: "https://internal.example/very-secret", type: "plain", target: ["production"], decrypted: false });
    expect(m).toEqual({ key: "API_URL", type: "plain", targets: ["production"], gitBranch: null });
    expect(JSON.stringify(m)).not.toContain("very-secret");
  });

  it("tells secret-like names from names meant to be public", () => {
    expect(secretLike("SUPABASE_SERVICE_ROLE_KEY")).toBe(true);
    expect(secretLike("STRIPE_SECRET_KEY")).toBe(true);
    expect(secretLike("NEXT_PUBLIC_SUPABASE_ANON_KEY")).toBe(false);
    expect(secretLike("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY")).toBe(false);
    expect(secretLike("NEXT_PUBLIC_SITE_URL")).toBe(false);
  });
});

describe("configuration findings", () => {
  it("flags browser-exposed secret names as leads that need verification", () => {
    const fs = configFindings(snap({ envs: [{ key: "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY", type: "encrypted", targets: ["production"], gitBranch: null }, { key: "NEXT_PUBLIC_SUPABASE_ANON_KEY", type: "plain", targets: ["production"], gitBranch: null }] }));
    expect(fs.map((f) => f.ruleId)).toEqual(["vercel.env-public-secret"]);
    expect(fs[0]).toMatchObject({ severity: "high", confidence: "tentative", agent: "sentinel", asset: "vercel:team_abc/shop", evidenceSource: "vercel:api" });
  });

  it("flags plain-stored secrets and production credentials shared with previews (worse without fork protection)", () => {
    const envs = [
      { key: "DATABASE_URL", type: "plain", targets: ["production", "preview"], gitBranch: null },
      { key: "STRIPE_SECRET_KEY", type: "sensitive", targets: ["production"], gitBranch: null },
      { key: "STRIPE_SECRET_KEY", type: "sensitive", targets: ["preview"], gitBranch: null },
    ];
    expect(rules(snap({ envs }))).toEqual(["vercel.env-plain-secret", "vercel.env-prod-secret-in-preview"]);
    const open = configFindings(snap({ envs }, { gitForkProtection: false }));
    expect(open.find((f) => f.ruleId === "vercel.env-prod-secret-in-preview")!.severity).toBe("high");
    expect(open.find((f) => f.ruleId === "vercel.fork-protection-off")!.severity).toBe("high");
  });

  it("reports project settings only when Vercel reported them", () => {
    expect(rules(snap({}, { ssoProtection: null, passwordProtection: null, publicSource: true, directoryListing: true, nodeVersion: "18.x", protectionBypass: { s1: {}, s2: {} } }))).toEqual([
      "vercel.preview-unprotected",
      "vercel.public-source",
      "vercel.directory-listing",
      "vercel.node-eol",
      "vercel.protection-bypass",
    ]);
    // Fields missing from the response aren't findings.
    expect(rules(snap({}, { ssoProtection: undefined, passwordProtection: undefined, gitForkProtection: undefined, nodeVersion: undefined }))).toEqual([]);
  });

  it("never keeps bypass secrets, only their count", () => {
    const p = project({ protectionBypass: { "super-secret-bypass-value": { scope: "automation-bypass" } } });
    expect(JSON.stringify(p)).not.toContain("super-secret-bypass-value");
    expect(p.bypassSecrets).toBe(1);
  });

  it("adds what a real preview request showed", () => {
    const fs = configFindings(snap({}, { ssoProtection: null, passwordProtection: null }));
    expect(previewProbe(fs, "https://shop-git-x.vercel.app/", 200)).toMatch(/reachable without signing in/);
    expect(fs[0]!.evidence.at(-1)!.detail).toMatch(/opened without signing in/);
    expect(previewProbe([], "https://shop-git-y.vercel.app/", 401)).toMatch(/protected/);
  });

  it("picks the serving custom domain for site checks", () => {
    const s = snap({
      domains: [
        { name: "www.shop.com", verified: true, redirect: "shop.com", gitBranch: null },
        { name: "staging.shop.com", verified: true, redirect: null, gitBranch: "staging" },
        { name: "shop.vercel.app", verified: true, redirect: null, gitBranch: null },
        { name: "shop.com", verified: true, redirect: null, gitBranch: null },
      ],
    });
    expect(productionHost(s)).toBe("shop.com");
    expect(productionHost(snap())).toBeNull();
  });
});

describe("deploy gate", () => {
  const steps = [{ label: "Project settings", status: "completed" }];
  const leads = asOpenFindings(configFindings(snap({ envs: [{ key: "NEXT_PUBLIC_DB_PASSWORD", type: "encrypted", targets: ["production"], gitBranch: null }] })));

  it("never blocks on findings that still need verification", () => {
    const g = deployGate({ deployment: leads, repository: [], steps, repoAudited: true }, { mode: "block", blockSeverities: ["critical", "high", "medium"] });
    expect(leads[0]!.severity).toBe("high");
    expect(g.decision).toBe("allow");
  });

  it("blocks (or warns) on confirmed findings, by mode", () => {
    const confirmed = asOpenFindings(configFindings(snap({}, { publicSource: true })));
    expect(deployGate({ deployment: confirmed, repository: [], steps, repoAudited: true }, { mode: "block", blockSeverities: ["high"] }).decision).toBe("block");
    expect(deployGate({ deployment: confirmed, repository: [], steps, repoAudited: true }, { mode: "warn", blockSeverities: ["high"] }).decision).toBe("warn");
  });

  it("is incomplete, not a pass, when a check didn't run, and says when the repository wasn't audited", () => {
    const g = deployGate({ deployment: [], repository: [], steps: [{ label: "Production site checks", status: "failed" }], repoAudited: false }, { mode: "block", blockSeverities: ["high"] });
    expect(g.decision).toBe("incomplete");
    expect(g.reasons.join(" ")).toMatch(/hasn't been audited/);
  });

  it("ignores accepted risks in the linked repository", () => {
    const repo = asOpenFindings(configFindings(snap({}, { publicSource: true }))).map((f) => ({ ...f, status: "accepted_risk" }));
    expect(deployGate({ deployment: [], repository: repo, steps, repoAudited: true }, { mode: "block", blockSeverities: ["high"] }).decision).toBe("allow");
  });
});

describe("reading a project from Vercel", () => {
  it("reads with the person's token, never asks to decrypt, drops values and reports refused parts", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      urls.push(url);
      expect((init.headers as Record<string, string>).authorization ?? (init.headers as Headers).get?.("authorization")).toBe("Bearer vtok");
      if (url.includes("/env")) return new Response(JSON.stringify({ envs: [{ key: "SECRET_TOKEN", value: "leak-me-not", type: "plain", target: ["production"] }] }));
      if (url.includes("/domains")) return new Response(JSON.stringify({ error: { message: "forbidden" } }), { status: 403 });
      if (url.includes("/v6/deployments")) return new Response(JSON.stringify({ deployments: [{ uid: "dpl_1", url: "shop-abc.vercel.app", target: null, readyState: "READY", created: 1 }] }));
      return new Response(JSON.stringify({ id: "prj_1", name: "shop", ssoProtection: null }));
    }) as unknown as typeof fetch;
    const s = await readVercelProject({ token: "vtok", extra: {}, fetch: fetchImpl }, "shop", "team_abc");
    expect(urls.every((u) => u.includes("teamId=team_abc") && !u.includes("decrypt"))).toBe(true);
    expect(JSON.stringify(s)).not.toContain("leak-me-not");
    expect(s.envs).toEqual([{ key: "SECRET_TOKEN", type: "plain", targets: ["production"], gitBranch: null }]);
    expect(s.missing.join(" ")).toMatch(/^domains/);
    expect(s.deployments[0]).toMatchObject({ target: "preview", state: "READY" });
  });

  it("rejects malformed project and team ids before calling Vercel", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(readVercelProject({ token: "t", extra: {}, fetch: fetchImpl }, "../../v2/user", null)).rejects.toThrow(/project's id or name/);
    await expect(readVercelProject({ token: "t", extra: {}, fetch: fetchImpl }, "shop", "team_x&slug=y")).rejects.toThrow(/team id/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
