/**
 * The welcome email for new accounts: its words and links, safe use of the name from the sign-up form, and the rules
 * for sending it (new accounts only, once ever, nothing when email isn't set up). Resend and Supabase are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const users = new Map<string, { email: string; created_at: string; user_metadata: Record<string, unknown> }>();
const notifications = new Set<string>();
vi.mock("@/lib/supabase/admin", () => ({
  serviceSupabase: () => ({
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: users.has(id) ? { id, ...users.get(id)! } : null } }) } },
    from: () => ({
      insert: (row: { user_id: string; kind: string; period_key: string }) => ({
        select: async () => {
          const key = `${row.user_id}|${row.kind}|${row.period_key}`;
          if (notifications.has(key)) return { data: null, error: { code: "23505" } };
          notifications.add(key);
          return { data: [{ id: 1 }], error: null };
        },
      }),
      update: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }),
    }),
  }),
}));

const NOW = Date.parse("2026-10-27T12:00:00Z");
const sent: { to: string[]; subject: string; text: string; html?: string }[] = [];

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://tryorbis.app");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url) === "https://api.resend.com/emails") sent.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  });
  users.clear();
  notifications.clear();
  sent.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the welcome email's content", () => {
  it("greets by first name and points to where to start, in text and HTML", async () => {
    const { customerEmail } = await import("@/lib/email");
    const m = customerEmail("signup_welcome", { name: "Ada Lovelace" });
    expect(m.subject).toBe("Welcome to Orbis");
    expect(m.text.startsWith("Hi Ada,")).toBe(true);
    for (const path of ["/chat", "/code", "/jarvis", "/agents", "/usage", "/home"]) {
      expect(m.text).toContain(`https://tryorbis.app${path}`);
      expect(m.html).toContain(`href="https://tryorbis.app${path}"`);
    }
    expect(m.html).toContain("Welcome to Orbis, Ada");
    expect(m.text).toContain("one-time email");
  });

  it("never puts addresses, links or markup from the sign-up form into the email", async () => {
    const { customerEmail } = await import("@/lib/email");
    for (const name of ["<script>alert(1)</script>", "visit evil.example/win", "www.prize.example", "me@evil.example", "  "]) {
      const m = customerEmail("signup_welcome", { name });
      expect(m.text.startsWith("Hi,")).toBe(true);
      expect(m.html).not.toContain("script>alert");
      expect(m.html).toContain(">Welcome to Orbis<");
    }
    expect(customerEmail("signup_welcome", { name: "O'Neil & Co" }).html).toContain("Welcome to Orbis, O&#39;Neil");
    expect(customerEmail("signup_welcome", {}).text.startsWith("Hi,")).toBe(true);
  });
});

describe("sending the welcome email", () => {
  it("welcomes a new account once, with both versions and the name it signed up with", async () => {
    const { sendSignupWelcome } = await import("@/lib/email");
    users.set("u1", { email: "new@example.com", created_at: new Date(NOW - 60_000).toISOString(), user_metadata: { display_name: "Sam" } });
    expect(await sendSignupWelcome("u1", NOW)).toBe(true);
    expect(await sendSignupWelcome("u1", NOW)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ["new@example.com"], subject: "Welcome to Orbis" });
    expect(sent[0].text.startsWith("Hi Sam,")).toBe(true);
    expect(sent[0].html).toContain("<!doctype html>");
  });

  it("uses the Google or GitHub name when there's no display name", async () => {
    const { sendSignupWelcome } = await import("@/lib/email");
    users.set("u2", { email: "g@example.com", created_at: new Date(NOW).toISOString(), user_metadata: { full_name: "Grace Hopper" } });
    await sendSignupWelcome("u2", NOW);
    expect(sent[0].text.startsWith("Hi Grace,")).toBe(true);
  });

  it("never welcomes an existing account that signs in later", async () => {
    const { sendSignupWelcome, WELCOME_WINDOW_MS } = await import("@/lib/email");
    users.set("old", { email: "old@example.com", created_at: new Date(NOW - WELCOME_WINDOW_MS - 1).toISOString(), user_metadata: {} });
    expect(await sendSignupWelcome("old", NOW)).toBe(false);
    expect(sent).toHaveLength(0);
    expect(notifications.size).toBe(0);
  });

  it("does nothing when email isn't set up, or the account doesn't exist", async () => {
    const { sendSignupWelcome } = await import("@/lib/email");
    expect(await sendSignupWelcome("missing", NOW)).toBe(false);
    vi.stubEnv("RESEND_API_KEY", "");
    users.set("u3", { email: "x@example.com", created_at: new Date(NOW).toISOString(), user_metadata: {} });
    expect(await sendSignupWelcome("u3", NOW)).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
