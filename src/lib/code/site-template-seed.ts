import { SITE_TEMPLATES, type SiteTemplateId } from "./site-templates";
import { SITE_TEMPLATE_SOURCES } from "./site-template-sources";

/**
 * Honest handling for a template's newsletter form: until the site is
 * connected to an email service, submitting says so instead of pretending
 * the address was saved.
 */
export const SIGNUP_SCRIPT = `// The sign-up form isn't connected to an email service yet. Until it is,
// say so on submit instead of pretending the address was saved.
document.querySelectorAll("form.signup").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let note = form.parentElement.querySelector(".signup-note");
    if (!note) {
      note = document.createElement("p");
      note.className = "signup-note";
      note.setAttribute("role", "status");
      form.after(note);
    }
    note.textContent = "Sign-ups aren't connected to an email service yet, so this address wasn't saved.";
  });
});
`;

/**
 * A template's starting files for a new website project. In the project the
 * bundled fonts are replaced by the same families from Google Fonts and the
 * photos point at Orbis's copies (by full address, since project files are
 * text), so the page looks the same in the project's preview and anywhere
 * it's published. Forms get the honest sign-up script.
 */
export function siteTemplateFiles(id: SiteTemplateId, origin: string): Record<string, string> {
  const src = SITE_TEMPLATE_SOURCES[id];
  if (!src) throw new Error(`Website template ${id} has no files.`);
  const t = SITE_TEMPLATES[id];
  const base = `${origin.replace(/\/$/, "")}/site-templates/${id}/img/`;
  const fonts = `<link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="${t.defaultTypography.googleFonts.replace(/&/g, "&amp;")}" />`;
  const hasForm = /<form\b/.test(src.html);
  let html = src.html.replace(/<link rel="stylesheet" href="\.\.\/fonts\/[\w-]+\.css" \/>/, fonts).replace(/src="img\//g, `src="${base}`);
  if (hasForm) html = html.replace("  </body>", `    <script src="script.js" defer></script>\n  </body>`);
  return { "index.html": html, "style.css": src.css, ...(hasForm && { "script.js": SIGNUP_SCRIPT }) };
}
