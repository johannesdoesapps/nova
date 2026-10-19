/** Public site: sitemap, robots, content integrity and sign-in destination. */
import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { FEATURES, GUIDES, featureBySlug, guideBySlug } from "@/content/site";
import { afterSignIn } from "@/lib/auth-flow";
import { siteUrl } from "@/lib/seo";

describe("sitemap and robots", () => {
  const urls = sitemap().map((e) => e.url);

  it("lists every public page on the configured domain, and nothing private", () => {
    expect(urls).toContain(`${siteUrl()}/`);
    for (const f of FEATURES) expect(urls).toContain(`${siteUrl()}/features/${f.slug}`);
    for (const g of GUIDES) expect(urls).toContain(`${siteUrl()}/docs/${g.slug}`);
    for (const p of ["/pricing", "/security", "/docs", "/features"]) expect(urls).toContain(siteUrl() + p);
    for (const u of urls) {
      expect(u.startsWith(siteUrl())).toBe(true);
      expect(u).not.toMatch(/\/(chat|agents|admin|workforce|missions|council|arena|login|api|auth|share)(\/|$)/);
    }
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("blocks API and auth routes and points to the sitemap", () => {
    const r = robots();
    const rule = [r.rules].flat()[0]!;
    expect(rule.disallow).toEqual(expect.arrayContaining(["/api/", "/auth/"]));
    expect(r.sitemap).toBe(`${siteUrl()}/sitemap.xml`);
  });
});

describe("content", () => {
  it("links each feature to a guide that exists, and each guide to a feature that exists", () => {
    for (const f of FEATURES) if (f.guide) expect(guideBySlug(f.guide), f.slug).toBeDefined();
    for (const g of GUIDES) if (g.feature) expect(featureBySlug(g.feature), g.slug).toBeDefined();
  });

  it("keeps titles unique and short enough for search results", () => {
    const titles = [...FEATURES.map((f) => f.title), ...GUIDES.map((g) => g.title)];
    expect(new Set(titles).size).toBe(titles.length);
    for (const t of titles) expect(`${t} · NOVA`.length, t).toBeLessThanOrEqual(70);
    for (const d of [...FEATURES, ...GUIDES].map((x) => x.description)) expect(d.length).toBeLessThanOrEqual(200);
  });

  it("labels limited features honestly", () => {
    expect(featureBySlug("autonomous-developer")!.status).toBe("preview");
    for (const f of FEATURES) expect(f.limits.length, f.slug).toBeGreaterThan(0);
  });
});

describe("sign-in destination", () => {
  it("opens the chat unless a specific same-site page was requested", () => {
    expect(afterSignIn(null)).toBe("/chat");
    expect(afterSignIn("/")).toBe("/chat");
    expect(afterSignIn("/missions/1")).toBe("/missions/1");
    expect(afterSignIn("https://evil.example")).toBe("/chat");
  });
});
