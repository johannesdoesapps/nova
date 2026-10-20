/**
 * "Continue with Google": redirect safety, the OAuth callback, provider
 * detection and user-facing messages. Supabase is mocked here; the real Google
 * round trip can only be tested once Google is enabled in Supabase Auth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displayNameFrom, exchangeFailureCode, LOGIN_MESSAGES, loginMessage, oauthErrorCode, oauthRedirectTo, safeNext } from "@/lib/auth-flow";

const exchange = vi.fn();
const inserted: unknown[] = [];
let configured = true;
// Just enough of the query builder for the legal-acceptance check after OAuth sign-up.
const legalTable = {
  select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }),
  insert: async (rows: unknown) => (inserted.push(rows), { error: null }),
};
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({ auth: { exchangeCodeForSession: exchange }, from: () => legalTable }) }));
vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<typeof import("@/lib/env")>()),
  isSupabaseConfigured: () => configured,
  publicEnv: { supabaseUrl: "https://sb.example.co", supabaseKey: "pk_test", siteUrl: "https://orbis.example" },
}));

const { GET } = await import("@/app/auth/callback/route");
const { authProviders } = await import("@/lib/auth-providers");

async function callback(query: string, cookie?: string) {
  const res = await GET(new Request(`https://orbis.example/auth/callback?${query}`, cookie ? { headers: { cookie } } : undefined));
  const loc = new URL(res.headers.get("location")!);
  return { status: res.status, path: loc.pathname, origin: loc.origin, params: Object.fromEntries(loc.searchParams), setCookie: res.headers.get("set-cookie") ?? "" };
}

describe("redirect safety", () => {
  it("keeps same-site paths and rejects anything that could leave Orbis", () => {
    expect(safeNext("/missions/42?tab=log")).toBe("/missions/42?tab=log");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "/\\\\evil", "javascript:alert(1)", "/ok\nSet-Cookie:x", "", null, undefined, "chat"])
      expect(safeNext(bad as string)).toBe("/");
    expect(safeNext(["/a", "/b"])).toBe("/a");
  });

  it("sends Google back to Orbis's callback with only a safe next path", () => {
    const u = new URL(oauthRedirectTo("https://orbis.example", "/workforce"));
    expect(u.origin + u.pathname).toBe("https://orbis.example/auth/callback");
    expect(u.searchParams.get("via")).toBe("google");
    expect(u.searchParams.get("next")).toBe("/workforce");
    expect(new URL(oauthRedirectTo("https://orbis.example", "//evil.example")).searchParams.has("next")).toBe(false);
  });
});

describe("OAuth callback", () => {
  beforeEach(() => {
    exchange.mockReset();
    configured = true;
  });

  it("exchanges the code for a session and continues to the requested page", async () => {
    exchange.mockResolvedValue({ error: null });
    const r = await callback("code=abc&via=google&next=%2Fworkforce&sb_flow_id=f1");
    expect(exchange).toHaveBeenCalledWith("abc", { flowId: "f1" });
    expect(r.status).toBe(307);
    expect(r.origin + r.path).toBe("https://orbis.example/workforce");
  });

  it("never redirects off-site after sign-in", async () => {
    exchange.mockResolvedValue({ error: null });
    for (const next of ["https://evil.example", "%2F%2Fevil.example", "%2F%5Cevil.example"]) {
      const r = await callback(`code=abc&via=google&next=${next}`);
      expect(r.origin + r.path).toBe("https://orbis.example/chat");
    }
  });

  it("reports a cancelled Google sign-in without creating a session", async () => {
    const r = await callback("error=access_denied&error_description=The+user+denied&via=google&next=%2Fchat");
    expect(exchange).not.toHaveBeenCalled();
    expect(r.path).toBe("/login");
    expect(r.params).toEqual({ msg: "google_cancelled", next: "/chat" });
  });

  it("does not echo provider error text to the page", async () => {
    const r = await callback("error=server_error&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E&via=google");
    expect(r.params.msg).toBe("google_failed");
    expect(JSON.stringify(r.params)).not.toContain("script");
  });

  it("handles an expired, reused or cross-browser code", async () => {
    exchange.mockResolvedValue({ error: { message: "invalid flow state, no valid flow state found", code: "flow_state_not_found" } });
    const r = await callback("code=stale&via=google");
    expect(r.path).toBe("/login");
    expect(r.params.msg).toBe("google_expired");
  });

  it("handles a callback with no code at all", async () => {
    const r = await callback("via=google");
    expect(exchange).not.toHaveBeenCalled();
    expect(r.params.msg).toBe("google_expired");
  });

  it("doesn't claim the email is confirmed when an email link carried no code", async () => {
    const r = await callback("next=%2Fchat");
    expect(exchange).not.toHaveBeenCalled();
    expect(r.params).toEqual({ msg: "link_invalid", next: "/chat" });
  });

  it("sends a working password reset link to the reset page, and a stale one back to sign-in", async () => {
    exchange.mockResolvedValue({ error: null });
    expect((await callback("code=abc&next=%2Freset-password")).path).toBe("/reset-password");
    exchange.mockResolvedValue({ error: { message: "code verifier missing" } });
    expect((await callback("code=abc&next=%2Freset-password")).params).toEqual({ msg: "reset_expired", next: "/reset-password" });
  });

  it("records the Terms and Privacy acceptance ticked before Continue with Google, once", async () => {
    const { LEGAL } = await import("@/content/legal-meta");
    exchange.mockResolvedValue({ error: null });
    inserted.length = 0;
    const r = await callback("code=abc&via=google", `other=1; orbis_terms_pending=${LEGAL.version}`);
    expect(inserted).toEqual([[expect.objectContaining({ document: "terms", version: LEGAL.version, method: "signup" }), expect.objectContaining({ document: "privacy", method: "signup" })]]);
    expect(r.setCookie).toMatch(/orbis_terms_pending=;/);
    // Plain sign-in, or a stale version from an older form: nothing recorded.
    inserted.length = 0;
    await callback("code=abc&via=google");
    await callback("code=abc&via=google", "orbis_terms_pending=1999-01-01");
    expect(inserted).toEqual([]);
  });

  it("keeps the email-confirmation behaviour for email links", async () => {
    exchange.mockResolvedValue({ error: { message: "code verifier missing" } });
    const r = await callback("code=abc&next=%2Fchat");
    expect(r.params).toEqual({ msg: "email_confirmed", next: "/chat" });
  });
});

describe("messages", () => {
  it("maps provider errors to fixed messages", () => {
    expect(oauthErrorCode("access_denied")).toBe("google_cancelled");
    expect(oauthErrorCode("Unsupported provider: provider is not enabled")).toBe("google_unavailable");
    expect(oauthErrorCode("invalid_request", "bad_oauth_state")).toBe("google_expired");
    expect(oauthErrorCode("server_error", "signup_disabled")).toBe("signup_closed");
    expect(oauthErrorCode("something odd")).toBe("google_failed");
    expect(exchangeFailureCode("google")).toBe("google_expired");
    expect(exchangeFailureCode(null)).toBe("email_confirmed");
  });

  it("only shows known message codes on the sign-in page", () => {
    expect(loginMessage("google_cancelled")).toEqual(LOGIN_MESSAGES.google_cancelled);
    for (const bad of ["Your account is locked, call +1 555", "toString", "__proto__", undefined, ["google_failed"]]) expect(loginMessage(bad)).toBeNull();
  });

  it("names accounts from email sign-up or Google profile data, never from empty values", () => {
    expect(displayNameFrom({ display_name: "Jo" })).toBe("Jo");
    expect(displayNameFrom({ full_name: "Grace Hopper", name: "Grace" })).toBe("Grace Hopper");
    expect(displayNameFrom({ display_name: " ", name: "Ada" })).toBe("Ada");
    expect(displayNameFrom({ avatar_url: "x" })).toBeNull();
  });
});

describe("provider detection", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reads whether Google is enabled from Supabase's public settings", async () => {
    const f = vi.fn(async () => Response.json({ external: { google: true, github: true, email: true } }));
    globalThis.fetch = f as unknown as typeof fetch;
    expect(await authProviders()).toEqual({ google: true, github: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sb.example.co/auth/v1/settings");
    expect((init.headers as Record<string, string>).apikey).toBe("pk_test");
  });

  it("reports Google as off when Supabase says so, and unknown when Supabase can't be reached", async () => {
    globalThis.fetch = (async () => Response.json({ external: { google: false } })) as typeof fetch;
    expect(await authProviders()).toEqual({ google: false, github: false });
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    expect(await authProviders()).toEqual({ google: null, github: null });
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await authProviders()).toEqual({ google: null, github: null });
  });
});
