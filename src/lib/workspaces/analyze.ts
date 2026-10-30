/**
 * Deterministic analysers for the workspaces — pure functions, no network, no AI, so they run instantly and are
 * easy to test. The AI-backed tools (report drafting, malware explanation, deeper audits) live elsewhere.
 */

// ---------------------------------------------------------------- password strength

export interface PasswordResult {
  score: 0 | 1 | 2 | 3 | 4;
  label: "very weak" | "weak" | "fair" | "strong" | "very strong";
  /** Rough base-2 entropy in bits, from the character set and length. */
  entropyBits: number;
  suggestions: string[];
}

const COMMON = new Set([
  "password", "123456", "123456789", "qwerty", "111111", "12345678", "abc123", "password1", "1234567", "letmein", "welcome", "admin", "iloveyou", "monkey", "dragon", "football", "qwerty123", "000000", "passw0rd",
]);

/** Measure a password's strength locally. The password is never sent anywhere. */
export function passwordStrength(pw: string): PasswordResult {
  const suggestions: string[] = [];
  const len = pw.length;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  let entropyBits = len && pool ? Math.round(len * Math.log2(pool)) : 0;

  const lower = pw.toLowerCase();
  const common = COMMON.has(lower);
  const sequential = /(?:abcdef|qwerty|012345|123456|234567|345678|456789)/i.test(pw);
  const repeated = /(.)\1{3,}/.test(pw);
  if (common || sequential || repeated) entropyBits = Math.min(entropyBits, 20);

  if (len < 12) suggestions.push("Use at least 12 characters — length matters most.");
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) suggestions.push("Mix upper and lower case.");
  if (!/[0-9]/.test(pw)) suggestions.push("Add a number.");
  if (!/[^A-Za-z0-9]/.test(pw)) suggestions.push("Add a symbol.");
  if (common) suggestions.push("This is a very common password — choose something unique.");
  if (sequential) suggestions.push("Avoid keyboard or number sequences.");
  if (repeated) suggestions.push("Avoid repeating the same character.");
  if (!suggestions.length) suggestions.push("Use a password manager to generate and store long, unique passwords.");

  let score: PasswordResult["score"];
  if (!len) score = 0;
  else if (entropyBits < 28) score = 0;
  else if (entropyBits < 40) score = 1;
  else if (entropyBits < 60) score = 2;
  else if (entropyBits < 80) score = 3;
  else score = 4;
  const label = (["very weak", "weak", "fair", "strong", "very strong"] as const)[score];
  return { score, label, entropyBits, suggestions };
}

// ---------------------------------------------------------------- phishing URL signals

export interface UrlSignal {
  level: "info" | "warn" | "danger";
  message: string;
}
export interface UrlResult {
  ok: boolean;
  host: string | null;
  signals: UrlSignal[];
  /** 0 (looks clean) to 100 (many strong signals). A score, not a verdict. */
  risk: number;
}

const SHORTENERS = new Set(["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly"]);
const SENSITIVE_WORDS = ["login", "verify", "secure", "account", "update", "bank", "paypal", "signin", "confirm", "wallet", "password"];

/** Score a URL for phishing signals, from its shape alone (no network request). Guidance, not a definitive verdict. */
export function analyzeUrl(raw: string): UrlResult {
  const signals: UrlSignal[] = [];
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, host: null, signals: [{ level: "warn", message: "That isn't a valid URL. Paste the full address, including https://." }], risk: 0 };
  }
  const host = url.hostname.toLowerCase();
  let risk = 0;
  const add = (level: UrlSignal["level"], message: string, weight: number) => {
    signals.push({ level, message });
    risk += weight;
  };

  if (url.protocol !== "https:") add("warn", "The link doesn't use HTTPS, so the connection isn't encrypted.", 15);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) add("danger", "The address is a raw IP, not a domain name — unusual for a real site.", 30);
  if (url.username || url.password) add("danger", "The link embeds credentials (text before an @), a common trick to disguise the real host.", 35);
  if (host.length > 30 && host.split(".").length > 4) add("warn", "The domain has many sub-parts, which can hide the real owner.", 15);
  if (SHORTENERS.has(host)) add("warn", "This is a link shortener, so the real destination is hidden until you open it.", 15);
  if (/xn--/.test(host)) add("danger", "The domain uses punycode, which can make a fake look like a real brand.", 25);
  if ((host.match(/-/g) || []).length >= 3) add("warn", "The domain has several hyphens, often seen in look-alike domains.", 10);
  const brandish = SENSITIVE_WORDS.filter((w) => host.includes(w));
  if (brandish.length) add("warn", `The domain contains "${brandish[0]}", which scammers add to look official.`, 12);
  const sensitiveInPath = SENSITIVE_WORDS.filter((w) => url.pathname.toLowerCase().includes(w));
  if (sensitiveInPath.length) add("info", `The path mentions "${sensitiveInPath[0]}" — be cautious if you didn't expect this link.`, 5);
  if (/\.(zip|mov|exe|scr|js|apk)(\b|$)/i.test(url.pathname)) add("danger", "The link points at a downloadable file that could be harmful.", 25);
  if (!signals.length) signals.push({ level: "info", message: "No obvious phishing signals in the address. Still check the sender and never enter credentials unless you're sure." });

  return { ok: true, host, signals, risk: Math.min(100, risk) };
}

// ---------------------------------------------------------------- basic SEO checks from HTML

export interface SeoCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

const tag = (html: string, re: RegExp) => (html.match(re)?.[1] ?? "").trim();

/** Check a page's HTML for common on-page SEO basics. For deeper advice, the SEO agent takes it from here. */
export function seoChecks(html: string): { checks: SeoCheck[]; score: number } {
  const checks: SeoCheck[] = [];
  const title = tag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  checks.push(
    !title
      ? { id: "title", label: "Title tag", status: "fail", detail: "No <title> found. Every page needs a unique, descriptive title." }
      : title.length < 15 || title.length > 60
        ? { id: "title", label: "Title tag", status: "warn", detail: `Title is ${title.length} characters; aim for 15–60.` }
        : { id: "title", label: "Title tag", status: "pass", detail: `“${title}”` },
  );
  const desc = tag(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i);
  checks.push(
    !desc
      ? { id: "description", label: "Meta description", status: "fail", detail: "No meta description. Add one of 50–160 characters." }
      : desc.length < 50 || desc.length > 160
        ? { id: "description", label: "Meta description", status: "warn", detail: `Description is ${desc.length} characters; aim for 50–160.` }
        : { id: "description", label: "Meta description", status: "pass", detail: "Present and a good length." },
  );
  const h1s = html.match(/<h1\b/gi)?.length ?? 0;
  checks.push(
    h1s === 0
      ? { id: "h1", label: "Heading (H1)", status: "fail", detail: "No <h1>. Each page should have exactly one main heading." }
      : h1s > 1
        ? { id: "h1", label: "Heading (H1)", status: "warn", detail: `Found ${h1s} <h1> tags; use just one.` }
        : { id: "h1", label: "Heading (H1)", status: "pass", detail: "Exactly one H1." },
  );
  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  const missingAlt = imgs.filter((i) => !/\balt\s*=/i.test(i)).length;
  checks.push(
    imgs.length === 0
      ? { id: "alt", label: "Image alt text", status: "pass", detail: "No images to describe." }
      : missingAlt
        ? { id: "alt", label: "Image alt text", status: "warn", detail: `${missingAlt} of ${imgs.length} images have no alt text.` }
        : { id: "alt", label: "Image alt text", status: "pass", detail: "All images have alt text." },
  );
  checks.push(
    /<meta[^>]+name=["']viewport["']/i.test(html)
      ? { id: "viewport", label: "Mobile viewport", status: "pass", detail: "A viewport meta tag is set." }
      : { id: "viewport", label: "Mobile viewport", status: "fail", detail: "No viewport meta tag — the page won't adapt to phones." },
  );
  checks.push(
    /<meta[^>]+property=["']og:/i.test(html)
      ? { id: "og", label: "Social preview (Open Graph)", status: "pass", detail: "Open Graph tags are present." }
      : { id: "og", label: "Social preview (Open Graph)", status: "warn", detail: "No Open Graph tags, so shared links won't show a rich preview." },
  );
  const pass = checks.filter((c) => c.status === "pass").length;
  return { checks, score: Math.round((pass / checks.length) * 100) };
}
