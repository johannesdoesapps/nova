/**
 * Example website requests. Each fills Code's prompt box with a real request
 * to edit or send; the public site links to them by id (never by free text
 * from the URL), so a visitor can start from one straight after signing up.
 */

export const SITE_EXAMPLES: { id: string; label: string; prompt: string }[] = [
  {
    id: "saas",
    label: "Premium SaaS landing page",
    prompt:
      "Build a premium SaaS landing page for an AI note-taking app called Lumen: a sticky navigation bar, a bold hero with a call to action, feature cards, three pricing plans, testimonials (clearly labelled sample content), an FAQ and a footer. Dark theme, responsive on mobile and desktop.",
  },
  {
    id: "portfolio",
    label: "Designer portfolio",
    prompt:
      "Create an online portfolio for a product designer: an intro, a grid of six case studies with short descriptions, an about section, and a contact form that validates email addresses. Minimal, light, elegant typography.",
  },
  {
    id: "store",
    label: "E-commerce storefront",
    prompt:
      "Build an e-commerce storefront for a small coffee roaster: a product grid with filters, product cards with prices (sample data), a cart drawer that adds and removes items, and a checkout button that explains payments aren't connected yet.",
  },
  {
    id: "restaurant",
    label: "Restaurant with reservations",
    prompt:
      "Create a restaurant website for a modern Italian trattoria: hero, menu with sections and prices (sample data), opening hours, location, and a reservation inquiry form with date, time, party size and validation.",
  },
  {
    id: "dashboard",
    label: "Dashboard with charts",
    prompt:
      "Build a dashboard for a small online shop with a responsive sidebar that collapses on phones, summary cards, a sales line chart and a category bar chart (sample data, drawn with SVG or canvas), and a recent orders table.",
  },
];

/** The example with this id, or undefined. */
export function siteExample(id: string | null | undefined) {
  return id ? SITE_EXAMPLES.find((x) => x.id === id) : undefined;
}

/** Optional details for a website request; each is free text and may be empty. */
export interface SiteDetails {
  purpose: string;
  audience: string;
  style: string;
  sections: string;
}

export const SITE_DETAIL_FIELDS: { key: keyof SiteDetails; label: string; placeholder: string }[] = [
  { key: "purpose", label: "Purpose", placeholder: "e.g. get bookings for a yoga studio" },
  { key: "audience", label: "Who it's for", placeholder: "e.g. busy professionals nearby" },
  { key: "style", label: "Look and feel", placeholder: "e.g. calm, light, lots of white space" },
  { key: "sections", label: "Key sections", placeholder: "e.g. classes, prices, teachers, contact" },
];

/** The request with the details that were filled in, as plain lines the agent reads with it. Nothing is added when none were. */
export function withSiteDetails(request: string, d: Partial<SiteDetails>): string {
  const lines = SITE_DETAIL_FIELDS.map((f) => [f.label, (d[f.key] ?? "").trim().replace(/\s+/g, " ").slice(0, 300)] as const).filter(([, v]) => v);
  if (!lines.length) return request.trim();
  return `${request.trim()}\n\nDetails:\n${lines.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`;
}

/** A short project name from a website request. */
export function siteName(prompt: string): string {
  const called = prompt.match(/\bcalled\s+["“]?([A-Z][\w&' -]{1,30}?)["”]?(?=[.,;:!?]|\s+(?:with|that|for|and|in)\b|$)/);
  if (called) return `Website: ${called[1]!.trim()}`;
  const words = prompt
    .replace(/^\s*(please\s+)?(build|create|make|design|write)\s+(me\s+)?(an?|the)?\s*/i, "")
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .replace(/[.,;:!?]+$/, "");
  const name = words ? words[0]!.toUpperCase() + words.slice(1) : "New website";
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

/** Example requests that aren't websites, so Code's start screen shows the whole range. */
export const CODE_EXAMPLES: { id: string; label: string; prompt: string }[] = [
  {
    id: "python-photos",
    label: "Python: sort photos by date",
    prompt:
      "Write a Python script that sorts the photos in a folder into subfolders by year and month, using the date the photo was taken (EXIF) and falling back to the file date. Add a --dry-run option that only prints what it would do, and tests for the date logic.",
  },
  {
    id: "node-api",
    label: "Node.js API for a to-do list",
    prompt:
      "Build a small Node.js API for a to-do list with Express: create, list, complete and delete tasks, stored in a JSON file. Validate the input, return clear errors, and add tests for each endpoint.",
  },
  {
    id: "cli-budget",
    label: "Command-line budget tracker",
    prompt:
      "Create a command-line budget tracker in Node.js: add an expense with an amount, category and date, list this month's expenses, and show totals per category. Store the data in a local file and include tests.",
  },
];

const PYTHON = /\b(python|django|flask|fastapi|pandas|numpy|jupyter|pytest|pip|[\w-]+\.py)\b/i;
const NODE = /\b(node(\.?js)?|express|javascript|typescript|npm|discord bot|telegram bot|bot|cli|command[- ]line|terminal|api|rest|server|back-?end|scraper|script)\b/i;
const WEB =
  /\b(web ?sites?|web ?pages?|landing ?page|home ?page|portfolio|storefront|e-?commerce|online store|shop|web ?app|dashboard|html|css|front-?end|navbar|hero|responsive|tailwind|react|vue|svelte|next\.?js|vite|blog|restaurant|game|calculator|quiz|timer|app)\b/i;

/**
 * The kind of project a request needs when Code starts a new one: Python or Node.js when it says so, a website
 * for anything with pages or a visual app, otherwise a blank project the agent sets up itself.
 */
export function projectTypeFor(request: string): "website" | "node" | "python" | "blank" {
  if (PYTHON.test(request)) return "python";
  // "A React dashboard" or "a Node.js API": the more specific words win.
  if (WEB.test(request) && !/\b(api|cli|command[- ]line|bot|scraper)\b/i.test(request)) return "website";
  if (NODE.test(request)) return "node";
  if (WEB.test(request)) return "website";
  return "blank";
}
