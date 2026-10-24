/**
 * Signing out ends the session for good: Supabase is asked to end this
 * browser's session, every session cookie (and its chunks, the PKCE
 * verifier and the per-account terms cookie) is expired even when that call
 * fails, the proxy doesn't refresh the session on the sign-out request (a
 * fresh session cookie in the same response could undo the sign-out), the
 * account's data is cleared from browser storage, and GitHub and Google
 * always ask which account to use.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = { cookies: [] as { name: string; value: string }[], signOut: vi.fn(async (): Promise<{ error: Error | null }> => ({ error: null })), configured: true };
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => state.cookies, get: (n: string) => state.cookies.find((c) => c.name === n), set: () => {} }) }));
vi.mock("@/lib/env", async (orig) => ({ ...(await orig<typeof import("@/lib/env")>()), isSupabaseConfigured: () => state.configured }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({ auth: { signOut: state.signOut } }) }));
const createServerClient = vi.fn();
vi.mock("@supabase/ssr", () => ({ createServerClient: (...a: unknown[]) => (createServerClient(...a), { auth: { getClaims: async () => ({ data: null }) } }) }));

const { POST } = await import("@/app/auth/signout/route");
const { cookiesToClear, forgetAccountData, ACCOUNT_STORAGE_KEYS, SIGNED_OUT_COOKIE } = await import("@/lib/sign-out");
const { proxy } = await import("@/proxy");

const SESSION = [
  { name: "sb-vbsdxadumiogbdwgvrir-auth-token.0", value: "base64-aaa" },
  { name: "sb-vbsdxadumiogbdwgvrir-auth-token.1", value: "bbb" },
  { name: "sb-vbsdxadumiogbdwgvrir-auth-token-code-verifier", value: "v" },
  { name: "orbis_terms", value: "2026-10-20" },
  { name: "orbis_terms_pending", value: "2026-10-20" },
  { name: "orbis_consent", value: "1" },
  { name: "orbis_sidebar", value: "open" },
];
const signOutRequest = () => new Request("https://tryorbis.app/auth/signout", { method: "POST" });
const setCookies = (res: Response) => res.headers.getSetCookie();

beforeEach(() => {
  state.cookies = [...SESSION];
  state.signOut = vi.fn(async () => ({ error: null }));
  state.configured = true;
  createServerClient.mockClear();
});

describe("which cookies signing out removes", () => {
  it("every Supabase session cookie and chunk, the PKCE verifier and the per-account terms cookies; nothing else", () => {
    expect(cookiesToClear(SESSION.map((c) => c.name)).sort()).toEqual([
      "orbis_terms",
      "orbis_terms_pending",
      "sb-vbsdxadumiogbdwgvrir-auth-token-code-verifier",
      "sb-vbsdxadumiogbdwgvrir-auth-token.0",
      "sb-vbsdxadumiogbdwgvrir-auth-token.1",
    ]);
    expect(cookiesToClear(["sb-localhost-auth-token"])).toEqual(["sb-localhost-auth-token"]);
    expect(cookiesToClear(["orbis_consent", "orbis_theme", "sb-other", "_vercel_jwt"])).toEqual([]);
  });
});

describe("POST /auth/signout", () => {
  it("ends this browser's session at Supabase and expires every session cookie", async () => {
    const res = await POST(signOutRequest());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://tryorbis.app/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.signOut).toHaveBeenCalledWith({ scope: "local" });
    const set = setCookies(res);
    for (const name of cookiesToClear(SESSION.map((c) => c.name)))
      expect(
        set.some((c) => c.startsWith(`${name}=;`) && /Expires=Thu, 01 Jan 1970/.test(c)),
        name,
      ).toBe(true);
    expect(set.some((c) => c.startsWith("orbis_consent="))).toBe(false);
    // Nothing in the response sets a session cookie back to a value.
    expect(set.filter((c) => c.startsWith("sb-") && !/^sb-[^=]+=;/.test(c))).toEqual([]);
    expect(set.find((c) => c.startsWith(`${SIGNED_OUT_COOKIE}=1`))).toMatch(/HttpOnly/);
  });

  it("still clears the browser when Supabase can't be reached or reports an error", async () => {
    state.signOut = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    let set = setCookies(await POST(signOutRequest()));
    expect(set.some((c) => c.startsWith("sb-vbsdxadumiogbdwgvrir-auth-token.0=;"))).toBe(true);
    state.signOut = vi.fn(async () => ({ error: new Error("AuthRetryableFetchError") }));
    set = setCookies(await POST(signOutRequest()));
    expect(set.some((c) => c.startsWith("sb-vbsdxadumiogbdwgvrir-auth-token.1=;"))).toBe(true);
  });
});

describe("the proxy on the sign-out request", () => {
  it("doesn't refresh the session (a fresh session cookie would undo the sign-out)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x");
    const { NextRequest } = await import("next/server");
    const res = await proxy(new NextRequest("https://tryorbis.app/auth/signout", { method: "POST" }));
    expect(createServerClient).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toEqual([]);
    // Other pages still refresh it.
    await proxy(new NextRequest("https://tryorbis.app/home"));
    expect(createServerClient).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});

describe("browser storage on sign-out", () => {
  it("removes the account's items and keeps device preferences", () => {
    const store = new Map<string, string>([...ACCOUNT_STORAGE_KEYS.map((k) => [k, "x"] as [string, string]), ["orbis:theme", "dark"], ["orbis:sidebar", "open"]]);
    forgetAccountData({ removeItem: (k: string) => void store.delete(k) });
    expect([...store.keys()].sort()).toEqual(["orbis:sidebar", "orbis:theme"]);
  });

  it("never throws when storage is unavailable", () => {
    expect(() =>
      forgetAccountData({
        removeItem: () => {
          throw new Error("SecurityError");
        },
      }),
    ).not.toThrow();
  });
});

describe("signing in again asks which account", () => {
  const form = readFileSync(join(process.cwd(), "src/components/common/login-form.tsx"), "utf8");
  it("Google and GitHub both show their account picker", () => {
    expect(form.match(/queryParams: \{ prompt: "select_account" \}/g)).toHaveLength(2);
  });
});
