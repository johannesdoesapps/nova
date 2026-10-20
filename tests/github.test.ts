/**
 * GitHub: the app's JWT, whose installation it is (by verified account id,
 * never by what the browser says), file listing and reading limits, path
 * safety, and the sign-in/connect messages. GitHub's API is a stand-in.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { oauthErrorCode, oauthRedirectTo, exchangeFailureCode, LOGIN_MESSAGES } from "@/lib/auth-flow";

vi.mock("server-only", () => ({}));

const { appJwt, clearTokenCache, githubAppConfig, githubIdentity, installationToken, repoFile, repoTree, safePath, userInstallation, listRepos } = await import("@/lib/github/app");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const cfg = { appId: "123456", slug: "nova-ai-test", privateKey };

type Call = { url: string; init?: RequestInit };
function fakeGitHub(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const path = String(url).replace("https://api.github.com", "");
    const hit = Object.entries(routes).find(([k]) => path === k || path.startsWith(`${k}?`));
    if (!hit) return new Response("not found", { status: 404 });
    const body = typeof hit[1] === "function" ? (hit[1] as (c: Call) => unknown)(call) : hit[1];
    return Response.json(body);
  }) as unknown as typeof fetch;
  return { f, calls };
}

beforeEach(() => clearTokenCache());

describe("configuration and the app's JWT", () => {
  it("reads the app id, slug and private key (with escaped line breaks) from the environment", () => {
    expect(githubAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "nova", GITHUB_APP_PRIVATE_KEY: "-----BEGIN-----\\nabc\\n-----END-----" })?.privateKey).toBe("-----BEGIN-----\nabc\n-----END-----");
    expect(githubAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "nova" })).toBeNull();
    expect(githubAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "bad slug/..", GITHUB_APP_PRIVATE_KEY: "k" })).toBeNull();
  });

  it("signs an RS256 JWT for the app that GitHub accepts for under 10 minutes", () => {
    const now = Date.UTC(2026, 9, 20, 12, 0, 0);
    const [h, b, sig] = appJwt(cfg, now).split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(b!, "base64url").toString());
    expect(claims).toEqual({ iss: "123456", iat: now / 1000 - 60, exp: now / 1000 - 60 + 540 });
    expect(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  });
});

describe("whose installation it is", () => {
  it("takes the GitHub account from the identity Supabase verified", () => {
    expect(githubIdentity([{ provider: "email" }, { provider: "github", id: "583231", identity_data: { provider_id: "583231", user_name: "octocat" } }])).toEqual({ id: 583231, login: "octocat" });
    expect(githubIdentity([{ provider: "google", identity_data: { sub: "1" } }])).toBeNull();
    expect(githubIdentity([{ provider: "github", identity_data: { provider_id: "x", user_name: "octocat" } }])).toBeNull();
    expect(githubIdentity([{ provider: "github", identity_data: { provider_id: "1", user_name: "../evil" } }])).toBeNull();
  });

  it("uses the installation only when it belongs to that same account id", async () => {
    const mine = fakeGitHub({ "/users/octocat/installation": { id: 99, account: { id: 583231, login: "octocat" }, repository_selection: "selected" } });
    expect(await userInstallation(cfg, { id: 583231, login: "octocat" }, mine.f)).toEqual({ id: 99, accountId: 583231, accountLogin: "octocat", repositorySelection: "selected" });
    expect(String(new Headers(mine.calls[0]!.init!.headers).get("authorization"))).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    // A login that now belongs to someone else (renamed account): different id, so not used.
    const other = fakeGitHub({ "/users/octocat/installation": { id: 77, account: { id: 1, login: "octocat" }, repository_selection: "all" } });
    expect(await userInstallation(cfg, { id: 583231, login: "octocat" }, other.f)).toBeNull();
    // Not installed.
    expect(await userInstallation(cfg, { id: 583231, login: "octocat" }, fakeGitHub({}).f)).toBeNull();
  });

  it("gets a short-lived installation token and reuses it until close to expiry", async () => {
    const now = Date.UTC(2026, 9, 20, 12);
    let n = 0;
    const gh = fakeGitHub({ "/app/installations/99/access_tokens": () => ({ token: `ghs_${++n}`, expires_at: new Date(now + 60 * 60_000).toISOString() }) });
    expect(await installationToken(cfg, 99, gh.f, now)).toBe("ghs_1");
    expect(await installationToken(cfg, 99, gh.f, now + 30 * 60_000)).toBe("ghs_1");
    expect(await installationToken(cfg, 99, gh.f, now + 56 * 60_000)).toBe("ghs_2");
    expect(gh.calls[0]!.init!.method).toBe("POST");
  });
});

describe("repositories and files", () => {
  it("lists the repositories the user shared, sorted", async () => {
    const gh = fakeGitHub({ "/installation/repositories": { repositories: [{ full_name: "octocat/zeta", private: true, default_branch: "main" }, { full_name: "octocat/alpha", private: false, default_branch: "dev" }] } });
    expect(await listRepos("ghs_1", gh.f)).toEqual([
      { fullName: "octocat/alpha", private: false, defaultBranch: "dev" },
      { fullName: "octocat/zeta", private: true, defaultBranch: "main" },
    ]);
  });

  it("lists text files on the default branch, skipping dependencies, builds, binaries and large files", async () => {
    const gh = fakeGitHub({
      "/repos/octocat/app": { default_branch: "main" },
      "/repos/octocat/app/git/trees/main": {
        truncated: false,
        tree: [
          { path: "src", type: "tree" },
          { path: "src/index.ts", type: "blob", size: 1200 },
          { path: "README.md", type: "blob", size: 300 },
          { path: "Dockerfile", type: "blob", size: 80 },
          { path: "node_modules/x/index.js", type: "blob", size: 10 },
          { path: "dist/app.js", type: "blob", size: 10 },
          { path: "logo.png", type: "blob", size: 5000 },
          { path: "data/huge.json", type: "blob", size: 2_000_000 },
        ],
      },
    });
    const t = await repoTree("ghs_1", "octocat/app", gh.f);
    expect(t.branch).toBe("main");
    expect(t.files.map((f) => f.path)).toEqual(["src/index.ts", "README.md", "Dockerfile"]);
  });

  it("reads a text file and refuses binary or oversized ones", async () => {
    const enc = (s: string | Buffer) => Buffer.from(s).toString("base64");
    const gh = fakeGitHub({
      "/repos/octocat/app/contents/src/index.ts": { type: "file", size: 20, encoding: "base64", content: enc("export const x = 1;\n") },
      "/repos/octocat/app/contents/bin/tool": { type: "file", size: 4, encoding: "base64", content: enc(Buffer.from([0x7f, 0x45, 0x00, 0x01])) },
      "/repos/octocat/app/contents/big.txt": { type: "file", size: 200_000, encoding: "base64", content: "" },
      "/repos/octocat/app/contents/src": [{ type: "dir" }],
    });
    expect(await repoFile("ghs_1", "octocat/app", "src/index.ts", gh.f)).toEqual({ path: "src/index.ts", content: "export const x = 1;\n", size: 20 });
    await expect(repoFile("ghs_1", "octocat/app", "bin/tool", gh.f)).rejects.toThrow(/isn't text/);
    await expect(repoFile("ghs_1", "octocat/app", "big.txt", gh.f)).rejects.toThrow(/too large/);
    await expect(repoFile("ghs_1", "octocat/app", "src", gh.f)).rejects.toThrow(/isn't in the repository/);
  });

  it("accepts only plain repository-relative paths", () => {
    expect(safePath("src/app/page.tsx")).toBe(true);
    for (const bad of ["", "/etc/passwd", "../secret", "src/../../x", "src//x", "a\\b", "a\0b", "./x"]) expect(safePath(bad)).toBe(false);
  });

  it("doesn't pass GitHub's error text on to users", async () => {
    const f = vi.fn(async () => new Response("secret-repo-name is private", { status: 500 })) as unknown as typeof fetch;
    await expect(listRepos("ghs_1", f)).rejects.toThrow(/GitHub didn't respond as expected \(500\)/);
  });
});

describe("sign in with GitHub and connecting it", () => {
  it("sends the provider back to the callback with how it started", () => {
    expect(oauthRedirectTo("https://nova.example", "/chat", "github")).toBe("https://nova.example/auth/callback?via=github&next=%2Fchat");
    expect(oauthRedirectTo("https://nova.example", "/chat", "github-link")).toContain("via=github-link");
    expect(oauthRedirectTo("https://nova.example", "/chat")).toContain("via=google");
  });

  it("words GitHub failures for GitHub, never with the provider's text", () => {
    expect(oauthErrorCode("access_denied", null, "github")).toBe("github_cancelled");
    expect(oauthErrorCode("server_error", "provider_disabled", "github")).toBe("github_unavailable");
    expect(oauthErrorCode("anything", null, "github")).toBe("github_failed");
    expect(oauthErrorCode("server_error", "identity_already_exists", "github-link")).toBe("github_in_use");
    expect(oauthErrorCode("access_denied", null, "github-link")).toBe("github_link_failed");
    expect(oauthErrorCode("access_denied")).toBe("google_cancelled");
    expect(exchangeFailureCode("github-link")).toBe("github_link_failed");
    expect(LOGIN_MESSAGES.github_in_use.text).toMatch(/already connected to another Orbis account/);
  });
});
