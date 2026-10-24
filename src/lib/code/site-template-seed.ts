import { SITE_TEMPLATES, type SiteTemplateId } from "./site-templates";
import { SITE_TEMPLATE_SOURCES } from "./site-template-sources";

/**
 * Honest handling for a template's newsletter form: until the site is
 * connected to an email service, submitting says so instead of pretending
 * the address was saved.
 */
export const SIGNUP_SCRIPT = `// The forms aren't connected to an email service yet. Until they are,
// say so on submit instead of pretending anything was saved or sent.
document.querySelectorAll("form.signup, form.contact-form").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let note = form.querySelector(".form-note") || form.parentElement.querySelector(".signup-note");
    if (!note) {
      note = document.createElement("p");
      note.className = form.classList.contains("signup") ? "signup-note" : "form-note";
      note.setAttribute("role", "status");
      if (form.classList.contains("signup")) form.after(note);
      else form.append(note);
    }
    note.textContent = form.classList.contains("signup")
      ? "Sign-ups aren't connected to an email service yet, so this address wasn't saved."
      : "This form isn't connected to an email service yet, so your message wasn't sent.";
  });
});
`;

/** The phone menu (a <details> element) closes after choosing a section, instead of staying open over the page. */
export const MENU_SCRIPT = `// The phone menu closes after choosing a section.
document.querySelectorAll("details.menu nav a").forEach((a) => a.addEventListener("click", () => a.closest("details")?.removeAttribute("open")));
`;

/**
 * A template's starting files for a new website project. In the project the
 * bundled fonts are replaced by the same families from Google Fonts and the
 * photos point at Orbis's copies (by full address, since project files are
 * text), so the page looks the same in the project's preview and anywhere
 * it's published. A template's own script.js comes along (the gallery's
 * preview never runs it), forms get the honest form script, and a phone
 * menu gets the script that closes it after a link is chosen.
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
  // NOVA's own script already closes its menu.
  const needsMenu = /<details class="menu">/.test(src.html) && !src.js?.includes("details.menu") && !src.js?.includes(".menu nav a");
  const script = [src.js, hasForm ? SIGNUP_SCRIPT : "", needsMenu ? MENU_SCRIPT : ""].filter(Boolean).join("\n");
  let html = src.html.replace(/<link rel="stylesheet" href="\.\.\/fonts\/[\w-]+\.css" \/>/, fonts).replace(/src="img\//g, `src="${base}`);
  if (script) html = html.replace("  </body>", `    <script src="script.js" defer></script>\n  </body>`);
  return { "index.html": html, "style.css": src.css, ...(script && { "script.js": script }) };
}
