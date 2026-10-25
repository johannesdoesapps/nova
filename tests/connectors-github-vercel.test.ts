import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.ORBIS_CONNECTOR_KEY = randomBytes(32).toString("base64");

const oauth = await import("@/lib/connectors/oauth");
const { REGISTRY, toolByName, actionByName } = await import("@/lib/connectors/registry");
const { CONNECTORS } = await import("@/lib/connectors/catalog");
const gh = await import("@/lib/connectors/providers/github");
const vc = await import("@/lib/connectors/providers/vercel");
const { ConnectorError } = await import("@/lib/connectors/http");

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };
type Route = [method: string, prefix: string, respond: (c: Call) => Response | unknown];

function fake(routes: Route[]) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === "string" ? init.body : null };
    calls.push(call);
    const r = routes.find(([m, p]) => m === call.method && call.url.startsWith(p));
    if (!r) return new Response("not found", { status: 404 });
    const out = r[2](call);
    return out instanceof Response ? out : Response.json(out);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ctx = (f: typeof fetch) => ({ token: "tok", fetch: f });
const GH = "https://api.github.com";
const VC = "https://api.vercel.com";

const repos = (f: Route[] = []): Route[] => [
  ["GET", `${GH}/user/installations?`, () => ({ installations: [{ id: 7 }] })],
  ["GET", `${GH}/user/installations/7/repositories`, () => ({ repositories: [{ full_name: "acme/app", private: true, default_branch: "main", permissions: { push: true } }] })],
  ...f,
];

describe("catalog and setup", () => {
  it("lists GitHub and Vercel as OAuth connectors alongside the others", () => {
    const ids = CONNECTORS.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["github", "vercel", "gmail", "google_drive", "slack", "notion", "wikipedia"]));
    expect(REGISTRY.github!.meta.auth).toBe("oauth2");
    expect(REGISTRY.vercel!.meta.auth).toBe("oauth2");
    expect(REGISTRY.github!.meta.featured && REGISTRY.vercel!.meta.featured).toBe(true);
  });

  it("is 'not set up' until the site has the client credentials (and never needs a browser-side secret)", () => {
    const base = { ORBIS_CONNECTOR_KEY: process.env.ORBIS_CONNECTOR_KEY };
    expect(oauth.missingSetup(REGISTRY.github!, base)).toEqual(["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_SLUG"]);
    expect(oauth.missingSetup(REGISTRY.vercel!, base)).toEqual(["ORBIS_VERCEL_CLIENT_ID", "ORBIS_VERCEL_CLIENT_SECRET"]);
    expect(oauth.missingSetup(REGISTRY.vercel!, { ...base, ORBIS_VERCEL_CLIENT_ID: "cl_x", ORBIS_VERCEL_CLIENT_SECRET: "s" })).toEqual([]);
    for (const c of [REGISTRY.github!, REGISTRY.vercel!]) for (const e of c.meta.setup.env) expect(e.startsWith("NEXT_PUBLIC_")).toBe(false);
  });
});

describe("authorization URLs", () => {
  const env = { ...process.env, GITHUB_APP_CLIENT_ID: "Iv1.abc", GITHUB_APP_CLIENT_SECRET: "github-test-secret", ORBIS_VERCEL_CLIENT_ID: "cl_v", ORBIS_VERCEL_CLIENT_SECRET: "vercel-test-secret" };

  it("GitHub: the app's own sign-in, with state and PKCE, and no OAuth scopes (permissions live on the app)", () => {
    const { url, cookie } = oauth.beginAuthorization(REGISTRY.github!, { userId: "u1", write: true, siteUrl: "https://tryorbis.app", env });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(u.searchParams.get("redirect_uri")).toBe("https://tryorbis.app/api/connectors/callback");
    expect(u.searchParams.get("state")).toMatch(/.{20,}/);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.has("scope")).toBe(false);
    expect(url).not.toContain("github-test-secret");
    expect(cookie).not.toContain("github-test-secret");
  });

  it("Vercel: Sign in with Vercel with PKCE and only the identity + refresh scopes", () => {
    const { url } = oauth.beginAuthorization(REGISTRY.vercel!, { userId: "u1", write: false, siteUrl: "https://tryorbis.app", env });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://vercel.com/oauth/authorize");
    expect(u.searchParams.get("scope")).toBe("openid email profile offline_access");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(url).not.toContain("vercel-test-secret");
  });

  it("exchanges the code on the server with the secret and records refresh + expiry", async () => {
    const { f, calls } = fake([["POST", "https://github.com/login/oauth/access_token", () => ({ access_token: "ghu_x", refresh_token: "ghr_y", expires_in: 28800, token_type: "bearer", scope: "" })]]);
    const t = await oauth.exchangeCode(REGISTRY.github!, "code1", "verifier1", "https://tryorbis.app", f, env);
    expect(t.accessToken).toBe("ghu_x");
    expect(t.refreshToken).toBe("ghr_y");
    expect(t.expiresAt! - Date.now()).toBeGreaterThan(28_000_000);
    const body = new URLSearchParams(calls[0]!.body!);
    expect(body.get("client_secret")).toBe("github-test-secret");
    expect(body.get("code_verifier")).toBe("verifier1");
    expect(calls[0]!.headers.accept).toBe("application/json");
  });

  it("treats GitHub's 200-with-error token answers as 'reconnect needed'", async () => {
    const { f } = fake([["POST", "https://github.com/login/oauth/access_token", () => ({ error: "bad_refresh_token" })]]);
    await expect(oauth.refreshTokens(REGISTRY.github!, { accessToken: "old", refreshToken: "r" }, f, env)).rejects.toMatchObject({ kind: "auth" });
  });

  it("refreshes Vercel tokens and keeps the old refresh token when none is returned", async () => {
    const { f, calls } = fake([["POST", `${VC}/login/oauth/token`, () => ({ access_token: "new", expires_in: 3600 })]]);
    const t = await oauth.refreshTokens(REGISTRY.vercel!, { accessToken: "old", refreshToken: "keep" }, f, env);
    expect(t.accessToken).toBe("new");
    expect(t.refreshToken).toBe("keep");
    expect(new URLSearchParams(calls[0]!.body!).get("grant_type")).toBe("refresh_token");
  });

  it("revokes at GitHub (app grant) and at Vercel (refresh + access token)", async () => {
    const g = fake([["DELETE", `${GH}/applications/Iv1.abc/grant`, () => new Response(null, { status: 204 })]]);
    await REGISTRY.github!.oauth!.revoke!({ accessToken: "ghu_x" }, { id: "Iv1.abc", secret: "github-test-secret" }, g.f);
    expect(g.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from("Iv1.abc:github-test-secret").toString("base64")}`);
    expect(JSON.parse(g.calls[0]!.body!)).toEqual({ access_token: "ghu_x" });
    const v = fake([["POST", `${VC}/login/oauth/token/revoke`, () => ({})]]);
    await REGISTRY.vercel!.oauth!.revoke!({ accessToken: "a", refreshToken: "r" }, { id: "cl_v", secret: "vercel-test-secret" }, v.f);
    expect(v.calls.map((c) => new URLSearchParams(c.body!).get("token"))).toEqual(["r", "a"]);
  });
});

describe("GitHub tools", () => {
  it("lists only the repositories shared through the app installation", async () => {
    const { f } = fake(repos());
    const r = await toolByName("github_list_repos")!.tool.run(ctx(f), {});
    expect(r.items.map((i) => i.title)).toEqual(["acme/app"]);
    expect(r.items[0]!.snippet).toContain("default branch main");
  });

  it("says how to share repositories when none are", async () => {
    const { f } = fake([["GET", `${GH}/user/installations?`, () => ({ installations: [] })]]);
    const r = await toolByName("github_list_repos")!.tool.run(ctx(f), {});
    expect(r.items).toEqual([]);
    expect(r.text).toMatch(/Choose repositories/);
  });

  it("reads text files and refuses repositories that weren't shared, binary files and unsafe paths", async () => {
    const { f } = fake(repos([
      ["GET", `${GH}/repos/acme/app/contents/src/a.ts?ref=main`, () => ({ type: "file", size: 12, encoding: "base64", content: Buffer.from("export {};\n").toString("base64"), sha: "s1" })],
      ["GET", `${GH}/repos/acme/app/contents/logo.png`, () => ({ type: "file", size: 4, encoding: "base64", content: Buffer.from([0x89, 0, 1, 2]).toString("base64"), sha: "s2" })],
    ]));
    const read = toolByName("github_read_file")!.tool;
    expect((await read.run(ctx(f), { repo: "acme/app", path: "src/a.ts" })).text).toBe("export {};\n");
    await expect(read.run(ctx(f), { repo: "evil/other", path: "x" })).rejects.toMatchObject({ kind: "permission" });
    await expect(read.run(ctx(f), { repo: "acme/app", path: "logo.png" })).rejects.toThrow(/binary/);
    expect(read.input.safeParse({ repo: "acme/app", path: "../etc/passwd" }).success).toBe(false);
    expect(read.input.safeParse({ repo: "acme/app", path: "/abs" }).success).toBe(false);
  });

  it("lists files, branches and pull requests", async () => {
    const { f } = fake(repos([
      ["GET", `${GH}/repos/acme/app/git/trees/main?recursive=1`, () => ({ tree: [{ path: "src/a.ts", type: "blob", size: 3 }, { path: "src", type: "tree" }, { path: "README.md", type: "blob", size: 9 }] })],
      ["GET", `${GH}/repos/acme/app/branches`, () => [{ name: "main", protected: true, commit: { sha: "abcdef12" } }, { name: "dev", commit: { sha: "1234567" } }]],
      ["GET", `${GH}/repos/acme/app/pulls`, () => [{ number: 4, title: "Fix", html_url: "https://github.com/acme/app/pull/4", state: "open", user: { login: "jo" }, head: { ref: "dev" }, base: { ref: "main" }, updated_at: "2026-10-20T00:00:00Z" }]],
    ]));
    const files = await toolByName("github_list_files")!.tool.run(ctx(f), { repo: "acme/app", path: "src" });
    expect(files.text).toContain("src/a.ts");
    expect(files.text).not.toContain("README.md");
    const br = await toolByName("github_list_branches")!.tool.run(ctx(f), { repo: "acme/app" });
    expect(br.items[0]!.snippet).toMatch(/Default branch · Protected/);
    const pr = await toolByName("github_list_pull_requests")!.tool.run(ctx(f), { repo: "acme/app" });
    expect(pr.items[0]!.title).toBe("PR #4: Fix");
  });
});

describe("GitHub actions (run only after the user confirms)", () => {
  it("commits a file to a new branch created from the default branch", async () => {
    let created: unknown = null;
    let put: Record<string, unknown> | null = null;
    const { f } = fake(repos([
      ["GET", `${GH}/repos/acme/app/git/ref/heads/orbis/fix`, () => (created ? { object: { sha: "new" } } : new Response("{}", { status: 404 }))],
      ["GET", `${GH}/repos/acme/app/git/ref/heads/main`, () => ({ object: { sha: "basesha" } })],
      ["POST", `${GH}/repos/acme/app/git/refs`, (c) => ((created = JSON.parse(c.body!)), { ref: "refs/heads/orbis/fix" })],
      ["GET", `${GH}/repos/acme/app/contents/src/a.ts?ref=orbis%2Ffix`, () => ({ type: "file", size: 3, encoding: "base64", content: Buffer.from("old").toString("base64"), sha: "blob1" })],
      ["PUT", `${GH}/repos/acme/app/contents/src/a.ts`, (c) => ((put = JSON.parse(c.body!)), { commit: { sha: "c0ffee1234", html_url: "https://github.com/acme/app/commit/c0ffee1234" } })],
    ]));
    const r = await actionByName("github_commit_file")!.action.run(ctx(f), { repo: "acme/app", branch: "orbis/fix", path: "src/a.ts", content: "new content", message: "Fix a" });
    expect(created).toEqual({ ref: "refs/heads/orbis/fix", sha: "basesha" });
    expect(put).toMatchObject({ branch: "orbis/fix", sha: "blob1", message: "Fix a" });
    expect(Buffer.from(put!.content as string, "base64").toString()).toBe("new content");
    expect(r.summary).toMatch(/Updated src\/a\.ts on orbis\/fix .*new branch.*c0ffee1/);
    expect(r.url).toContain("/commit/");
  });

  it("never commits to the default branch", async () => {
    const { f, calls } = fake(repos());
    await expect(actionByName("github_commit_file")!.action.run(ctx(f), { repo: "acme/app", branch: "main", path: "a", content: "x", message: "m" })).rejects.toThrow(/default branch/);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("opens a pull request into the default branch and explains GitHub's 422", async () => {
    const ok = fake(repos([["POST", `${GH}/repos/acme/app/pulls`, (c) => ({ number: 9, html_url: "https://github.com/acme/app/pull/9", sent: JSON.parse(c.body!) })]]));
    const r = await actionByName("github_create_pull_request")!.action.run(ctx(ok.f), { repo: "acme/app", head: "orbis/fix", title: "Fix", body: "Why" });
    expect(r.summary).toBe("Opened pull request #9 in acme/app (orbis/fix → main).");
    expect(JSON.parse(ok.calls.at(-1)!.body!)).toMatchObject({ head: "orbis/fix", base: "main", draft: false });
    const bad = fake(repos([["POST", `${GH}/repos/acme/app/pulls`, () => new Response("{}", { status: 422 })]]));
    await expect(actionByName("github_create_pull_request")!.action.run(ctx(bad.f), { repo: "acme/app", head: "x", title: "t", body: "" })).rejects.toThrow(/no changes|already exists/);
  });

  it("creates a branch only when it doesn't exist yet, and validates branch names", async () => {
    const { f } = fake(repos([["GET", `${GH}/repos/acme/app/git/ref/heads/dev`, () => ({ object: { sha: "x" } })]]));
    await expect(actionByName("github_create_branch")!.action.run(ctx(f), { repo: "acme/app", branch: "dev" })).rejects.toThrow(/already exists/);
    const input = actionByName("github_create_branch")!.action.input;
    for (const bad of ["../x", "a..b", "x.lock", "/x", "x/", "a b"]) expect(input.safeParse({ repo: "acme/app", branch: bad }).success, bad).toBe(false);
    expect(input.safeParse({ repo: "acme/app", branch: "orbis/fix-login_2" }).success).toBe(true);
  });

  it("asks for write scopes only as recorded permissions (write is off unless the user opts in)", () => {
    const writes = REGISTRY.github!.meta.writeScopes.map((s) => s.scope);
    for (const a of REGISTRY.github!.actions) expect(writes).toContain(a.scope);
  });
});

describe("Vercel tools", () => {
  it("lists projects across the personal account and teams, skipping teams Orbis isn't installed on", async () => {
    const { f, calls } = fake([
      ["GET", `${VC}/v2/teams`, () => ({ teams: [{ id: "team_a", name: "Acme", slug: "acme" }, { id: "team_b", name: "Other", slug: "other" }] })],
      ["GET", `${VC}/v10/projects?limit=20&teamId=team_a`, () => ({ projects: [{ id: "prj_1", name: "web", framework: "nextjs", updatedAt: 1, targets: { production: { url: "web-x.vercel.app", alias: ["acme.com"], readyState: "READY" } } }] })],
      ["GET", `${VC}/v10/projects?limit=20&teamId=team_b`, () => new Response("{}", { status: 403 })],
      ["GET", `${VC}/v10/projects?limit=20`, () => ({ projects: [] })],
    ]);
    const r = await toolByName("vercel_list_projects")!.tool.run(ctx(f), {});
    expect(r.items.map((i) => i.title)).toEqual(["web"]);
    expect(r.items[0]!.url).toBe("https://acme.com");
    expect(r.items[0]!.read).toEqual({ tool: "vercel_list_deployments", args: { project: "prj_1", teamId: "team_a" } });
    expect(r.summary).toMatch(/no access to 1 account/);
    expect(calls.every((c) => c.headers.authorization === "Bearer tok")).toBe(true);
  });

  it("explains a refusal when no account is reachable", async () => {
    const { f } = fake([
      ["GET", `${VC}/v2/teams`, () => ({ teams: [] })],
      ["GET", `${VC}/v10/projects`, () => new Response("{}", { status: 403 })],
    ]);
    await expect(toolByName("vercel_list_projects")!.tool.run(ctx(f), {})).rejects.toThrow(/isn't installed on that team/);
  });

  it("lists deployments, and reads a deployment with the end of its build log", async () => {
    const { f } = fake([
      ["GET", `${VC}/v9/projects/web`, () => ({ id: "prj_1", name: "web" })],
      ["GET", `${VC}/v6/deployments?projectId=prj_1`, () => ({ deployments: [{ uid: "dpl_1", name: "web", url: "web-1.vercel.app", state: "ERROR", created: 1, target: "production", meta: { githubCommitRef: "main", githubCommitSha: "abcdef123" } }] })],
      ["GET", `${VC}/v13/deployments/dpl_1`, () => ({ id: "dpl_1", name: "web", url: "web-1.vercel.app", readyState: "ERROR", errorMessage: "Command failed", createdAt: 1, target: "production" })],
      ["GET", `${VC}/v3/deployments/dpl_1/events`, () => [{ type: "stdout", payload: { text: "\u001b[31mType error: x\u001b[0m" } }, { type: "delimiter", payload: { text: "" } }, { type: "stderr", payload: { text: "Build failed" } }]],
    ]);
    const list = await toolByName("vercel_list_deployments")!.tool.run(ctx(f), { project: "web" });
    expect(list.items[0]!.title).toMatch(/web · error · production/);
    expect(list.items[0]!.snippet).toContain("dpl_1 · main @ abcdef1");
    const d = await toolByName("vercel_get_deployment")!.tool.run(ctx(f), { deployment: "dpl_1" });
    expect(d.text).toContain("Status: ERROR — Command failed");
    expect(d.text).toContain("Type error: x\nBuild failed");
    expect(d.text).not.toContain("\u001b");
    const input = toolByName("vercel_get_deployment")!.tool.input;
    expect(input.safeParse({ deployment: "https://evil.example" }).success).toBe(false);
    expect(input.safeParse({ deployment: "web-1.vercel.app" }).success).toBe(true);
  });

  it("redeploys (after confirmation) to production or as a preview", async () => {
    const { f, calls } = fake([
      ["GET", `${VC}/v13/deployments/dpl_1`, () => ({ id: "dpl_1", name: "web", url: "web-1.vercel.app", readyState: "READY", createdAt: 1 })],
      ["POST", `${VC}/v13/deployments`, () => ({ id: "dpl_2", url: "web-2.vercel.app", inspectorUrl: "https://vercel.com/acme/web/2" })],
    ]);
    const a = actionByName("vercel_redeploy")!.action;
    const r = await a.run(ctx(f), { deployment: "dpl_1", target: "production" });
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ name: "web", deploymentId: "dpl_1", target: "production" });
    expect(r.summary).toMatch(/production redeploy of web \(dpl_2\)/);
    await a.run(ctx(f), { deployment: "dpl_1", target: "preview" });
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ name: "web", deploymentId: "dpl_1" });
    expect(a.describe({ deployment: "dpl_1", target: "production" } as never)).toMatch(/live production/);
  });

  it("maps an expired Vercel token to 'reconnect needed'", async () => {
    const { f } = fake([["GET", `${VC}/v2/teams`, () => new Response("{}", { status: 401 })], ["GET", `${VC}/v10/projects`, () => new Response("{}", { status: 401 })]]);
    const err = await toolByName("vercel_list_projects")!.tool.run(ctx(f), {}).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.kind).toBe("auth");
  });
});

describe("helpers", () => {
  it("records the requested permissions for app-permission services, and the reported ones for others", () => {
    const req = ["read:project", "read:deployment", "write:deployment"];
    expect(oauth.recordedScopes(REGISTRY.vercel!, req, ["openid", "email", "profile", "offline_access"])).toEqual(req);
    expect(oauth.recordedScopes(REGISTRY.github!, ["contents:read"], null)).toEqual(["contents:read"]);
    const g = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];
    expect(oauth.recordedScopes(REGISTRY.gmail!, g, [g[0]!])).toEqual([g[0]]);
  });

  it("builds the repository chooser link only from a valid slug", () => {
    expect(gh.githubInstallUrl({ GITHUB_APP_SLUG: "orbis-ai" })).toBe("https://github.com/apps/orbis-ai/installations/new");
    expect(gh.githubInstallUrl({ GITHUB_APP_SLUG: "evil.com/x" })).toBeNull();
    expect(gh.githubInstallUrl({})).toBeNull();
  });

  it("parses GitHub tokens without inventing scopes", () => {
    expect(gh.parseGitHubToken({ access_token: "a", expires_in: 10 }, 0)).toEqual({ accessToken: "a", refreshToken: null, expiresAt: 10_000, scopes: null });
    expect(() => gh.parseGitHubToken({})).toThrow(/access token/);
    expect(typeof vc.buildLog).toBe("function");
  });
});
