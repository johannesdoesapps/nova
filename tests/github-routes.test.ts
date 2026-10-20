/**
 * /api/github/* with a stand-in for Supabase Auth and GitHub's API: the
 * installation used is always the one owned by the GitHub account linked to
 * the signed-in user, whatever the request says.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";

vi.mock("server-only", () => ({}));

const state = { signedIn: true, identities: [] as unknown[], installationAccountId: 583231 };

vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  requireUser: async () => {
    if (!state.signedIn) throw new ApiError("unauthorized", "Please sign in to continue.");
    return { mode: "authenticated", user: { id: "user-1", email: "pat@example.com" }, supabase: { auth: { getUser: async () => ({ data: { user: { id: "user-1", identities: state.identities } } }) } } };
  },
}));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const saved = { ...process.env };
afterAll(() => {
  process.env = saved;
  vi.unstubAllGlobals();
});

const requested: string[] = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    const path = String(url).replace("https://api.github.com", "");
    requested.push(path);
    if (path === "/users/octocat/installation") return Response.json({ id: 99, account: { id: state.installationAccountId, login: "octocat" }, repository_selection: "selected" });
    if (path === "/app/installations/99/access_tokens") return Response.json({ token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (path === "/repos/octocat/app/contents/src/index.ts") return Response.json({ type: "file", size: 9, encoding: "base64", content: Buffer.from("const a=1").toString("base64") });
    if (path.startsWith("/installation/repositories")) return Response.json({ repositories: [{ full_name: "octocat/app", private: true, default_branch: "main" }] });
    return new Response("{}", { status: 404 });
  }),
);

const { GET: status } = await import("@/app/api/github/status/route");
const { GET: repos } = await import("@/app/api/github/repos/route");
const { GET: file } = await import("@/app/api/github/file/route");
const { clearTokenCache } = await import("@/lib/github/app");
const linked = [{ provider: "github", id: "583231", identity_data: { provider_id: "583231", user_name: "octocat" } }];
const getFile = (q: string) => file(new Request(`http://x/api/github/file?${q}`));

beforeEach(() => {
  Object.assign(state, { signedIn: true, identities: linked, installationAccountId: 583231 });
  process.env.GITHUB_APP_ID = "123";
  process.env.GITHUB_APP_SLUG = "nova-ai-test";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  requested.length = 0;
  clearTokenCache();
});

describe("/api/github", () => {
  it("reports setup, link and installation status", async () => {
    expect(await (await status()).json()).toMatchObject({ configured: true, linked: true, login: "octocat", installed: true, installUrl: "https://github.com/apps/nova-ai-test/installations/new" });
    state.identities = [{ provider: "email" }];
    expect(await (await status()).json()).toMatchObject({ configured: true, linked: false, installed: false });
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    expect(await (await status()).json()).toMatchObject({ configured: false, installUrl: null });
  });

  it("needs a signed-in user", async () => {
    state.signedIn = false;
    expect((await status()).status).toBe(401);
    expect((await getFile("repo=octocat/app&path=src/index.ts")).status).toBe(401);
  });

  it("reads a file from the user's own installation", async () => {
    const res = await getFile("repo=octocat/app&path=src/index.ts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "src/index.ts", content: "const a=1", size: 9 });
    expect((await (await repos()).json()).repos).toEqual([{ fullName: "octocat/app", private: true, defaultBranch: "main" }]);
  });

  it("refuses when GitHub isn't connected, or the installation belongs to another account", async () => {
    state.identities = [];
    const a = await getFile("repo=octocat/app&path=src/index.ts");
    expect(a.status).toBe(403);
    expect((await a.json()).error.message).toMatch(/Connect your GitHub account/);
    state.identities = linked;
    state.installationAccountId = 1;
    const b = await getFile("repo=octocat/app&path=src/index.ts");
    expect(b.status).toBe(403);
    expect(requested).not.toContain("/app/installations/99/access_tokens");
  });

  it("refuses unsafe paths and malformed repository names before calling GitHub", async () => {
    for (const q of ["repo=octocat/app&path=../../etc/passwd", "repo=octocat/app&path=/etc/passwd", "repo=../x&path=a", "repo=octocat&path=a"]) {
      expect((await getFile(q)).status).toBe(400);
    }
    expect(requested).toHaveLength(0);
  });

  it("is unavailable until the app is configured", async () => {
    delete process.env.GITHUB_APP_ID;
    expect((await getFile("repo=octocat/app&path=src/index.ts")).status).toBe(503);
  });
});
