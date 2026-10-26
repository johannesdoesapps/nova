/**
 * Stripe billing with Stripe's API mocked (no network): checkout for Pro and
 * Max (monthly and yearly), plan changes, cancellation, renewals, failed
 * payments, webhook signature checks, and how subscriptions are stored.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const upserts: Record<string, unknown>[] = [];
const ledger: Record<string, unknown>[] = [];
const events = new Set<string>();
let storedSub: Record<string, unknown> | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  serviceSupabase: () => ({
    from: (table: string) => {
      let key: unknown = null;
      const q = {
        select: () => q,
        eq: (_c: string, v: unknown) => ((key = v), q),
        maybeSingle: async () => ({ data: table === "stripe_events" ? (events.has(String(key)) ? { id: key } : null) : storedSub, error: null }),
        upsert: async (row: Record<string, unknown>) => {
          if (table === "stripe_events") events.add(String(row.id));
          else if (table === "billing_ledger") {
            if (!ledger.some((l) => l.stripe_object_id === row.stripe_object_id)) ledger.push(row);
          } else upserts.push(row);
          return { error: null };
        },
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
  process.env.NEXT_PUBLIC_SITE_URL = "https://orbis.example";
});
afterAll(() => {
  process.env = saved;
});
beforeEach(() => {
  upserts.length = 0;
  ledger.length = 0;
  events.clear();
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
  metadata: { user_id: "user-1", orbis_plan: "pro" },
  items: { data: [{ id: "si_1", current_period_start: 1_792_400_000, current_period_end: 1_795_000_000, price: { id: "price_pro", lookup_key: "orbis_pro_month_usd_1500", unit_amount: 1500, recurring: { interval: "month" }, metadata: {} } }] },
  ...over,
});
const withPrice = (lookup: string, cents: number, interval: "month" | "year") => ({
  items: { data: [{ id: "si_1", current_period_start: 1_792_400_000, current_period_end: 1_795_000_000, price: { id: `price_${lookup}`, lookup_key: lookup, unit_amount: cents, recurring: { interval }, metadata: {} } }] },
});
const post = (body: unknown) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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
      billing_interval: "month",
      price_usd: 15,
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

  it("reads Max and yearly billing from the Stripe price", async () => {
    const { subscriptionRow, parseLookupKey, priceLookupKey } = await import("@/lib/billing/stripe");
    expect(subscriptionRow(subscription(withPrice("orbis_max_year_usd_118800", 118_800, "year")) as never, "user-1")).toMatchObject({ plan: "max", billing_interval: "year", price_usd: 1188 });
    expect(priceLookupKey("max", "year", 118_800)).toBe("orbis_max_year_usd_118800");
    expect(parseLookupKey("orbis_pro_month_usd_1500")).toEqual({ plan: "pro", interval: "month" });
    expect(parseLookupKey("something_else")).toBeNull();
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

  it("applies upgrades, renewals and failed payments from Stripe", async () => {
    const { stripeClient } = await import("@/lib/billing/stripe");
    const retrieve = vi.spyOn(stripeClient()!.subscriptions, "retrieve");
    retrieve.mockResolvedValue(subscription(withPrice("orbis_max_month_usd_11000", 11_000, "month")) as never);
    await signedPost({ id: "evt_6", type: "customer.subscription.updated", data: { object: subscription() } });
    expect(upserts.at(-1)).toMatchObject({ plan: "max", billing_interval: "month", price_usd: 110, status: "active" });
    // Renewal: a new period.
    retrieve.mockResolvedValue(subscription({ items: { data: [{ ...subscription().items.data[0], current_period_start: 1_795_000_000, current_period_end: 1_797_600_000 }] } }) as never);
    await signedPost({ id: "evt_7", type: "customer.subscription.updated", data: { object: subscription() } });
    expect(upserts.at(-1)).toMatchObject({ current_period_start: new Date(1_795_000_000_000).toISOString() });
    // A failed renewal payment: past_due, which gives Free limits until paid.
    retrieve.mockResolvedValue(subscription({ status: "past_due" }) as never);
    await signedPost({ id: "evt_8", type: "customer.subscription.updated", data: { object: subscription() } });
    expect(upserts.at(-1)).toMatchObject({ status: "past_due" });
  });

  it("handles each event once, even when Stripe delivers it again", async () => {
    const { stripeClient } = await import("@/lib/billing/stripe");
    const retrieve = vi.spyOn(stripeClient()!.subscriptions, "retrieve").mockResolvedValue(subscription() as never);
    const evt = { id: "evt_dup", type: "customer.subscription.updated", data: { object: subscription() } };
    expect((await signedPost(evt)).status).toBe(200);
    const again = await signedPost(evt);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("records money collected excluding tax, failed payments and refunds", async () => {
    storedSub = { user_id: "user-1" };
    const invoice = {
      id: "in_1",
      object: "invoice",
      currency: "usd",
      customer: "cus_123",
      amount_paid: 1620,
      amount_due: 1620,
      created: 1_792_400_000,
      status_transitions: { paid_at: 1_792_400_100 },
      total_taxes: [{ amount: 120, tax_behavior: "exclusive" }],
      parent: { type: "subscription_details", subscription_details: { metadata: { user_id: "user-1", orbis_plan: "pro" }, subscription: "sub_123" } },
    };
    await signedPost({ id: "evt_10", type: "invoice.paid", data: { object: invoice } });
    await signedPost({ id: "evt_10b", type: "invoice.paid", data: { object: invoice } }); // same invoice, new event: stored once
    expect(ledger).toEqual([expect.objectContaining({ stripe_object_id: "in_1", kind: "payment", plan: "pro", amount_usd: 15, tax_usd: 1.2, user_id: "user-1" })]);
    await signedPost({ id: "evt_11", type: "invoice.payment_failed", data: { object: { ...invoice, id: "in_2", amount_paid: 0 } } });
    expect(ledger.at(-1)).toMatchObject({ kind: "failed_payment", amount_usd: 16.2, stripe_object_id: "failed:evt_11" });
    const { stripeClient } = await import("@/lib/billing/stripe");
    vi.spyOn(stripeClient()!.charges, "retrieve").mockResolvedValue({ id: "ch_1", customer: "cus_123" } as never);
    await signedPost({ id: "evt_12", type: "refund.created", data: { object: { id: "re_1", object: "refund", amount: 1500, currency: "usd", charge: "ch_1", status: "succeeded", created: 1_792_500_000 } } });
    expect(ledger.at(-1)).toMatchObject({ kind: "refund", amount_usd: 15, user_id: "user-1" });
  });

  it("asks Stripe to retry when saving fails", async () => {
    const { stripeClient } = await import("@/lib/billing/stripe");
    vi.spyOn(stripeClient()!.subscriptions, "retrieve").mockRejectedValue(new Error("network"));
    const res = await signedPost({ id: "evt_5", type: "customer.subscription.updated", data: { object: subscription() } });
    expect(res.status).toBe(500);
  });
});

describe("POST /api/billing/checkout", () => {
  it("opens a $20/month USD Pro checkout tied to the user", async () => {
    const { stripeClient } = await import("@/lib/billing/stripe");
    const s = stripeClient()!;
    vi.spyOn(s.prices, "list").mockResolvedValue({ data: [] } as never);
    const createPrice = vi.spyOn(s.prices, "create").mockResolvedValue({ id: "price_pro" } as never);
    const create = vi.spyOn(s.checkout.sessions, "create").mockResolvedValue({ url: "https://checkout.stripe.com/c/pay_1" } as never);
    const { POST } = await import("@/app/api/billing/checkout/route");
    const res = await POST(post({ plan: "pro", interval: "month" }));
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/c/pay_1" });
    expect(createPrice).toHaveBeenCalledWith(expect.objectContaining({ currency: "usd", unit_amount: 2000, recurring: { interval: "month" }, lookup_key: "orbis_pro_month_usd_2000" }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        line_items: [{ price: "price_pro", quantity: 1 }],
        customer_email: "pat@example.com",
        client_reference_id: "user-1",
        subscription_data: { metadata: { user_id: "user-1", orbis_plan: "pro" } },
        success_url: "https://orbis.example/usage?upgraded=pro&session_id={CHECKOUT_SESSION_ID}",
      }),
      // A double click or a second tab gets the same Checkout back, not a second subscription.
      { idempotencyKey: expect.stringMatching(/^checkout:user-1:pro:month:price_pro:\d+$/) },
    );
  });

  it("sells Max yearly with the annual discount, reusing an existing Stripe price", async () => {
    const { stripeClient } = await import("@/lib/billing/stripe");
    const s = stripeClient()!;
    const list = vi.spyOn(s.prices, "list").mockResolvedValue({ data: [{ id: "price_max_year" }] } as never);
    const createPrice = vi.spyOn(s.prices, "create");
    const create = vi.spyOn(s.checkout.sessions, "create").mockResolvedValue({ url: "https://checkout.stripe.com/c/pay_2" } as never);
    const { POST } = await import("@/app/api/billing/checkout/route");
    await POST(post({ plan: "max", interval: "year" }));
    // $100 × 12 × (1 − 10%) = $1,080 a year.
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ["orbis_max_year_usd_108000"] }));
    expect(createPrice).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ line_items: [{ price: "price_max_year", quantity: 1 }] }), expect.objectContaining({ idempotencyKey: expect.any(String) }));
  });

  it("won't sell a second subscription", async () => {
    userSub.row = { plan: "pro", status: "active", stripe_customer_id: "cus_1" };
    const { POST } = await import("@/app/api/billing/checkout/route");
    expect((await POST(post({ plan: "max" }))).status).toBe(409);
  });

  it("refuses unknown plans", async () => {
    const { POST } = await import("@/app/api/billing/checkout/route");
    expect((await POST(post({ plan: "free" }))).status).toBe(400);
  });
});

describe("POST /api/billing/change", () => {
  const setup = async (current: Record<string, unknown>) => {
    userSub.row = { plan: "pro", status: "active", billing_interval: "month", price_usd: 15, stripe_customer_id: "cus_123", stripe_subscription_id: "sub_123", ...current };
    const { stripeClient } = await import("@/lib/billing/stripe");
    const s = stripeClient()!;
    vi.spyOn(s.prices, "list").mockImplementation(((p: { lookup_keys: string[] }) => Promise.resolve({ data: [{ id: `price_${p.lookup_keys[0]}` }] })) as never);
    vi.spyOn(s.subscriptions, "retrieve").mockResolvedValue(subscription() as never);
    const update = vi.spyOn(s.subscriptions, "update").mockResolvedValue(subscription() as never);
    const { POST } = await import("@/app/api/billing/change/route");
    return { update, POST };
  };

  it("upgrades Pro to Max right away, charging the difference pro-rata", async () => {
    const { update, POST } = await setup({});
    const res = await POST(post({ plan: "max", interval: "month" }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith("sub_123", { items: [{ id: "si_1", price: "price_orbis_max_month_usd_10000" }], proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete" });
    expect(update).toHaveBeenCalledWith("sub_123", expect.objectContaining({ cancel_at_period_end: false, metadata: expect.objectContaining({ orbis_plan: "max" }) }));
    expect(upserts.length).toBeGreaterThan(0); // allowance updated immediately
  });

  it("keeps the old plan when the upgrade payment fails (Stripe leaves it pending)", async () => {
    const { update, POST } = await setup({});
    update.mockResolvedValueOnce({ ...subscription(), pending_update: { expires_at: 1 } } as never);
    const res = await POST(post({ plan: "max", interval: "month" }));
    expect(res.status).toBe(402);
    expect((await res.json()).error.message).toMatch(/didn't go through, so your plan hasn't changed/);
    expect(update).toHaveBeenCalledTimes(1); // no metadata switch to the new plan
  });

  it("downgrades Max to Pro with a credit for the unused time", async () => {
    const { update, POST } = await setup({ plan: "max", price_usd: 110 });
    await POST(post({ plan: "pro", interval: "month" }));
    expect(update).toHaveBeenCalledWith("sub_123", expect.objectContaining({ proration_behavior: "create_prorations" }));
  });

  it("moves to Free at the end of the paid period", async () => {
    const { update, POST } = await setup({});
    const res = await POST(post({ plan: "free" }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith("sub_123", { cancel_at_period_end: true });
  });

  it("needs an existing subscription", async () => {
    const { POST } = await setup({ status: "canceled" });
    expect((await POST(post({ plan: "max" }))).status).toBe(404);
  });
});
