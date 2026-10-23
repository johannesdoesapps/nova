/**
 * The browser check of a running website, and how its findings are worded.
 * The script runs inside the project's computer (node + headless Chromium
 * from npm); everything else here is pure, so it's shared with tests and
 * the page.
 */

/** The browser and its driver, pinned (installed from npm into a folder outside the project). */
export const CHECK_TOOLS = ["@sparticuz/chromium@131.0.1", "puppeteer-core@23.11.1"];

export interface CheckViewport {
  name: "desktop" | "tablet" | "phone";
  width: number;
  height: number;
  status: number | null;
  title: string;
  consoleErrors: string[];
  pageErrors: string[];
  /** Local requests that failed or answered 4xx/5xx. */
  failedRequests: string[];
  /** Requests to other sites (the computer can't reach them; visitors' browsers will). */
  external: string[];
  /** How far the page scrolls sideways at this width (px). */
  overflowX: number;
  /** Elements wider than the screen. */
  wide: string[];
  page: {
    headings: string[];
    nav: string[];
    buttons: string[];
    images: number;
    imagesWithoutAlt: number;
    brokenImages: string[];
    brokenAnchors: string[];
    placeholders: string[];
    forms: { fields: string[]; action: string; validates: boolean }[];
    height: number;
    textLength: number;
    viewportMeta: boolean;
    lang: string | null;
  } | null;
  menu?: { found: boolean; label?: string; expandedBefore?: string | null; expandedAfter?: string | null; visibleLinksBefore?: number; visibleLinksAfter?: number; error?: string };
}

export interface CheckShot {
  name: "desktop" | "overview" | "phone";
  /** JPEG, base64. */
  data: string;
  caption: string;
}

export interface PreviewCheckRaw {
  url: string;
  viewports: CheckViewport[];
  links: { href: string; status: number }[];
  shots?: CheckShot[];
  error: string | null;
}

export interface PreviewCheck {
  path: string;
  verdict: "passed" | "problems" | "failed";
  /** Problems that make the check fail. */
  problems: string[];
  /** Worth fixing, not failures. */
  warnings: string[];
  /** The full report, as the agent reads it. */
  text: string;
  /** The sizes it was opened at, e.g. "desktop 1280px". */
  sizes: string[];
  shots: CheckShot[];
  checkedAt: string;
}

const unique = (xs: string[]) => [...new Set(xs)];

/** Judge a check's raw findings: what fails it, what's only a warning, and the report text. */
export function summarizeCheck(raw: PreviewCheckRaw, now = new Date()): PreviewCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const sizes = raw.viewports.map((v) => `${v.name} ${v.width}px`);
  const lines: string[] = [`Browser check of ${raw.url} (headless Chromium in the project's computer, at ${sizes.length ? sizes.join(", ") : "desktop, tablet and phone sizes"}):`];
  if (raw.error || !raw.viewports.length) {
    const why = raw.error ?? "no results";
    return {
      path: raw.url,
      verdict: "failed",
      problems: [`The check couldn't run: ${why}`],
      warnings: [],
      text: `${lines[0]}\nThe check couldn't run: ${why}`,
      sizes: [],
      shots: [],
      checkedAt: now.toISOString(),
    };
  }
  for (const v of raw.viewports) {
    const label = `${v.name === "desktop" ? "Desktop" : v.name === "tablet" ? "Tablet" : "Phone"} ${v.width}×${v.height}`;
    const p = v.page;
    if (!v.status || v.status >= 400) problems.push(`${label}: the page answered ${v.status ? `HTTP ${v.status}` : "nothing"}.`);
    lines.push(`${label}: ${v.status ? `HTTP ${v.status}` : "no answer"}, title "${v.title || "(none)"}"${p ? `, page ${p.height.toLocaleString("en-US")}px tall` : ""}.`);
    if (p && v.name === "desktop") {
      if (p.headings.length) lines.push(`  Headings: ${p.headings.join(" · ")}`);
      if (p.nav.length) lines.push(`  Navigation links: ${p.nav.join(" · ")}`);
      if (p.buttons.length) lines.push(`  Buttons: ${p.buttons.join(" · ")}`);
      if (p.forms.length) {
        lines.push(
          `  Forms: ${p.forms
            .map(
              (f) =>
                `[${f.fields.join(", ")}] ${f.validates ? "validates input" : "no validation"}, ${f.action ? `sends to ${f.action}` : "no action (submissions aren't sent anywhere unless a script handles them)"}`,
            )
            .join("; ")}`,
        );
      }
      if (p.textLength < 40) problems.push("The page shows almost no text.");
      if (!p.viewportMeta) warnings.push('No <meta name="viewport"> tag, so phones show a zoomed-out page.');
      if (!p.lang) warnings.push("The <html> element has no lang attribute.");
    }
    if (p) {
      if (v.overflowX > 4) problems.push(`${label}: the page scrolls sideways by ${v.overflowX}px${v.wide.length ? ` (too wide: ${v.wide.join(", ")})` : ""}.`);
      else lines.push(`  No sideways scrolling at ${v.width}px.`);
    }
    for (const e of v.pageErrors) problems.push(`${label}: JavaScript error: ${e}`);
    for (const e of v.consoleErrors) problems.push(`${label}: console error: ${e}`);
    for (const r of v.failedRequests) problems.push(`${label}: failed to load: ${r}`);
    if (v.menu) {
      const m = v.menu;
      if (m.error) warnings.push(`Phone menu check failed: ${m.error}`);
      else if (!m.found) {
        if ((p?.nav.length ?? 0) === 0 && (raw.viewports[0]?.page?.nav.length ?? 0) > 3) warnings.push("On a phone the navigation links are hidden and there's no menu button to reach them.");
      } else {
        const opened = (m.visibleLinksAfter ?? 0) > (m.visibleLinksBefore ?? 0) || (m.expandedBefore !== m.expandedAfter && m.expandedAfter === "true");
        lines.push(`  Menu button "${m.label || "(no label)"}": ${opened ? `opens (visible links ${m.visibleLinksBefore} → ${m.visibleLinksAfter})` : "pressing it changed nothing visible"}.`);
        if (!opened) problems.push(`Phone: pressing the menu button "${m.label || "(no label)"}" doesn't show the navigation.`);
        if (!m.label) warnings.push("The phone menu button has no accessible label (aria-label).");
      }
    }
  }
  const first = raw.viewports[0]?.page;
  if (first) {
    for (const a of first.brokenAnchors) problems.push(`A link points to ${a}, but nothing on the page has that id.`);
    for (const i of first.brokenImages) problems.push(`Image doesn't load: ${i}`);
    if (first.placeholders.length) warnings.push(`Links that go nowhere (href="#" or none): ${unique(first.placeholders).join(", ")}.`);
    if (first.imagesWithoutAlt) warnings.push(`${first.imagesWithoutAlt} image${first.imagesWithoutAlt === 1 ? "" : "s"} without alt text.`);
  }
  for (const l of raw.links) if (l.status === 0 || l.status >= 400) problems.push(`Link to a page that doesn't load: ${l.href} (${l.status ? `HTTP ${l.status}` : "no answer"}).`);
  if (raw.links.length) lines.push(`Pages linked from here: ${raw.links.map((l) => `${l.href} (${l.status || "no answer"})`).join(", ")}.`);
  const external = unique(raw.viewports.flatMap((v) => v.external));
  if (external.length) {
    const hosts = unique(external.map((u) => u.replace(/^https?:\/\//, "").split("/")[0]!)).slice(0, 6);
    lines.push(
      `Not checked: ${external.length} request${external.length === 1 ? "" : "s"} to other sites (${hosts.join(", ")}). The project's computer can only reach npm and PyPI; visitors' browsers will load them.`,
    );
  }
  const p2 = unique(problems);
  const w2 = unique(warnings);
  lines.push(p2.length ? `Problems (${p2.length}):\n${p2.map((x) => `- ${x}`).join("\n")}` : "Problems: none found.");
  if (w2.length) lines.push(`Worth fixing:\n${w2.map((x) => `- ${x}`).join("\n")}`);
  const shots = raw.shots ?? [];
  if (shots.length) lines.push(`Screenshots: ${shots.map((s) => s.caption).join("; ")}.`);
  return { path: raw.url, verdict: p2.length ? "problems" : "passed", problems: p2, warnings: w2, text: lines.join("\n"), sizes, shots, checkedAt: now.toISOString() };
}

/**
 * The script, run with node inside the computer:
 *   node check.mjs <base url> <path> <tools node_modules dir>
 * It prints one JSON object (PreviewCheckRaw).
 */
export const CHECK_SCRIPT = String.raw`import { createRequire } from "node:module";
const [base = "http://127.0.0.1:3000", path = "/", tools = "/tmp/orbis-tools/node_modules/"] = process.argv.slice(2);
const require = createRequire(tools);
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const target = new URL(path, base).href;
const origin = new URL(base).origin;
const local = (u) => u.startsWith(origin) || u.startsWith("data:") || u.startsWith("blob:");
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800, scale: 0.5 },
  { name: "tablet", width: 768, height: 1024, scale: 0.5, mobile: true },
  { name: "phone", width: 390, height: 844, scale: 0.6, mobile: true },
];
const MAX_SHOT = 45000;
const out = { url: path, viewports: [], links: [], shots: [], error: null };
let browser;

async function shoot(page, name, caption, opts) {
  for (const q of [55, 40, 28, 18]) {
    const b64 = await page.screenshot({ type: "jpeg", quality: q, encoding: "base64", ...opts });
    if (b64.length <= MAX_SHOT) return out.shots.push({ name, data: b64, caption });
  }
}

try {
  browser = await puppeteer.launch({ args: chromium.args, executablePath: process.env.ORBIS_CHROME || (await chromium.executablePath()), headless: true });
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, isMobile: !!vp.mobile, hasTouch: !!vp.mobile });
    const r = { name: vp.name, width: vp.width, height: vp.height, status: null, title: "", consoleErrors: [], pageErrors: [], failedRequests: [], external: [], overflowX: 0, wide: [], page: null };
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const at = m.location()?.url || "";
      // Failed loads are reported once, as requests.
      if (/^Failed to load resource/.test(m.text())) return;
      if (at && !local(at)) return;
      if (r.consoleErrors.length < 12) r.consoleErrors.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (e) => r.pageErrors.length < 12 && r.pageErrors.push(String(e.message).slice(0, 300)));
    page.on("requestfailed", (q) => {
      const u = q.url();
      if (!local(u)) return void (r.external.length < 20 && r.external.push(u.slice(0, 160)));
      if (r.failedRequests.length < 15) r.failedRequests.push((q.failure()?.errorText ?? "failed") + " " + u.replace(origin, "").slice(0, 160));
    });
    page.on("response", (s) => {
      const u = s.url();
      if (s.status() < 400 || !local(u) || /\/favicon\.ico$/.test(u)) return;
      if (r.failedRequests.length < 15) r.failedRequests.push(s.status() + " " + u.replace(origin, "").slice(0, 160));
    });
    try {
      const resp = await page.goto(target, { waitUntil: "networkidle2", timeout: 25000 });
      r.status = resp?.status() ?? null;
    } catch (e) {
      r.pageErrors.push("The page didn't finish loading: " + String(e.message).slice(0, 200));
    }
    await new Promise((res) => setTimeout(res, 700));
    r.title = await page.title().catch(() => "");
    r.page = await page
      .evaluate((W) => {
        const vis = (el) => {
          const s = getComputedStyle(el);
          const b = el.getBoundingClientRect();
          return s.display !== "none" && s.visibility !== "hidden" && b.width > 0 && b.height > 0;
        };
        const txt = (el) => (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 60);
        const doc = document.documentElement;
        const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
        const wide = [...document.body.querySelectorAll("*")]
          .filter((el) => el.getBoundingClientRect().right > W + 2 && vis(el) && getComputedStyle(el).position !== "fixed")
          .filter((el, _, all) => !all.some((o) => o !== el && o.contains(el)))
          .slice(0, 5)
          .map(name);
        const anchors = [...new Set([...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute("href")).filter((h) => h.length > 1))];
        const brokenAnchors = anchors.filter((h) => {
          try {
            return !document.getElementById(decodeURIComponent(h.slice(1)));
          } catch {
            return true;
          }
        });
        const placeholders = [...document.querySelectorAll("a")]
          .filter((a) => {
            const h = a.getAttribute("href");
            return (h === null && !a.getAttribute("role")) || h === "#" || h === "" || /^javascript:/i.test(h || "");
          })
          .filter(vis)
          .map(txt)
          .slice(0, 10);
        const forms = [...document.querySelectorAll("form")].map((f) => ({
          fields: [...f.elements].filter((e) => e.name || e.id).map((e) => e.tagName.toLowerCase() + (e.type ? ":" + e.type : "") + (e.required ? "*" : "")).slice(0, 12),
          action: f.getAttribute("action") || "",
          validates: [...f.elements].some((e) => e.required || e.pattern || e.type === "email" || e.minLength > 0),
        }));
        return {
          headings: [...document.querySelectorAll("h1,h2,h3")].filter(vis).slice(0, 30).map((h) => h.tagName.toLowerCase() + ": " + txt(h)),
          nav: [...document.querySelectorAll("nav a, header a")].filter(vis).slice(0, 15).map(txt),
          buttons: [...document.querySelectorAll("button, [role=button]")].filter(vis).slice(0, 20).map(txt),
          images: document.images.length,
          imagesWithoutAlt: [...document.images].filter((i) => !i.hasAttribute("alt")).length,
          brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.src && i.src.startsWith(location.origin)).map((i) => i.src.replace(location.origin, "").slice(0, 120)).slice(0, 10),
          brokenAnchors,
          placeholders,
          local: [...new Set([...document.querySelectorAll("a[href]")].map((a) => a.href.split("#")[0]).filter((h) => h.startsWith(location.origin) && h !== location.href.split("#")[0]))].slice(0, 20),
          forms,
          overflowX: Math.max(0, doc.scrollWidth - W),
          wide,
          height: doc.scrollHeight,
          lang: doc.lang || null,
          viewportMeta: !!document.querySelector('meta[name="viewport"]'),
          textLength: document.body.innerText.length,
        };
      }, vp.width)
      .catch((e) => null);
    if (r.page) {
      r.overflowX = r.page.overflowX;
      r.wide = r.page.overflowX > 4 ? r.page.wide : [];
      if (vp.name === "desktop") out.local = r.page.local;
      delete r.page.overflowX;
      delete r.page.wide;
      delete r.page.local;
    }
    try {
      if (vp.name === "desktop") {
        await shoot(page, "desktop", "desktop, first screen (1280px wide)", {});
        if ((r.page?.height ?? 0) > vp.height + 200) {
          await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 0.25 });
          await shoot(page, "overview", "desktop, whole page (scaled down)", { fullPage: (r.page?.height ?? 0) <= 14000 });
        }
      } else if (vp.name === "phone") {
        await shoot(page, "phone", "phone, first screen (390px wide)", {});
      }
    } catch (e) {
      r.pageErrors.push("Screenshot failed: " + String(e.message).slice(0, 120));
    }
    // A phone menu: a visible button that controls something or reports aria-expanded. Press it and see whether links appear.
    if (vp.name === "phone") {
      r.menu = await page
        .evaluate(async () => {
          const shown = (el) => {
            const s = getComputedStyle(el);
            const b = el.getBoundingClientRect();
            return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0" && b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight;
          };
          const btn = [...document.querySelectorAll("button[aria-controls], button[aria-expanded], [data-menu-toggle], .menu-toggle, .nav-toggle, .hamburger, .menu-button")].find(shown);
          if (!btn) return { found: false };
          const links = () => [...document.querySelectorAll("nav a, header a, [role=dialog] a")].filter(shown).length;
          const before = links();
          const expandedBefore = btn.getAttribute("aria-expanded");
          btn.click();
          await new Promise((res) => setTimeout(res, 600));
          return { found: true, label: (btn.getAttribute("aria-label") || btn.innerText || "").trim().slice(0, 40), expandedBefore, expandedAfter: btn.getAttribute("aria-expanded"), visibleLinksBefore: before, visibleLinksAfter: links() };
        })
        .catch((e) => ({ found: false, error: String(e.message).slice(0, 200) }));
    }
    out.viewports.push(r);
    await page.close();
  }
  for (const href of (out.local || []).slice(0, 20)) {
    try {
      const s = await fetch(href, { redirect: "follow" });
      out.links.push({ href: new URL(href).pathname, status: s.status });
    } catch {
      out.links.push({ href: new URL(href).pathname, status: 0 });
    }
  }
  delete out.local;
} catch (e) {
  out.error = String((e && e.message) || e).slice(0, 500);
} finally {
  await browser?.close().catch(() => {});
}
process.stdout.write(JSON.stringify(out));
`;
