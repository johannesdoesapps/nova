import { describe, expect, it } from "vitest";
import { cleanAnalyticsUrl } from "@/components/common/site-analytics";

describe("analytics page addresses", () => {
  it("drop query strings and fragments (sign-in codes, chat ids, searches)", () => {
    expect(cleanAnalyticsUrl("https://tryorbis.app/auth/callback?code=secret123&next=/home")).toBe("https://tryorbis.app/auth/callback");
    expect(cleanAnalyticsUrl("https://tryorbis.app/chat?c=abc#m5")).toBe("https://tryorbis.app/chat");
    expect(cleanAnalyticsUrl("https://tryorbis.app/reset-password#access_token=xyz")).toBe("https://tryorbis.app/reset-password");
  });

  it("replace ids in the path", () => {
    expect(cleanAnalyticsUrl("https://tryorbis.app/code/0b7c3a52-5a1e-4f2e-9d55-2f6a8f1c9e10?build=1")).toBe("https://tryorbis.app/code/[id]");
    expect(cleanAnalyticsUrl("https://tryorbis.app/missions/0B7C3A52-5A1E-4F2E-9D55-2F6A8F1C9E10/tasks")).toBe("https://tryorbis.app/missions/[id]/tasks");
  });

  it("leave ordinary pages alone", () => {
    expect(cleanAnalyticsUrl("https://tryorbis.app/pricing")).toBe("https://tryorbis.app/pricing");
  });
});
