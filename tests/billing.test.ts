/**
 * Stripe billing with Stripe's API mocked (no network): checkout parameters,
 * webhook signature checks, and how subscriptions are stored.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const upserts: Record<string, unknown>[] = [];
let storedSub: Record<string, unknown> | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  serviceSupabase: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: storedSub, error: null }),
        upsert: async (row: Record<string, unknown>) => (upserts.push(row), { error: null }),
      };
      return q;
    },
  }),
}));
const userSub: { row: Record<string, unknown> | null } = { row: null };
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  requireUser: async () => ({
    mode: "authenticated",
    user: { id: "user-1", email: "pat@example.com" },
    supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: userSub.row, error: null }) }) }) }) },
  }),
}));

const SECRET = "whsec_test_secret";
const saved = { ...process.env };
beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-dummy";
  process.env.NEXT_PUBLIC_SITE_URL = "https://nova.example";
});
afterAll(() => {
  process.env = saved;
});
beforeEach(() => {
  upserts.length = 0;
  storedSub = null;
  userSub.row = null;
  vi.restoreAllMocks();
});

const subscription = (over: Record<string, unknown> = {}) => ({
  id: "sub_123",
  object: "subscription",
  status: "active",
  customer: "cus_123",
  cancel_at_period_end: false,
  metadata: { user_id: "user-1", nova_plan: "pro" },
  items: { data: [{ current_period_start: 1_792_400_000, current_period_end: 1_795_000_000 }] },
  ...over,
});

async function signedPost(event: Record<string, unknown>, secret = SECRET) {
  const { stripeClient } = await import("@/lib/billing/stripe");
  const payload = JSON.stringify(event);
  const header = stripeClient()!.webhooks.generateTestHeaderString({ payload, secret });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request("http://x/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": header }, body: payload }));
}

describe("subscription mapping", () => {
  it("stores Stripe's status and billing period", async () => {
    const { subscriptionRow, dbStatus } = await import("@/lib/billing/stripe");
    expect(subscriptionRow(subscription() as never, "user-1")).toEqual({
      user_id: "user-1",
      plan: "pro",
      status: "active",
      current_period_start: new Date(1_792_400_000_000).toISOString(),
      current_period_end: new Date(1_795_000_000_000).toISOString(),
      cancel_at_period_end: false,
      stripe_customer_id: "cus_123",
      stripe_subscription_id: "sub_123",
    });
    expect(["active", "trialing", "past_due", "canceled", "incomplete", "incomplete_expired", "unpaid", "paused"].map(dbStatus)).toEqual([
      "active", "trialing", "past_due", "canceled", "incomplete", "canceled", "inactive", "inactive",
    ]);
  });
});

describe("POST /api/stripe/webhook", () => {
  it("refuses events without a valid signature", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const unsigned = await POST(new Request("http://x", { method: "POST", body: "{}" }));
    expect(unsigned.status).toBe(400);
    const forged = await signedPost({ id: "evt_1", type: "customer.subscription.updated", data: { object: subscription() } }, "whsec_wrong");
    expect(forged.status).toBe(400);
    expect(upserts).toHaveLength(0);
  });

  it("activates Pro after checkout, from the subscription re-read at Stripe", async () => {
    const { stripeClient } = await import("@/lib/billing/stripe");
    const retrieve = vi.spyOn(stripeClient()!.subscriptions, "retrieve").mockResolvedValue(subscription() as never);
    const res = await signedPost({ id: "evt_2", type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_123", client_reference_id: "user-1" } } });
    expect(res.status).toBe(200);
    expect(retrieve).toHaveBeenCalledWith("sub_123");
    expect(upserts[0]).toMatchObject({ user_id: "user-1", plan: "pro", status: "active", stripe_subscription_id: "sub_123" });
  });

  it("records cancellation, and finds the user by customer when metadata is missing", async () => {
    const { stripeClient } = await import("@/lib/billing/stripe");
    vi.spyOn(stripeClient()!.subscriptions, "retrieve").mockResolvedValue(subscription({ status: "canceled", metadata: {} }) as never);
    storedSub = { user_id: "user-1", stripe_subscription_id: "sub_123", status: "active" };
    const res = await signedPost({ id: "evt_3", type: "customer.subscription.deleted", data: { object: subscription() } });
    expect(res.status).toBe(200);
    expect(upserts[0]).toMatchObject({ user_id: "user-1", status: "canceled" });
  });

  it("doesn't let a late event for an old subscription cancel a newer active one", async () => {
    const { stripeClient } = await import("@/lib/billing/stripe");
    vi.spyOn(stripeClient()!.subscriptions, "retrieve").mockResolvedValue(subscription({ id: "sub_old", status: "canceled" }) as never);
    storedSub = { user_id: "user-1", stripe_subscription_id: "sub_new", status: "active" };
    await signedPost({ id: "evt_4", type: "customer.subscription.deleted", data: { object: subscription({ id: "sub_old" }) } });
    expect(upserts).toHaveLength(0);
  });

  it("asks Stripe to retry when saving fails", async () => {
    const { stripeClient } = await import("@/lib/billing/stripe");
    vi.spyOn(stripeClient()!.subscriptions, "retrieve").mockRejectedValue(new Error("network"));
    const res = await signedPost({ id: "evt_5", type: "customer.subscription.updated", data: { object: subscription() } });
    expect(res.status).toBe(500);
  });
});

describe("POST /api/billing/checkout", () => {
  it("opens a $12/month USD subscription checkout tied to the user", async () => {
    const { stripeClient } = await import("@/lib/billing/stripe");
    const s = stripeClient()!;
    vi.spyOn(s.prices, "list").mockResolvedValue({ data: [] } as never);
    const createPrice = vi.spyOn(s.prices, "create").mockResolvedValue({ id: "price_pro" } as never);
    const create = vi.spyOn(s.checkout.sessions, "create").mockResolvedValue({ url: "https://checkout.stripe.com/c/pay_1" } as never);
    const { POST } = await import("@/app/api/billing/checkout/route");
    const res = await POST();
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/c/pay_1" });
    expect(createPrice).toHaveBeenCalledWith(expect.objectContaining({ currency: "usd", unit_amount: 1200, recurring: { interval: "month" }, lookup_key: "nova_pro_monthly_usd_1200" }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        line_items: [{ price: "price_pro", quantity: 1 }],
        customer_email: "pat@example.com",
        client_reference_id: "user-1",
        subscription_data: { metadata: { user_id: "user-1", nova_plan: "pro" } },
        success_url: "https://nova.example/chat?upgraded=1",
      }),
    );
  });

  it("won't sell Pro twice", async () => {
    userSub.row = { plan: "pro", status: "active", stripe_customer_id: "cus_1" };
    const { POST } = await import("@/app/api/billing/checkout/route");
    expect((await POST()).status).toBe(409);
  });
});
