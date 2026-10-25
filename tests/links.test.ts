import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractLinks, kindOf, MAX_PAGE_CHARS, readablePage, statusReason } from "@/lib/links/parse";

vi.mock("server-only", () => ({}));

describe("links in a chat message", () => {
  it("finds http(s) links, drops trailing punctuation, fragments and duplicates, keeps at most three", () => {
    expect(extractLinks("Look at https://example.com/plan. And (see https://a.org/x_(y)) then https://a.org/x_(y)#top!")).toEqual(["https://example.com/plan", "https://a.org/x_(y)"]);
    expect(extractLinks("no links here, just example.com")).toEqual([]);
    expect(extractLinks("https://a.com https://b.com https://c.com https://d.com")).toHaveLength(3);
    expect(extractLinks("ftp://x.com/file javascript:alert(1)")).toEqual([]);
  });

  it("reads a page's title and main text without scripts, styles or navigation", () => {
    const html = `<html><head><title>Q3 plan &amp; goals</title><style>body{}</style><script>alert(1)</script></head>
      <body><nav>Home About</nav><main><h1>Plan</h1><p>Grow revenue to &#8364;2m by &lsquo;Q4&rsquo;.</p>${"<p>Detail.</p>".repeat(60)}</main><footer>© 2026</footer></body></html>`;
    const p = readablePage(html, "text/html; charset=utf-8");
    expect(p.title).toBe("Q3 plan & goals");
    expect(p.text).toContain("Grow revenue to €2m by ‘Q4’.");
    expect(p.text).not.toMatch(/alert|Home About|body\{\}|© 2026/);
  });

  it("passes plain text through and cuts long pages", () => {
    expect(readablePage("  hello  ", "text/plain").text).toBe("hello");
    expect(readablePage("x".repeat(MAX_PAGE_CHARS + 50), "text/plain").text).toMatch(/cut off\]$/);
  });

  it("knows which content it can read", () => {
    expect(kindOf("text/html")).toBe("html");
    expect(kindOf("application/json")).toBe("text");
    expect(kindOf("application/pdf")).toBe("unsupported");
    expect(kindOf("image/png")).toBe("unsupported");
    expect(statusReason(403)).toMatch(/refused access/);
    expect(statusReason(404)).toMatch(/wasn't found/);
  });
});

const calls: string[] = [];
let responses: Record<string, { status: number; headers: Record<string, string>; body: string } | Error> = {};
vi.mock("@/lib/security/net", async () => {
  class BlockedAddressError extends Error {}
  return {
    BlockedAddressError,
    header: (res: { headers: Record<string, string> }, name: string) => res.headers[name] ?? null,
    safeRequest: async (url: string) => {
      calls.push(url);
      const r = responses[url];
      if (!r) throw new BlockedAddressError("blocked");
      if (r instanceof Error) throw r;
      return { url, truncated: false, ...r };
    },
  };
});

describe("opening a link", () => {
  beforeEach(() => {
    calls.length = 0;
    responses = {};
  });
  const page = (text: string) => ({ status: 200, headers: { "content-type": "text/html" }, body: `<title>T</title><p>${text}</p>` });

  it("follows redirects, each through the guarded request", async () => {
    const { readLink } = await import("@/lib/links/read");
    responses = { "https://short.ly/a": { status: 301, headers: { location: "https://site.com/plan" }, body: "" }, "https://site.com/plan": page("The plan has three phases. ".repeat(10)) };
    const r = await readLink("https://short.ly/a");
    expect(r.ok && r.finalUrl).toBe("https://site.com/plan");
    expect(calls).toEqual(["https://short.ly/a", "https://site.com/plan"]);
  });

  it("refuses a redirect to an internal address", async () => {
    const { readLink } = await import("@/lib/links/read");
    responses = { "https://evil.com/": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" }, body: "" } };
    const r = await readLink("https://evil.com/");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/private or internal/);
  });

  it("explains pages it can't read", async () => {
    const { readLink } = await import("@/lib/links/read");
    responses = {
      "https://a.com/": { status: 403, headers: {}, body: "" },
      "https://b.com/x.pdf": { status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF" },
      "https://c.com/": { status: 200, headers: { "content-type": "text/html" }, body: '<div id="root"></div><script src="/app.js"></script>' },
      "https://d.com/": new Error("getaddrinfo ENOTFOUND d.com"),
    };
    const reasons = await Promise.all(["https://a.com/", "https://b.com/x.pdf", "https://c.com/", "https://d.com/"].map(async (u) => ((r) => (r.ok ? "" : r.reason))(await readLink(u))));
    expect(reasons[0]).toMatch(/refused access/);
    expect(reasons[1]).toMatch(/application\/pdf file/);
    expect(reasons[2]).toMatch(/JavaScript/);
    expect(reasons[3]).toMatch(/doesn't exist/);
  });

  it("stops after too many redirects", async () => {
    const { readLink } = await import("@/lib/links/read");
    for (let i = 0; i < 10; i++) responses[`https://loop.com/${i}`] = { status: 302, headers: { location: `https://loop.com/${i + 1}` }, body: "" };
    const r = await readLink("https://loop.com/0");
    expect(!r.ok && r.reason).toMatch(/too many times/);
  });
});
