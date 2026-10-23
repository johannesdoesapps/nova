/**
 * The public site's content stays consistent: every link points at a real
 * page, every image exists, guides and features reference each other, and
 * the pricing summary comes from the enforced plan settings.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NAV, SIGN_IN_HREF, SIGN_UP_HREF } from "@/components/marketing/links";
import { DEMOS, HERO_SHOT } from "@/content/demos";
import { FAQ, FEATURES, GUIDES, PILLARS, PRICING, STATUS_LABEL, featuresIn } from "@/content/site";
import { PLANS } from "@/lib/plans";

const PUBLIC = join(__dirname, "..", "public");
const pages = new Set(["/", "/features", "/pricing", "/docs", "/security", ...FEATURES.map((f) => `/features/${f.slug}`), ...GUIDES.map((g) => `/docs/${g.slug}`)]);

describe("site content", () => {
  it("has unique feature and guide pages that reference each other", () => {
    expect(new Set(FEATURES.map((f) => f.slug)).size).toBe(FEATURES.length);
    expect(new Set(GUIDES.map((g) => g.slug)).size).toBe(GUIDES.length);
    for (const f of FEATURES)
      if (f.guide)
        expect(
          GUIDES.some((g) => g.slug === f.guide),
          f.slug,
        ).toBe(true);
    for (const g of GUIDES)
      if (g.feature)
        expect(
          FEATURES.some((f) => f.slug === g.feature),
          g.slug,
        ).toBe(true);
  });

  it("puts every feature in one of the three pillars", () => {
    expect(PILLARS.map((p) => p.id)).toEqual(["think", "build", "execute"]);
    expect(PILLARS.flatMap((p) => featuresIn(p.id)).length).toBe(FEATURES.length);
    for (const p of PILLARS) expect(pages.has(p.href), p.href).toBe(true);
  });

  it("links only to real pages", () => {
    for (const n of NAV) expect(pages.has(n.href), n.href).toBe(true);
    for (const d of DEMOS) expect(pages.has(d.href), d.href).toBe(true);
    expect(SIGN_UP_HREF).toMatch(/^\/login\?mode=signup/);
    expect(SIGN_IN_HREF).toMatch(/^\/login/);
  });

  it("only shows screenshots that exist", () => {
    const images = [HERO_SHOT.wide, HERO_SHOT.narrow, ...DEMOS.map((d) => d.image), ...FEATURES.flatMap((f) => (f.image ? [f.image] : []))];
    for (const i of images) {
      expect(existsSync(join(PUBLIC, i.src)), i.src).toBe(true);
      expect(i.alt.length).toBeGreaterThan(30);
    }
  });

  it("labels features honestly", () => {
    expect(STATUS_LABEL.planned).toBe("Coming soon");
    // Previews and betas say what limits them.
    for (const f of FEATURES.filter((x) => x.status !== "available")) expect(f.limits.length, f.slug).toBeGreaterThan(0);
    expect(FEATURES.find((f) => f.slug === "autonomous-developer")?.status).toBe("preview");
  });

  it("takes prices and allowances from the enforced plan settings", () => {
    for (const id of ["free", "pro", "max"] as const) {
      expect(PRICING[id].price).toBe(PLANS[id].priceUsd);
      expect(PRICING[id].window).toBe(PLANS[id].windowUnits);
      expect(PRICING[id].weekly).toBe(PLANS[id].weeklyUnits);
      expect(PRICING[id].code).toContain(PLANS[id].workspaceMinutesPerPeriod.toLocaleString("en-US"));
    }
    expect(FAQ.find((f) => f.q === "Is Orbis free?")?.a).toContain(`$${PLANS.pro.priceUsd}/month`);
  });
});

describe("legal pages", () => {
  it("link only to real pages and name the contact address", async () => {
    const { PRIVACY, TERMS, COOKIES, LEGAL } = await import("@/content/legal");
    const known = new Set([...pages, "/privacy", "/terms", "/cookies"]);
    for (const doc of [PRIVACY, TERMS, COOKIES]) {
      const text = JSON.stringify(doc);
      for (const m of text.matchAll(/\]\((\/[^)]*)\)/g)) expect(known.has(m[1]!), m[1]).toBe(true);
      expect(text).toContain(LEGAL.email);
      expect(new Set(doc.map((s) => s.id)).size).toBe(doc.length);
    }
  });

  it("list every cookie Orbis sets in the Cookie Policy", async () => {
    const { COOKIES } = await import("@/content/legal");
    const { ACCEPTED_COOKIE, PENDING_COOKIE } = await import("@/lib/legal");
    const { GUEST_COOKIE } = await import("@/lib/engine");
    const policy = JSON.stringify(COOKIES);
    for (const name of [ACCEPTED_COOKIE, PENDING_COOKIE, GUEST_COOKIE, "orbis_connect", "sb-"]) expect(policy, name).toContain(name);
  });

  it("state the minimum age and disclose the AI providers and where data is stored", async () => {
    const { PRIVACY, TERMS, LEGAL } = await import("@/content/legal");
    expect(LEGAL.minimumAge).toBe(13);
    const privacy = JSON.stringify(PRIVACY);
    for (const word of ["Anthropic", "OpenAI", "Supabase", "Vercel", "United States", "Information Commissioner", "13"]) expect(privacy, word).toContain(word);
    expect(JSON.stringify(TERMS)).toContain("England and Wales");
  });

  it("are in the sitemap", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const urls = sitemap().map((e) => new URL(e.url).pathname);
    expect(urls).toEqual(expect.arrayContaining(["/privacy", "/terms"]));
  });
});

describe("homepage content", () => {
  it("shows the real run's logged steps, each once and in order", async () => {
    const { RUN_STAGES } = await import("@/content/landing");
    const logged = DEMOS.find((d) => d.id === "code")!.steps!.map((st) => st.text);
    expect(RUN_STAGES.flatMap((st) => st.steps)).toEqual(logged);
    expect(RUN_STAGES.map((st) => st.id)).toEqual(["prompt", "work", "launch", "inspect", "report"]);
    // The browser check is labelled as an inspection, never as a test result.
    expect(RUN_STAGES.find((st) => st.id === "inspect")!.kind).toMatch(/not a test/i);
  });

  it("links use cases and proof to real pages, real screenshots and real website ideas", async () => {
    const { USE_CASES, PROOF_SHOTS } = await import("@/content/landing");
    const { siteExample } = await import("@/lib/code/site-examples");
    for (const u of USE_CASES) {
      if (u.idea) expect(siteExample(u.idea), u.idea).toBeDefined();
      else expect(pages.has(u.href!), u.href).toBe(true);
    }
    for (const p of PROOF_SHOTS) {
      expect(existsSync(join(PUBLIC, p.image.src)), p.image.src).toBe(true);
      expect(pages.has(p.href), p.href).toBe(true);
    }
  });

  it("starts building after sign-up, with an example request only by id", async () => {
    const { buildHref, BUILD_HREF } = await import("@/components/marketing/links");
    const { afterSignIn } = await import("@/lib/auth-flow");
    expect(BUILD_HREF).toBe("/login?mode=signup&next=%2Fcode");
    const next = new URLSearchParams(buildHref("saas").split("?")[1]).get("next");
    expect(afterSignIn(next)).toBe("/code?idea=saas");
    const { siteExample } = await import("@/lib/code/site-examples");
    expect(siteExample("saas")?.prompt).toMatch(/landing page/);
    expect(siteExample("<script>")).toBeUndefined();
    expect(siteExample(null)).toBeUndefined();
  });

  it("doesn't claim what isn't true about billing and limits", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(marketing)/page.tsx"), "utf8");
    expect(page).not.toMatch(/rolling week/);
    expect(page).not.toMatch(/Nothing is charged automatically and/);
    expect(page).toMatch(/automatic top-ups/);
  });

  it("takes plan figures from the enforced settings", async () => {
    const { PLAN_LIMITS } = await import("@/content/landing");
    const { chargeUsd } = await import("@/lib/plans");
    for (const p of PLAN_LIMITS) {
      expect(p.price).toBe(PLANS[p.id].priceUsd);
      expect(p.yearly).toBe(p.price ? chargeUsd(PLANS[p.id], "year") : 0);
      expect(p.lines[0]).toContain(PLANS[p.id].windowUnits.toLocaleString("en-US"));
    }
  });
});
