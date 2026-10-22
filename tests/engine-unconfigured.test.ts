/** Visitors never see the server's setup instructions (secret names) when the engine isn't connected. */
import { describe, expect, it, vi } from "vitest";
import { ENGINE_UNAVAILABLE, engineFetch } from "@/lib/engine";

describe("engine not configured", () => {
  it("gives a plain message without setting names", async () => {
    vi.stubEnv("ORBIS_ENGINE_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = await engineFetch("share/abc").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(ENGINE_UNAVAILABLE);
    expect((err as Error).message).not.toMatch(/ORBIS_|SECRET|engine/i);
    expect(warn).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
