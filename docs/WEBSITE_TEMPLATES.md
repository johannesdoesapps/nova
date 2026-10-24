# Website templates (Discover → Build a website)

Discover's "Build a website from a prompt" opens `/code/website`: four website templates, a preview of each, then a describe step that starts the coding agent on a new project built from the chosen template.

## Flow

1. **Choose** (`/code/website`, `?template=<id>` keeps the selection). Cards show a screenshot of each template in a browser frame. "Preview template" opens the real page in a sandboxed frame (`sandbox=""`: no scripts, forms or navigation) at desktop (1280px, scaled) or phone (390px) width.
2. **Describe** (`?template=<id>&step=describe`). The request, five suggestion chips (they append, never replace) and optional details (name, brand colour, tone, audience, sections). The request is kept in sessionStorage (`orbis:site-draft`) for the tab, so it survives Back, previews, reloads and signing in. Back from this step returns to the gallery with the template selected; Back again returns to Discover.
3. **Generate**. `POST /api/code/projects` with `{ template: "website", siteTemplate: <id> }` creates the project from the template's files; the request is handed to the project page (`putBuildRequest`, with `siteTemplate`), which starts the agent with `options.siteTemplate`. A failed attempt keeps the request and reuses the project it already made.

"Start from scratch" goes to `/code`, the existing prompt-only flow, with no template.

## How the template shapes the result

- **Starting files** (`src/lib/code/site-template-seed.ts`): the template's `index.html` and `style.css`; fonts come from Google Fonts and photos from `https://tryorbis.app/site-templates/<id>/img/…` (project files are text, so images stay on Orbis's site). Templates with a newsletter form also get `script.js`, which says on submit that sign-ups aren't connected yet.
- **Agent instructions** (`siteTemplateGuidance` in `src/lib/code/site-templates.ts`): design tokens, typography, layout, sections, responsive behaviour, how to adapt when the request doesn't fit (e.g. a portfolio on the store template), the sample content to replace, and that the template has no payments, sign-in, database or email. The server accepts only the four ids, and adds the guidance only to website runs that aren't read-only.

## Files

| Path | What |
| --- | --- |
| `public/site-templates/<id>/index.html`, `style.css`, `img/` | The four pages and their photos (WebP). `CREDITS.md` lists the CC0 sources. |
| `public/site-templates/<id>/preview.webp`, `thumb.webp` | Card screenshots (top of the page at 1280×1080). |
| `public/site-templates/fonts/` | Latin subsets of the OFL fonts the pages use. |
| `src/lib/code/site-templates.ts` | The configuration: id, name, category, description, images, tokens, typography, sections, instructions. |
| `src/lib/code/site-template-sources.ts` | Generated copy of each page's HTML and CSS for the server. Run `npm run templates:sync` after editing a template; `tests/site-templates.test.ts` fails if it's out of date. |
| `src/components/code/site-templates-view.tsx` | Gallery, preview dialog and describe step. |

`/site-templates/*` is served with its own headers (`next.config.ts`): a CSP with `sandbox` and `default-src 'none'`, framing allowed only by Orbis, `noindex`, and `Access-Control-Allow-Origin: *` so fonts load inside the sandboxed (originless) frame.

## Analytics

Vercel Web Analytics custom events, carrying only the template id: `website_gallery_opened`, `website_template_preview`, `website_template_selected`, `website_prompt_submitted`, `website_generation_started`, `website_start_from_scratch`.

## Limits

- Photos in generated sites load from tryorbis.app. The project's computer can't reach other sites, so the agent's own browser checks show them blank (it's told this is expected); visitors see them.
- Names, people, prices and quotes in the templates are sample content; the agent is told to replace them or label them as samples.
