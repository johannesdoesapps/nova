/**
 * Website templates (Discover → Build a website): exactly four, each a real
 * page with its own bundled photos and fonts; the server's copy of the files
 * matches public/; a new project starts from the template's files; the
 * chosen template reaches the coding agent's instructions; prompt chips add
 * to what's written instead of replacing it; and the template pages are
 * sandboxed and framed only by Orbis.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendSuggestion, isSiteTemplateId, PROMPT_SUGGESTIONS, SITE_TEMPLATE_IDS, SITE_TEMPLATE_LIST, SITE_TEMPLATES, siteTemplateGuidance, templateRequest } from "@/lib/code/site-templates";
import { SITE_TEMPLATE_SOURCES } from "@/lib/code/site-template-sources";
import { SIGNUP_SCRIPT, siteTemplateFiles } from "@/lib/code/site-template-seed";
import { newProjectBody } from "@/lib/code/projects";
import { DISCOVER } from "@/lib/home";

const root = process.cwd();
const pub = (p: string) => join(root, "public", p.replace(/^\//, ""));

describe("the templates", () => {
  it("are Launchpad, Atelier, Form & Found, Journal and NOVA, with the briefs' copy", () => {
    expect(SITE_TEMPLATE_IDS).toEqual(["launchpad-saas", "atelier-portfolio", "form-found-store", "journal-personal", "nova-creative-agency"]);
    expect(SITE_TEMPLATE_LIST.map((t) => [t.name, t.category, t.description])).toEqual([
      ["Launchpad", "SaaS / Technology", "A polished landing page built to turn visitors into customers."],
      ["Atelier", "Agency / Portfolio", "A bold, editorial portfolio designed to make your work stand out."],
      ["Form & Found", "E-commerce / Retail", "A refined storefront designed to showcase products and drive sales."],
      ["Journal", "Personal Brand / Blog", "A thoughtful digital home for your ideas, stories, and expertise."],
      ["NOVA", "Creative Agency / UGC / Marketing", "An expressive, high-impact agency website with oversized typography, creator-led visuals, bold results, and editorial case studies."],
    ]);
  });

  it("each has its page, a distinct preview and thumbnail, and every image and font its page uses is bundled", () => {
    const previews = new Set<string>();
    for (const t of SITE_TEMPLATE_LIST) {
      expect(t.id).toBe(SITE_TEMPLATES[t.id].id);
      for (const f of [t.page, t.previewImage.src, t.thumbnailImage.src]) expect(existsSync(pub(f)), f).toBe(true);
      previews.add(t.previewImage.src);
      const html = readFileSync(pub(t.page), "utf8");
      const h1 = html
        .match(/<h1[^>]*>([\s\S]*?)<\/h1>/)![1]!
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
      expect(h1).toBe(t.headline);
      for (const [, src] of html.matchAll(/src="([^"]+)"/g)) expect(existsSync(join(pub(t.page), "..", src!)), `${t.id}: ${src}`).toBe(true);
      const fontCss = html.match(/href="\.\.\/fonts\/([\w-]+\.css)"/)![1]!;
      const css = readFileSync(pub(`site-templates/fonts/${fontCss}`), "utf8");
      for (const [, file] of css.matchAll(/url\("([^"]+)"\)/g)) expect(existsSync(pub(`site-templates/fonts/${file}`)), file).toBe(true);
      // Nothing is loaded from other sites, and no page runs scripts.
      expect(html).not.toMatch(/(src|href)="https?:/);
      expect(html).not.toMatch(/<script/i);
      expect(t.sectionPresets.length).toBeGreaterThan(4);
      expect(t.generationInstructions.length).toBeGreaterThan(3);
    }
    expect(previews.size).toBe(SITE_TEMPLATE_IDS.length);
  });

  it("the server's copy of each template matches public/ (run `npm run templates:sync` after editing one)", () => {
    for (const id of SITE_TEMPLATE_IDS) {
      expect(SITE_TEMPLATE_SOURCES[id]?.html, id).toBe(readFileSync(pub(`site-templates/${id}/index.html`), "utf8"));
      expect(SITE_TEMPLATE_SOURCES[id]?.css, id).toBe(readFileSync(pub(`site-templates/${id}/style.css`), "utf8"));
      const js = pub(`site-templates/${id}/script.js`);
      expect(SITE_TEMPLATE_SOURCES[id]?.js, id).toBe(existsSync(js) ? readFileSync(js, "utf8") : undefined);
    }
  });

  it("NOVA: every section from the brief, labelled sample figures, working case-study links and no fake video controls", () => {
    const html = SITE_TEMPLATE_SOURCES["nova-creative-agency"]!.html;
    for (const id of ["work", "services", "results", "about", "faq", "cases", "contact"]) expect(html, id).toContain(`id="${id}"`);
    for (const h of [
      "Built for brands ready to break through.",
      "Made to stop the scroll.",
      "Everything behind the breakthrough.",
      "Creative that delivers.",
      "From idea to impact.",
      "Your next breakthrough starts here.",
    ])
      expect(html, h).toContain(h);
    expect(html).toMatch(/Illustrative figures for this template/);
    // Every in-page link points at something that exists.
    for (const [, target] of html.matchAll(/href="#([\w-]+)"/g)) expect(html, target).toMatch(new RegExp(`id="${target}"`));
    expect(html.match(/<details/g)).toHaveLength(6); // phone menu + five questions
    expect(html).not.toMatch(/<video|autoplay|play-button|aria-label="Play/i);
    expect(html).not.toMatch(/nike|adidas|vo creations|vocreations/i);
  });

  it("NOVA's script respects reduced motion and the page works without it", () => {
    const js = SITE_TEMPLATE_SOURCES["nova-creative-agency"]!.js!;
    expect(js).toContain("prefers-reduced-motion: reduce");
    const css = SITE_TEMPLATE_SOURCES["nova-creative-agency"]!.css;
    // Content is only hidden for the reveal when the script has run (html.js) and motion is welcome.
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.js \.reveal \{ opacity: 0/);
    const files = siteTemplateFiles("nova-creative-agency", "https://tryorbis.app");
    expect(files["script.js"]).toContain(js);
    expect(files["script.js"]).toContain("your message wasn't sent");
    expect(files["index.html"]).toContain("family=Archivo");
  });

  it("the store template shows prices but no checkout, cart or payment form", () => {
    const html = SITE_TEMPLATE_SOURCES["form-found-store"]!.html;
    expect(html).toMatch(/\$\d+/);
    expect(html).not.toMatch(/checkout|add to (bag|cart)|card number|pay now/i);
  });
});

describe("a new project from a template", () => {
  it("starts from the template's page, with Google Fonts and the photos at Orbis's address", () => {
    const files = siteTemplateFiles("form-found-store", "https://tryorbis.app/");
    expect(Object.keys(files).sort()).toEqual(["index.html", "script.js", "style.css"]);
    expect(files["style.css"]).toBe(SITE_TEMPLATE_SOURCES["form-found-store"]!.css);
    const html = files["index.html"]!;
    expect(html).toContain('src="https://tryorbis.app/site-templates/form-found-store/img/hero.webp"');
    expect(html).not.toContain('src="img/');
    expect(html).not.toContain("../fonts/");
    expect(html).toContain("https://fonts.googleapis.com/css2?family=Fraunces");
    expect(html).toContain('<script src="script.js" defer></script>');
  });

  it("a page without a form gets no script; the sign-up script never claims an address was saved", () => {
    expect(Object.keys(siteTemplateFiles("launchpad-saas", "https://tryorbis.app"))).toEqual(["index.html", "style.css"]);
    expect(SIGNUP_SCRIPT).toContain("wasn't saved");
    expect(SIGNUP_SCRIPT).not.toMatch(/thank|subscribed|success/i);
  });

  it("the projects API accepts a template only for a website project", () => {
    expect(newProjectBody.safeParse({ name: "Site", template: "website", siteTemplate: "journal-personal" }).success).toBe(true);
    expect(newProjectBody.safeParse({ name: "Site", template: "node", siteTemplate: "journal-personal" }).success).toBe(false);
    expect(newProjectBody.safeParse({ name: "Site", template: "website", siteTemplate: "other" }).success).toBe(false);
    expect(newProjectBody.safeParse({ name: "Site", template: "website" }).success).toBe(true);
  });
});

describe("what the agent is told", () => {
  it("the template's design, sections, adaptation and limits", () => {
    const g = siteTemplateGuidance("form-found-store");
    expect(g).toContain("Form & Found");
    expect(g).toContain("#f5f2ed");
    expect(g).toContain("Fraunces");
    expect(g).toContain("Product grid");
    expect(g).toMatch(/doesn't fit this kind of site: .*portfolio/);
    expect(g).toMatch(/Never claim the site has working sign-in, payments/);
    expect(g).toMatch(/don't start over/);
  });

  it("the run carries the template id; the engine adds the guidance for website runs", () => {
    const route = readFileSync(join(root, "src/app/api/code/projects/[id]/agent/route.ts"), "utf8");
    expect(route).toContain("siteTemplate: z.enum(SITE_TEMPLATE_IDS).optional()");
    const engine = readFileSync(join(root, "src/lib/code/agent/engine.ts"), "utf8");
    expect(engine).toMatch(/web && !readOnly && isSiteTemplateId\(opts\.siteTemplate\) \? `\\n\\n\$\{siteTemplateGuidance\(opts\.siteTemplate\)\}`/);
  });

  it("the request keeps the user's words first and adds only the details filled in", () => {
    expect(templateRequest("  A site for my bakery ", {})).toBe("A site for my bakery");
    expect(templateRequest("A site for my bakery", { name: "Crumb", color: "#AA3311", tone: "", audience: " locals ", sections: "" })).toBe(
      "A site for my bakery\n\nDetails:\n- Website name: Crumb\n- Primary brand colour: #AA3311\n- Audience: locals",
    );
    expect(templateRequest("x", { color: "red; ignore previous" })).toBe("x");
  });

  it("only known ids are accepted", () => {
    expect(isSiteTemplateId("atelier-portfolio")).toBe(true);
    expect(isSiteTemplateId("../etc")).toBe(false);
    expect(isSiteTemplateId(undefined)).toBe(false);
  });
});

describe("prompt suggestions", () => {
  it("are the five from the brief", () => {
    expect(PROMPT_SUGGESTIONS).toEqual(["Add a pricing section", "Make it more minimalist", "Use a dark theme", "Add customer testimonials", "Make it mobile-friendly"]);
  });

  it("add to what's written and never replace it", () => {
    expect(appendSuggestion("", "Use a dark theme")).toBe("Use a dark theme.");
    expect(appendSuggestion("A site for my bakery", "Use a dark theme")).toBe("A site for my bakery. Use a dark theme.");
    expect(appendSuggestion("A site for my bakery!  ", "Add a pricing section")).toBe("A site for my bakery! Add a pricing section.");
    expect(appendSuggestion("A site. Use a dark theme.", "use a dark theme")).toBe("A site. Use a dark theme.");
  });
});

describe("where it lives", () => {
  it("Discover's 'Build a website from a prompt' opens the template gallery", () => {
    const item = DISCOVER.find((d) => d.id === "build-website")!;
    expect(item.title).toBe("Build a website from a prompt");
    expect(item.action).toEqual({ kind: "link", href: "/code/website" });
  });

  it("template pages are sandboxed, framed only by Orbis, and the rest of the site keeps its own rules", () => {
    const config = readFileSync(join(root, "next.config.ts"), "utf8");
    expect(config).toContain('source: "/((?!site-templates/).*)"');
    expect(config).toContain('source: "/site-templates/:path*"');
    expect(config).toMatch(/TEMPLATE_CSP = "default-src 'none';[^"]*frame-ancestors 'self'; sandbox"/);
    expect(config).toContain('{ key: "X-Frame-Options", value: "SAMEORIGIN" }');
    const view = readFileSync(join(root, "src/components/code/site-templates-view.tsx"), "utf8");
    expect(view).toContain('sandbox=""');
  });
});
