/** Starting the same Checkout twice within a few minutes reuses it, so a double click can't create two subscriptions. */
import { describe, expect, it } from "vitest";
import { checkoutIdempotencyKey } from "@/lib/billing/stripe";

describe("checkoutIdempotencyKey", () => {
  it("is the same for the same request within 15 minutes, different otherwise", () => {
    const t = Date.UTC(2026, 9, 26, 12, 1);
    const k = checkoutIdempotencyKey(["u1", "pro", "month", "price_1"], t);
    expect(checkoutIdempotencyKey(["u1", "pro", "month", "price_1"], t + 60_000)).toBe(k);
    expect(checkoutIdempotencyKey(["u1", "max", "month", "price_2"], t)).not.toBe(k);
    expect(checkoutIdempotencyKey(["u2", "pro", "month", "price_1"], t)).not.toBe(k);
    expect(checkoutIdempotencyKey(["u1", "pro", "month", "price_1"], t + 20 * 60_000)).not.toBe(k);
  });
});
