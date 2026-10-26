/**
 * Effects the "Add an effect" template can add to a project. Each effect's full instructions
 * (Orbis's notes, then the original integration prompt with its component code) are a Markdown file in
 * public/template-effects/. They're too long for an agent request, so the file is copied into the project and
 * the request asks the agent to read it, follow it, and delete it once the effect works.
 */

export const WEBSITE_EFFECTS = [
  { id: "image-generation-loader", name: "Image generation loader", summary: "A pixel mosaic that resolves into the image once it has loaded." },
  { id: "voice-glow", name: "Voice glow", summary: "A glow along the bottom of an input that rises with the voice." },
  { id: "gooey-menu", name: "Gooey menu", summary: "Round buttons that melt out of one another when a menu opens." },
  { id: "pricing-section", name: "Animated pricing section", summary: "Pricing cards with a Monthly/Annual switch, animated prices and confetti." },
  { id: "theme-toggle", name: "Animated light/dark switch", summary: "A sun/moon button that reveals the new theme as a growing circle." },
] as const;

export type WebsiteEffect = (typeof WEBSITE_EFFECTS)[number];
export type WebsiteEffectId = WebsiteEffect["id"];

export function findEffect(idOrName: string | null | undefined): WebsiteEffect | undefined {
  return WEBSITE_EFFECTS.find((e) => e.id === idOrName || e.name === idOrName);
}

/** Where the instructions are served from. */
export const effectUrl = (id: WebsiteEffectId) => `/template-effects/${id}.md`;
/** Where they go in the project the agent works on. */
export const effectPath = (id: WebsiteEffectId) => `orbis-effects/${id}.md`;

/** The agent request: short, pointing at the instructions file, with where to put the effect and any notes. */
export function effectRequest(effect: WebsiteEffect, where = "", notes = ""): string {
  const place = where.trim().replace(/\s+/g, " ").slice(0, 300);
  const extra = notes.trim().slice(0, 2000);
  return [
    `Add the ${effect.name} effect to this website: ${effect.summary.charAt(0).toLowerCase()}${effect.summary.slice(1)}`,
    `The full instructions, including the original component code, are in ${effectPath(effect.id)}. Read that file first and follow its notes on adapting the effect to this project.`,
    place && `Where to put it: ${place}.`,
    extra && `My notes:\n${extra}`,
    `When the effect works at desktop and phone sizes, delete ${effectPath(effect.id)}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
