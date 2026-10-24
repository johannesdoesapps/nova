/**
 * The four website templates offered when building a website from Discover.
 * Each is a real page (public/site-templates/<id>/index.html and style.css, with
 * its photos and fonts bundled beside it) plus the configuration below. The
 * configuration is what the coding agent is told about the chosen template:
 * its design tokens, typography, sections and how to adapt it. The page's
 * files become the new project's starting files (see siteTemplateFiles).
 *
 * Photos are CC0 from StockSnap (public/site-templates/CREDITS.md); fonts are
 * SIL Open Font License. Prices, names and quotes in the templates are
 * sample content: no template includes a checkout, payments, sign-in,
 * a database or email delivery.
 */

export const SITE_TEMPLATE_IDS = ["launchpad-saas", "atelier-portfolio", "form-found-store", "journal-personal"] as const;
export type SiteTemplateId = (typeof SITE_TEMPLATE_IDS)[number];

export function isSiteTemplateId(v: unknown): v is SiteTemplateId {
  return typeof v === "string" && (SITE_TEMPLATE_IDS as readonly string[]).includes(v);
}

export interface SiteImage {
  src: string;
  width: number;
  height: number;
}

export interface SiteTemplate {
  id: SiteTemplateId;
  name: string;
  category: string;
  description: string;
  /** The headline and subheadline the template's page uses. */
  headline: string;
  subheadline: string;
  /** The design in a sentence or two, for people and for the agent. */
  visualDirection: string;
  /** Screenshot of the page's first screen, for the gallery card (1280×1080 page, 960 wide). */
  previewImage: SiteImage;
  /** The same, smaller, for the prompt step's summary. */
  thumbnailImage: SiteImage;
  /** The live page, shown in the preview dialog in a sandboxed frame. */
  page: string;
  designTokens: { colors: Record<string, string>; radius: string; shadow: string; spacing: string };
  defaultColorPalette: { name: string; hex: string }[];
  defaultTypography: { display: string; body: string; scale: string; googleFonts: string };
  layoutPreset: string;
  sectionPresets: { id: string; label: string; purpose: string }[];
  responsiveBehavior: string[];
  /** How the agent should use the template, on top of the user's request. */
  generationInstructions: string[];
  /** What to do when the request doesn't fit the template's kind of site. */
  adaptation: string;
  /** Sample content in the template the agent must replace or label before it could be published. */
  sampleContent: string[];
  /** Placeholder for the prompt box when this template is chosen. */
  promptExample: string;
}

const img = (id: SiteTemplateId, name: "preview" | "thumb"): SiteImage =>
  name === "preview" ? { src: `/site-templates/${id}/preview.webp`, width: 960, height: 810 } : { src: `/site-templates/${id}/thumb.webp`, width: 480, height: 405 };

const COMMON_INSTRUCTIONS = [
  "Keep the template's design system: its colours, type pairing, spacing, corner radii and overall composition, unless the request asks for a different look.",
  "Write the content from the user's request; never leave the template's sample brand, people, numbers or quotes in place of the user's own.",
  "Add, remove or reorder sections to fit the request; the template is a starting point, not a fixed layout.",
  "Keep the page accessible (semantic headings, alt text, visible focus, sufficient contrast) and responsive at desktop, tablet and phone widths.",
];

export const SITE_TEMPLATES: Record<SiteTemplateId, SiteTemplate> = {
  "launchpad-saas": {
    id: "launchpad-saas",
    name: "Launchpad",
    category: "SaaS / Technology",
    description: "A polished landing page built to turn visitors into customers.",
    headline: "Your next big idea starts here.",
    subheadline: "Build better workflows, move faster, and bring your team together in one beautifully simple platform.",
    visualDirection:
      "A bright, conversion-focused startup landing page: generous white space, an oversized headline, restrained indigo and violet accents, and a product dashboard as the visual centrepiece.",
    previewImage: img("launchpad-saas", "preview"),
    thumbnailImage: img("launchpad-saas", "thumb"),
    page: "/site-templates/launchpad-saas/index.html",
    designTokens: {
      colors: { background: "#ffffff", surface: "#f6f7fb", ink: "#0b1020", muted: "#697089", line: "#e6e8f0", accent: "#5b5bf6", accent2: "#8b5cf6", accentSoft: "#eef0ff" },
      radius: "12–18px on cards and buttons, pill badges",
      shadow: "soft, layered shadows; the product preview floats with a large diffuse shadow",
      spacing: "96px between sections on desktop, 1160px content width",
    },
    defaultColorPalette: [
      { name: "Ink", hex: "#0b1020" },
      { name: "Indigo", hex: "#5b5bf6" },
      { name: "Violet", hex: "#8b5cf6" },
      { name: "Mist", hex: "#f6f7fb" },
      { name: "White", hex: "#ffffff" },
    ],
    defaultTypography: {
      display: "Plus Jakarta Sans, 800, tight letter-spacing (-0.045em) for the hero",
      body: "Plus Jakarta Sans, 400–600, 16px",
      scale: "hero 80px, section titles 48px, card titles 18px",
      googleFonts: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap",
    },
    layoutPreset: "Centred hero over a product UI preview, then logo strip, 3×2 feature grid, testimonial with metrics, three pricing plans, dark call-to-action band and a compact footer.",
    sectionPresets: [
      { id: "announcement", label: "Announcement bar", purpose: "One short product update with a link." },
      { id: "nav", label: "Navigation", purpose: "Logo, four links, sign-in and the primary call to action; collapses to a menu on phones." },
      { id: "hero", label: "Hero", purpose: "Value proposition, two calls to action (Get started, See how it works) and a short reassurance line." },
      { id: "product", label: "Product preview", purpose: "A realistic dashboard of the product built in HTML and CSS, not a stock image." },
      { id: "logos", label: "Customer logos", purpose: "Social proof as a row of wordmarks." },
      { id: "features", label: "Features", purpose: "Six benefits with simple line icons." },
      { id: "testimonial", label: "Testimonial and results", purpose: "One quote with name and role, three outcome figures." },
      { id: "pricing", label: "Pricing", purpose: "Three plans with the middle one highlighted." },
      { id: "cta", label: "Closing call to action", purpose: "A dark band repeating the primary action." },
      { id: "footer", label: "Footer", purpose: "Logo, links and copyright." },
    ],
    responsiveBehavior: ["Navigation collapses into a menu below 960px", "Product preview hides its sidebar on tablets and phones", "Feature and pricing grids go 3 → 2 → 1 columns"],
    generationInstructions: [
      ...COMMON_INSTRUCTIONS,
      "Rebuild the product preview to show the user's own product (its real screens, data and terms), still in HTML and CSS.",
      "Keep two calls to action in the hero; point them at sections of the page unless the user gives real sign-up or demo addresses.",
    ],
    adaptation:
      "If the request isn't a software product (for example a restaurant or a portfolio), keep Launchpad's clean type, colour and spacing but replace the product preview, logo strip and pricing with sections that fit, such as a menu, gallery or contact section.",
    sampleContent: ["The Cadence brand, its dashboard data and the 4,000+ teams figure", "Customer wordmarks", "The testimonial from Maya Okafor and its figures", "Plan names and prices"],
    promptExample:
      "Build a website for my AI productivity startup. We help small teams automate repetitive work. Include a hero section, features, pricing, testimonials, and a contact form. Use a blue and white color palette and a confident, minimal design.",
  },
  "atelier-portfolio": {
    id: "atelier-portfolio",
    name: "Atelier",
    category: "Agency / Portfolio",
    description: "A bold, editorial portfolio designed to make your work stand out.",
    headline: "We build brands that move culture forward.",
    subheadline: "Independent thinking, thoughtful design, and digital experiences made to leave a lasting impression.",
    visualDirection:
      "A sophisticated editorial studio site: warm ivory and charcoal with a terracotta accent, very large serif headlines with italic emphasis, an asymmetric project grid and art-directed photography.",
    previewImage: img("atelier-portfolio", "preview"),
    thumbnailImage: img("atelier-portfolio", "thumb"),
    page: "/site-templates/atelier-portfolio/index.html",
    designTokens: {
      colors: { background: "#f2eee6", ink: "#1c1b19", muted: "#8a847a", line: "#d8d0c2", beige: "#e4dccd", accent: "#b4532a" },
      radius: "square images and edges; only buttons are pills",
      shadow: "none: depth comes from photography, rules and contrast",
      spacing: "112px+ between sections, 1320px content width, a 12-column asymmetric grid",
    },
    defaultColorPalette: [
      { name: "Ivory", hex: "#f2eee6" },
      { name: "Charcoal", hex: "#1c1b19" },
      { name: "Sand", hex: "#e4dccd" },
      { name: "Terracotta", hex: "#b4532a" },
      { name: "Stone", hex: "#8a847a" },
    ],
    defaultTypography: {
      display: "Instrument Serif, 400 with italic accents, line-height 0.92 for the hero",
      body: "DM Sans, 400, 16px; small uppercase labels with wide tracking",
      scale: "hero 136px, section titles 72px, project titles 30px",
      googleFonts: "https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500&family=Instrument+Serif:ital@0;1&display=swap",
    },
    layoutPreset:
      "Asymmetric hero (headline left, tall image right), a scrolling discipline line, a staggered 12-column project grid, numbered services list, dark studio section with portrait, and an oversized contact call to action in the footer.",
    sectionPresets: [
      { id: "nav", label: "Minimal navigation", purpose: "Wordmark, three links and a 'Start a project' pill." },
      { id: "hero", label: "Editorial hero", purpose: "A large headline with controlled line breaks and an italic accent, a short statement and a featured image." },
      { id: "ticker", label: "Disciplines line", purpose: "The studio's disciplines in large italic type." },
      { id: "work", label: "Selected work", purpose: "Four projects in a staggered grid with title, discipline, year and a hover reveal." },
      { id: "services", label: "Services", purpose: "Numbered disciplines with one-line descriptions." },
      { id: "studio", label: "About the studio", purpose: "Portrait, a large statement and a short story of the team." },
      { id: "contact", label: "Contact footer", purpose: "An oversized call to action, contact details and social links." },
    ],
    responsiveBehavior: ["Hero stacks below 960px", "Project grid goes staggered 12-column → 2 columns → 1 column", "Navigation keeps only the call to action on phones"],
    generationInstructions: [
      ...COMMON_INSTRUCTIONS,
      "Use the user's own projects, clients and disciplines; keep each project's title, short description, category and year.",
      "Keep the editorial feel: large type, generous white space and asymmetry rather than rows of identical rounded cards.",
    ],
    adaptation:
      "If the request is for a single creator rather than an agency, switch the voice to first person and the studio section to a personal bio. For non-creative businesses, keep the editorial styling and turn the project grid into the most visual thing the business has (spaces, products or case studies).",
    sampleContent: ["The Atelier Nord name, address and email", "The four projects and their years", "Elias Nord and the studio story"],
    promptExample:
      "Create a portfolio for my brand design studio in Berlin. Show six recent projects with short descriptions, our services, a short story about the team, and a contact section. Keep it bold and editorial with warm neutral colours.",
  },
  "form-found-store": {
    id: "form-found-store",
    name: "Form & Found",
    category: "E-commerce / Retail",
    description: "A refined storefront designed to showcase products and drive sales.",
    headline: "Everyday objects, thoughtfully made.",
    subheadline: "Discover timeless essentials designed with purpose, crafted with care, and made to last.",
    visualDirection: "A calm, product-led homeware storefront: warm stone backgrounds, a soft serif wordmark and headlines, a large campaign image and a four-product grid where photography leads.",
    previewImage: img("form-found-store", "preview"),
    thumbnailImage: img("form-found-store", "thumb"),
    page: "/site-templates/form-found-store/index.html",
    designTokens: {
      colors: { background: "#f5f2ed", paper: "#fbfaf7", ink: "#1f1d1a", muted: "#7c766b", line: "#e2dcd2", accent: "#6f7d68" },
      radius: "square product images and buttons; pill category filters",
      shadow: "none",
      spacing: "88px between sections, 1240px content width, 4:5 product images",
    },
    defaultColorPalette: [
      { name: "Stone", hex: "#f5f2ed" },
      { name: "Ink", hex: "#1f1d1a" },
      { name: "Sage", hex: "#6f7d68" },
      { name: "Clay", hex: "#c8b79a" },
      { name: "Paper", hex: "#fbfaf7" },
    ],
    defaultTypography: {
      display: "Fraunces, 300–400, soft optical style for the wordmark and headlines",
      body: "Jost, 400–500, 16px; uppercase tracked labels and buttons",
      scale: "hero 88px, section titles 44px, product names 16px",
      googleFonts: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400&family=Jost:wght@400;500&display=swap",
    },
    layoutPreset:
      "Announcement bar, centred wordmark with links left and search/bag right, full-width campaign hero, a product grid with category filters, an editorial story with two images, three brand values, a newsletter sign-up and a dark footer.",
    sectionPresets: [
      { id: "announcement", label: "Announcement bar", purpose: "Shipping or collection news in one line." },
      { id: "header", label: "Store header", purpose: "Links, centred wordmark, search and bag icons." },
      { id: "hero", label: "Campaign hero", purpose: "Lifestyle image, short headline and a 'Shop collection' button." },
      { id: "products", label: "Product grid", purpose: "Four products with 4:5 images, name, price, material and colours; category filters above." },
      { id: "story", label: "Brand story", purpose: "Editorial text with two images about how the products are made." },
      { id: "values", label: "Values", purpose: "Three short promises." },
      { id: "newsletter", label: "Newsletter", purpose: "Email sign-up with one line of copy." },
      { id: "footer", label: "Footer", purpose: "Wordmark and three link columns." },
    ],
    responsiveBehavior: ["Product grid goes 4 → 2 columns", "Links move into a menu below 1000px", "Hero image sits above the headline on phones"],
    generationInstructions: [
      ...COMMON_INSTRUCTIONS,
      "Use the user's products, prices and categories; keep products as structured data (an array of objects in script.js or clearly repeated markup) so a real catalogue can replace them later.",
      "There is no cart, checkout or payment: the bag and search icons link to the product grid. Build a cart only if asked, keep it in the browser, and say plainly that payments aren't connected.",
      "The newsletter form isn't connected to an email service; keep the honest message script.js shows on submit unless the user connects one.",
    ],
    adaptation:
      "If the request isn't a shop (for example a photography portfolio or a café), keep Form & Found's typography, palette and image-led layout but turn the product grid into a gallery, menu or services grid, drop the bag icon, and don't add prices or a cart.",
    sampleContent: ["The Form & Found brand", "The four products and their prices", "Shipping offer in the announcement bar", "Brand story and values"],
    promptExample:
      "Build an online shop for my small ceramics studio. Show a featured collection of mugs, bowls and vases with prices, a section about how each piece is handmade, and a newsletter sign-up. Calm, natural colours.",
  },
  "journal-personal": {
    id: "journal-personal",
    name: "Journal",
    category: "Personal Brand / Blog",
    description: "A thoughtful digital home for your ideas, stories, and expertise.",
    headline: "Notes on building meaningful things.",
    subheadline: "Ideas, lessons, and practical perspectives on creativity, technology, and the work that matters.",
    visualDirection:
      "A calm, typography-led personal site: warm off-white backgrounds, an elegant serif with a clean sans-serif, an arched portrait, a featured essay and an article list with dates and reading times.",
    previewImage: img("journal-personal", "preview"),
    thumbnailImage: img("journal-personal", "thumb"),
    page: "/site-templates/journal-personal/index.html",
    designTokens: {
      colors: { background: "#faf7f2", paper: "#f3eee6", ink: "#24211d", muted: "#847b70", line: "#e6dfd4", accent: "#3f5e50" },
      radius: "12–18px on images and cards, pill buttons, an arched portrait",
      shadow: "none",
      spacing: "96px between sections, 1080px content width, comfortable 60-character lines",
    },
    defaultColorPalette: [
      { name: "Paper", hex: "#faf7f2" },
      { name: "Linen", hex: "#f3eee6" },
      { name: "Ink", hex: "#24211d" },
      { name: "Forest", hex: "#3f5e50" },
      { name: "Taupe", hex: "#847b70" },
    ],
    defaultTypography: {
      display: "Newsreader, 400 with italic emphasis",
      body: "Inter, 400–500, 16px",
      scale: "hero 80px, essay titles 42px, list titles 22px",
      googleFonts: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,400;1,6..72,400&display=swap",
    },
    layoutPreset:
      "Simple header, an introduction with headline and calls to action beside a portrait and short bio, a featured essay card, three recent articles with covers, a dated archive list, an about section, a newsletter sign-up and a quiet footer.",
    sectionPresets: [
      { id: "nav", label: "Header", purpose: "Name as wordmark, three links and a Subscribe button." },
      { id: "intro", label: "Introduction", purpose: "Headline, one-line positioning, subscribe and read calls to action, portrait and short bio." },
      { id: "featured", label: "Featured essay", purpose: "Cover image, category, date, reading time, title and excerpt." },
      { id: "recent", label: "Recent writing", purpose: "Three articles with covers, then a dated list." },
      { id: "about", label: "About", purpose: "A professional biography and three facts." },
      { id: "newsletter", label: "Newsletter", purpose: "Email sign-up." },
      { id: "footer", label: "Footer", purpose: "Contact line and social links." },
    ],
    responsiveBehavior: ["Introduction stacks with a small portrait beside the bio", "Article cards go 3 → 2 → 1 columns", "Archive rows stack date above title on phones"],
    generationInstructions: [
      ...COMMON_INSTRUCTIONS,
      "Use the person's own name, bio, topics and articles; keep dates, reading times and categories on every article.",
      "The newsletter form isn't connected to an email service; keep the honest message script.js shows on submit unless the user connects one.",
    ],
    adaptation:
      "If the request is for a business rather than a person, keep Journal's typography and calm layout but turn the introduction into the business's story and the articles into news, case studies or resources.",
    sampleContent: ["Nora Ellison's name, portrait, bio and email", "Article titles, dates and excerpts", "Social links"],
    promptExample:
      "Create a personal website for me, a freelance UX researcher. Include a short intro with my photo, a list of my latest articles, an about section with my experience, and a newsletter sign-up. Warm, calm and easy to read.",
  },
};

export const SITE_TEMPLATE_LIST: SiteTemplate[] = SITE_TEMPLATE_IDS.map((id) => SITE_TEMPLATES[id]);

/** Suggestions offered under the prompt box; each is appended to what's written, never replacing it. */
export const PROMPT_SUGGESTIONS = ["Add a pricing section", "Make it more minimalist", "Use a dark theme", "Add customer testimonials", "Make it mobile-friendly"] as const;

/** The prompt with a suggestion added as its own sentence; nothing changes if it's already there. */
export function appendSuggestion(prompt: string, suggestion: string): string {
  const s = suggestion.trim();
  if (!s) return prompt;
  if (prompt.toLowerCase().includes(s.toLowerCase())) return prompt;
  const t = prompt.replace(/\s+$/, "");
  if (!t) return `${s}.`;
  return `${t}${/[.!?]$/.test(t) ? "" : "."} ${s}.`;
}

/** Optional details for a template-based request; empty ones are left out. */
export interface TemplateDetails {
  name: string;
  color: string;
  tone: string;
  audience: string;
  sections: string;
}

export const TONES = ["", "Minimal", "Bold", "Playful", "Elegant", "Warm", "Technical"] as const;

const clip = (s: string) => s.trim().replace(/\s+/g, " ").slice(0, 200);

/** The request as the agent reads it: the user's words, then any details they filled in. The template itself travels separately. */
export function templateRequest(prompt: string, d: Partial<TemplateDetails>): string {
  const lines: [string, string][] = [
    ["Website name", clip(d.name ?? "")],
    ["Primary brand colour", /^#[0-9a-f]{6}$/i.test(d.color ?? "") ? d.color! : ""],
    ["Tone", clip(d.tone ?? "")],
    ["Audience", clip(d.audience ?? "")],
    ["Pages or sections", clip(d.sections ?? "")],
  ];
  const filled = lines.filter(([, v]) => v);
  if (!filled.length) return prompt.trim();
  return `${prompt.trim()}\n\nDetails:\n${filled.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`;
}

/**
 * What the coding agent is told about the chosen template, added to its
 * instructions for the run. The user's request decides the content; this
 * decides the starting design.
 */
export function siteTemplateGuidance(id: SiteTemplateId): string {
  const t = SITE_TEMPLATES[id];
  const colours = Object.entries(t.designTokens.colors)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    `Website template: ${t.name} (${t.category}). The project already contains this template's index.html and style.css; start from them and edit them, don't start over.`,
    `Visual direction: ${t.visualDirection}`,
    `Layout: ${t.layoutPreset}`,
    `Sections: ${t.sectionPresets.map((s) => `${s.label} (${s.purpose})`).join("; ")}`,
    `Design tokens: colours ${colours}. Radius: ${t.designTokens.radius}. Shadows: ${t.designTokens.shadow}. Spacing: ${t.designTokens.spacing}.`,
    `Typography: display ${t.defaultTypography.display}; body ${t.defaultTypography.body}; scale ${t.defaultTypography.scale}. Fonts load from Google Fonts in index.html.`,
    `Responsive: ${t.responsiveBehavior.join("; ")}.`,
    ...t.generationInstructions.map((x) => `- ${x}`),
    `If the request doesn't fit this kind of site: ${t.adaptation} Say in your summary how you adapted it.`,
    `Sample content to replace with the user's (or label clearly as sample if they gave none): ${t.sampleContent.join("; ")}.`,
    "Photos load from Orbis's site (https addresses in index.html). The project's computer can't reach other sites, so they appear blank in your own browser checks; that is expected and not a bug. Keep them as placeholders unless the user provides images, and say they should be replaced.",
    "Never claim the site has working sign-in, payments, a database, email delivery or other integrations it doesn't have.",
  ].join("\n");
}
