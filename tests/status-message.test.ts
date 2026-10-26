/** Failed requests without a message of their own (a proxy's HTML error page, an empty body) get a plain-English one. */
import { describe, expect, it } from "vitest";
import { readApiError, statusMessage } from "@/hooks/use-ndjson";

describe("statusMessage", () => {
  it("explains the common statuses", () => {
    expect(statusMessage(401)).toMatch(/sign in/i);
    expect(statusMessage(429)).toMatch(/too many/i);
    for (const s of [502, 503, 504]) expect(statusMessage(s)).toMatch(/temporarily unavailable/i);
    expect(statusMessage(500)).toMatch(/went wrong/i);
    expect(statusMessage(418)).toBe("Request failed (418).");
  });

  it("prefers the server's own message, and falls back for HTML or empty bodies", async () => {
    const json = new Response(JSON.stringify({ error: { message: "Project not found." } }), { status: 404 });
    expect(await readApiError(json)).toBe("Project not found.");
    expect(await readApiError(new Response("<html>Bad gateway</html>", { status: 502 }))).toMatch(/temporarily unavailable/i);
    expect(await readApiError(new Response("{}", { status: 500 }))).toMatch(/went wrong/i);
  });
});
