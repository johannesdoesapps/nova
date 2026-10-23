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
