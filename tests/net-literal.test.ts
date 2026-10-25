import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("guarded requests to literal IP addresses", () => {
  it("refuses private and reserved IPs written directly in the URL, without connecting", async () => {
    const { safeRequest, BlockedAddressError } = await import("@/lib/security/net");
    for (const u of ["http://127.0.0.1/", "http://2130706433/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://10.0.0.5/", "http://[::ffff:192.168.1.1]/"])
      await expect(safeRequest(u, { timeoutMs: 500 }), u).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
