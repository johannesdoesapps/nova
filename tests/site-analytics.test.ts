import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import { ANALYTICS_OFF_KEY, analyticsDeclined, cleanAnalyticsUrl } from "@/components/common/site-analytics";

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

  it("never count a shared link's secret code", () => {
    expect(cleanAnalyticsUrl("https://tryorbis.app/share/chat/Ab3_xYz-0123456789abcdefghijklmnop")).toBe("https://tryorbis.app/share/chat/[link]");
    expect(cleanAnalyticsUrl("https://tryorbis.app/share/secret-workspace-token")).toBe("https://tryorbis.app/share/[link]");
  });

  it("leave ordinary pages alone", () => {
    expect(cleanAnalyticsUrl("https://tryorbis.app/pricing")).toBe("https://tryorbis.app/pricing");
  });
});

describe("visit-count opt-out", () => {
  const store = new Map<string, string>();
  const stub = (nav: Record<string, unknown>) => {
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    vi.stubGlobal("navigator", nav);
  };
  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it("counts by default", () => {
    stub({});
    expect(analyticsDeclined()).toBe(false);
  });
  it("stops when this browser turned counts off", () => {
    stub({});
    store.set(ANALYTICS_OFF_KEY, "1");
    expect(analyticsDeclined()).toBe(true);
  });
  it("respects Global Privacy Control and Do Not Track", () => {
    stub({ globalPrivacyControl: true });
    expect(analyticsDeclined()).toBe(true);
    stub({ doNotTrack: "1" });
    expect(analyticsDeclined()).toBe(true);
  });
});
