import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertText, alertsConfigured, noteError, resetAlerts, safeMessage } from "@/lib/alerts";

describe("error alerts", () => {
  beforeEach(() => {
    resetAlerts();
    vi.stubEnv("RESEND_API_KEY", "re_test_key_not_real");
    vi.stubEnv("ALERT_EMAIL", "owner@example.test");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("are off without both settings", () => {
    expect(alertsConfigured({})).toBe(false);
    expect(alertsConfigured({ RESEND_API_KEY: "x" })).toBe(false);
    expect(alertsConfigured({ RESEND_API_KEY: "x", ALERT_EMAIL: "a@b.c" })).toBe(true);
  });

  it("send one email for a burst, then stay quiet for an hour", async () => {
    const send = vi.fn(async () => {});
    const t = 1_000_000;
    for (let i = 0; i < 4; i++) noteError(new Error("boom"), "chat", t + i, send);
    expect(send).not.toHaveBeenCalled();
    noteError(new Error("boom"), "code.files", t + 5, send);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) noteError(new Error("boom"), "chat", t + 10_000 + i, send);
    expect(send).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 5; i++) noteError(new Error("again"), "chat", t + 61 * 60_000 + i, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("old errors fall out of the window", () => {
    const send = vi.fn(async () => {});
    for (let i = 0; i < 4; i++) noteError(new Error("x"), "a", i * 11 * 60_000, send);
    expect(send).not.toHaveBeenCalled();
  });

  it("do nothing when not configured", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const send = vi.fn(async () => {});
    for (let i = 0; i < 10; i++) noteError(new Error("x"), "a", i, send);
    expect(send).not.toHaveBeenCalled();
  });

  it("say where and how often, without secrets", () => {
    const { subject, text } = alertText(
      [
        { at: 0, where: "chat", message: "timeout" },
        { at: 1, where: "chat", message: "timeout" },
        { at: 2, where: "code.files", message: "db down" },
      ],
      "https://tryorbis.app",
    );
    expect(subject).toBe("Orbis: 3 errors in the last 10 minutes");
    expect(text).toContain("• chat: 2× — timeout");
    expect(text).toContain("• code.files: 1× — db down");
    expect(safeMessage(new Error("bad key sk-ant-abcdefghijklmnop123 here\nstack"))).toBe("bad key [redacted] here");
    expect(safeMessage(new Error("request_validation_failed for token eyJhbGciOiJIUzI1NiIsInR5cCI6"))).toBe("request_validation_failed for token [redacted]");
  });
});
