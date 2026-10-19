/**
 * Chat and sign-in UX regressions: regenerate replaces the last saved reply
 * (database and usage modules mocked; demo provider), sign-in error wording and
 * callback messages.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeFailureCode, friendlyAuthError, LOGIN_MESSAGES, safeNext, RESET_PASSWORD_PATH } from "@/lib/auth-flow";
import { chatRequest } from "@/lib/validation";

const CONV = "00000000-0000-4000-8000-0000000000c1";
const { db, GUEST, trimmed } = vi.hoisted(() => ({
  trimmed: [] as { role: string; content: string }[][],
  db: { getConversation: vi.fn(), addMessages: vi.fn(), deleteMessage: vi.fn(), updateConversation: vi.fn(), createConversation: vi.fn() },
  GUEST: { mode: "guest", user: null, supabase: null } as const,
}));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  requireUserIfConfigured: async () => ({ mode: "authenticated", user: { id: "u1", email: "a@b.c", displayName: null }, supabase: {} }),
}));
vi.mock("@/lib/ai/trim", async (orig) => {
  const real = await orig<typeof import("@/lib/ai/trim")>();
  return { ...real, trimHistory: (h: Parameters<typeof real.trimHistory>[0], ...rest: [number, number]) => (trimmed.push(h), real.trimHistory(h, ...rest)) };
});
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), ...db }));
vi.mock("@/lib/usage", async (orig) => {
  const real = await orig<typeof import("@/lib/usage")>();
  return {
    ...real,
    planLimits: () => real.planLimits(GUEST),
    shouldSaveAllowance: async () => false,
    enforceLimits: async () => ({ requestId: "r", units: 1, entitlement: null }),
    recordRun: async () => {},
    releaseUsage: async () => {},
  };
});

const post = (body: unknown) =>
  new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.7.0.1" }, body: JSON.stringify(body) });

const saved = [
  { id: "m1", role: "user", content: "first question", created_at: "t" },
  { id: "m2", role: "assistant", content: "first answer", created_at: "t" },
  { id: "m3", role: "user", content: "second question", created_at: "t" },
  { id: "m4", role: "assistant", content: "OLD ANSWER", created_at: "t" },
];

beforeAll(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NOVA_MODELS"]) delete process.env[k];
});
beforeEach(() => {
  for (const f of Object.values(db)) f.mockReset();
  trimmed.length = 0;
  db.getConversation.mockResolvedValue({ conversation: { id: CONV, mode: "research", agent_id: null, builtin_agent: null }, messages: saved });
  db.addMessages.mockResolvedValue([{ id: "m5", role: "assistant" }]);
  db.deleteMessage.mockResolvedValue(undefined);
});

describe("regenerate (signed in)", () => {
  it("replaces the last saved reply: the question isn't saved again and the model doesn't see the old answer", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(post({ conversationId: CONV, message: "second question", regenerate: true }));
    const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ type: "done", assistantMessageId: "m5" });
    const rows = db.addMessages.mock.calls[0]![2] as { role: string }[];
    expect(rows.map((r) => r.role)).toEqual(["assistant"]);
    expect(db.deleteMessage).toHaveBeenCalledWith({}, CONV, "m4");
    expect(trimmed[0]!.map((m) => m.content)).toEqual(["first question", "first answer"]);
  });

  it("saves a normal turn when the last saved turn isn't the one being regenerated", async () => {
    const { POST } = await import("@/app/api/chat/route");
    // e.g. the failed reply was never saved, so the conversation ends with an earlier turn.
    await (await POST(post({ conversationId: CONV, message: "third question", regenerate: true }))).text();
    expect((db.addMessages.mock.calls[0]![2] as { role: string }[]).map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(db.deleteMessage).not.toHaveBeenCalled();
  });

  it("a plain send still saves both messages and deletes nothing", async () => {
    const { POST } = await import("@/app/api/chat/route");
    await (await POST(post({ conversationId: CONV, message: "second question" }))).text();
    expect((db.addMessages.mock.calls[0]![2] as { role: string }[]).map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(db.deleteMessage).not.toHaveBeenCalled();
  });

  it("picks the reply to replace only when the conversation ends with that question and its answer", async () => {
    const { regeneratedReply } = await import("@/lib/db");
    expect(regeneratedReply(saved, "second question")).toBe("m4");
    expect(regeneratedReply(saved, "first question")).toBeNull();
    expect(regeneratedReply(saved.slice(0, 3), "second question")).toBeNull();
    expect(regeneratedReply([], "x")).toBeNull();
    expect(chatRequest.safeParse({ message: "hi", regenerate: true }).success).toBe(true);
  });
});

describe("sign-in messages", () => {
  it("keeps specific advice for known errors and hides raw ones", () => {
    expect(friendlyAuthError("Invalid login credentials", "signin")).toMatch(/Wrong email or password/);
    expect(friendlyAuthError("Email not confirmed", "signin")).toMatch(/Confirm your email/);
    expect(friendlyAuthError("Email rate limit exceeded", "signin")).toMatch(/Too many attempts/);
    expect(friendlyAuthError("Failed to fetch", "signin")).toMatch(/Couldn't reach/);
    expect(friendlyAuthError("Password should be at least 6 characters.", "signup")).toMatch(/stronger password/);
    expect(friendlyAuthError("Database error querying schema", "signin")).toBe("Sign-in isn't available right now. Please try again in a minute.");
    expect(friendlyAuthError("Database error saving new user", "signup")).not.toMatch(/Database/);
    expect(friendlyAuthError(undefined, "reset")).toMatch(/Password reset isn't available/);
  });

  it("only says the email is confirmed when the callback actually had a code", () => {
    expect(exchangeFailureCode(null, true)).toBe("email_confirmed");
    expect(exchangeFailureCode(null, false)).toBe("link_invalid");
    expect(exchangeFailureCode("google", false)).toBe("google_expired");
    expect(exchangeFailureCode(null, true, RESET_PASSWORD_PATH)).toBe("reset_expired");
    expect(LOGIN_MESSAGES.link_invalid.tone).toBe("danger");
    expect(safeNext(RESET_PASSWORD_PATH)).toBe(RESET_PASSWORD_PATH);
  });
});

describe("chat helpers", () => {
  it("measures attachments as sent, so the total stays under the request cap", async () => {
    const { attachmentBytes, MAX_ATTACHMENTS_BYTES } = await import("@/components/studio/chat-client");
    expect(attachmentBytes([{ content: "abc" }])).toBe(5); // JSON quotes included
    expect(attachmentBytes([{ content: "é" }])).toBe(4); // UTF-8
    expect(attachmentBytes([{ content: "\n".repeat(10) }])).toBe(22); // escaped newlines double
    // Three files at the per-file limit would overflow a 220 kB body; the total cap refuses the third.
    const file = { content: "x".repeat(60_000) };
    expect(attachmentBytes([file, file])).toBeLessThanOrEqual(MAX_ATTACHMENTS_BYTES);
    expect(attachmentBytes([file, file, file])).toBeGreaterThan(MAX_ATTACHMENTS_BYTES);
    expect(MAX_ATTACHMENTS_BYTES + 12_000 * 3).toBeLessThan(220_000);
  });

  it("escapes LIKE wildcards in chat title searches", async () => {
    const { escapeLike } = await import("@/lib/db");
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
    expect(escapeLike("plain")).toBe("plain");
  });

  it("never names a plan-locked model in the Auto menu rows", async () => {
    const { autoPoolNames } = await import("@/components/studio/model-selector");
    const { DEFAULT_MODELS } = await import("@/lib/ai/registry");
    type M = import("@/lib/ai/types").ModelWithStatus;
    const all = DEFAULT_MODELS.map((m) => ({ ...m, available: m.provider === "anthropic" || m.provider === "openai", locked: false })) as M[];
    const deep = autoPoolNames(all, "deep");
    expect(deep.length).toBeGreaterThan(0);
    // Free plan: every reasoning model is locked, so Deep names none (the row shows only its blurb).
    const free = all.map((m) => ({ ...m, locked: deep.includes(m.displayName) }));
    expect(autoPoolNames(free, "deep")).toEqual([]);
    for (const mode of ["quick", "balanced", "coding", "research"] as const)
      for (const n of autoPoolNames(free, mode)) expect(free.find((m) => m.displayName === n)!.locked).toBe(false);
  });
});
