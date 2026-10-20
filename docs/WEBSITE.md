# Public website (`src/app/(marketing)`)

The homepage and public pages explain Orbis to visitors and search engines. The
signed-in app (chat, agents, Council, Arena, Missions, Workforce, Admin) is unchanged
and is kept out of search results.

| URL | What it is |
|---|---|
| `/` | Homepage: hero with a real capture of the coding agent, "See it work" (real captures of Chat, Code, Council and Mission Control), the Think / Build / Execute pillars with feature status, trust, pricing summary, FAQ |
| `/features`, `/features/<slug>` | One page per capability: what it does, who it's for, how to use it, limits |
| `/pricing` | Free, Pro and Max from the live plan settings; a comparison table, usage examples and what happens at a limit. Pro and Max show "Payments are being set up" until Stripe is configured |
| `/docs`, `/docs/<slug>` | Practical guides, each linked to its feature page |
| `/security` | What Orbis stores, where messages go, what agents may do, code execution, your control |

## Editing content

All public copy lives in **`src/content/site.ts`**: `FEATURES` (each in a `pillar`: think,
build or execute), `PILLARS`, `GUIDES`, `FAQ` and the pricing numbers (read from
`src/lib/plans.ts`, so limits never drift from what's enforced). The homepage's product
captures and the coding agent's recorded steps are in **`src/content/demos.ts`**.

- **Add a feature page:** add an entry to `FEATURES` with a `status` — `available`,
  `beta`, `preview` or `planned` (shown as "Coming soon"). Never mark something available
  that users can't use.
  The page, the homepage card, the footer link and the sitemap entry appear automatically.
- **Add a guide:** add an entry to `GUIDES` (with `short` for navigation and `feature`
  to link it to its feature page). Write for a real question someone has; prefer one
  good guide over several thin ones.
- **Product captures** (`public/product/*.webp`) are real screenshots of tryorbis.app, taken
  by a script that signs in with a test account and runs the actual feature (the coding agent
  fixing a failing test, a chat reply, a Council, a Mission Control plan). Admin-only links, the
  test account's name and old test chats are hidden before capture; nothing else is altered.
  Retake them when the interface changes, and update the `alt` text, captions and the recorded
  agent steps in `src/content/demos.ts` to match.

## SEO in place

- Unique title, description and canonical URL per page (`pageMetadata` in `src/lib/seo.ts`),
  based on `NEXT_PUBLIC_SITE_URL` (production: `https://tryorbis.app`).
- Open Graph / Twitter previews with a generated image (`src/app/opengraph-image.tsx`),
  favicon and `icon.svg`, Apple touch icon.
- `sitemap.xml` (public pages only) and `robots.txt` (blocks `/api/` and `/auth/`, points
  to the sitemap). If you add a custom domain, change `NEXT_PUBLIC_SITE_URL` and redeploy —
  canonical URLs, the sitemap and social previews follow.
- Structured data: `WebSite` and `SoftwareApplication` (free offer) on the homepage,
  `BreadcrumbList` on feature and guide pages, `TechArticle` on guides. No reviews,
  ratings or organisation details are claimed.
- `noindex` on every app screen (studio and legacy layouts), the sign-in page
  (`noindex, follow`), shared links, and an `X-Robots-Tag: noindex` header on `/api/*`
  and `/auth/*`.

## Google Search Console (to do — needs the site owner)

1. Open https://search.google.com/search-console and **Add property**.
2. Choose **URL prefix** and enter `https://tryorbis.app/` (a *Domain*
   property isn't possible on a `vercel.app` subdomain; it is once you own a domain).
3. Verify with the **HTML tag** method: copy the `content` value of the
   `google-site-verification` tag and add it to the root layout metadata in
   `src/app/layout.tsx`:
   `verification: { google: "<the value Google gives you>" }`, then deploy and click
   **Verify**. (Alternatively upload the HTML file Google offers to `public/`.)
4. Under **Sitemaps**, submit `sitemap.xml`.
5. Use **URL inspection** on `/` to request indexing.

Nothing has been verified yet — this needs your Google account.

## Analytics (not enabled)

No analytics provider is configured, so no tracking code is included. To add one:

- **Vercel Web Analytics** (privacy-friendly, no cookies): enable it in the Vercel project
  → Analytics, `npm i @vercel/analytics`, and render `<Analytics />` in
  `src/app/(marketing)/layout.tsx` (and the studio layout if wanted).
- Useful events (with `track()` from `@vercel/analytics`): `cta_click` with a `location`
  (hero, pricing, footer…), `signup_started` with `method` (email/google),
  `signup_completed`, `signin_completed`.
- Never send email addresses, passwords, tokens, prompts or replies to analytics. If you
  pick a cookie-based tool, add a consent banner first where the law requires it.

## Still needed from the site owner

- **Privacy Policy and Terms of Service** are published at `/privacy` and `/terms`
  (content in `src/content/legal.ts`, settings in `src/content/legal-meta.ts`). They follow the
  structure and topics of OpenAI's and Anthropic's consumer documents, written for how Orbis
  actually works, and should be reviewed by a lawyer. Two facts are still missing and should be
  filled in `LEGAL` once known:
  - `operatorName`, the registered business name;
  - `address`, a postal address. UK e-commerce rules require a name and a geographic address for an online service.

  Make sure support@tryorbis.app receives mail — it's the contact for support, data requests and account deletion.

## Consent to the Terms and Privacy Policy

Nobody can use the app without accepting the current version of both documents.

- **Sign-up form** (`/login`, Create account): two required tick boxes, one per document. Neither
  "Create account" nor "Continue with Google/GitHub" works until both are ticked.
  - Email sign-up sends `terms_version` with the sign-up; the `handle_new_user` trigger records it.
  - Google/GitHub sets a short-lived `orbis_terms_pending` cookie; `/auth/callback` records it after sign-in.
- **Everyone else** (existing accounts, or Google/GitHub sign-ins from the "Sign in" tab): the proxy
  sends a signed-in user without an acceptance to `/consent`, which asks for both boxes (or offers
  to sign out). The public site, legal pages and sign-in stay open.
- **Records** are in `legal_acceptances` (user, document, version, method `signup`/`prompt`, time).
  Users can add and read their own rows but never change or delete them.
- **Changing the documents:** update `updated` in `LEGAL`. For a material change, also change
  `version` (e.g. `2027-03-01`): everyone is then asked to accept again on their next visit, with
  the heading "We've updated our terms". The Terms promise 30 days' notice before a material change
  takes effect, so email users first.
- **Pro plan price**, when it goes on sale (shown on `/pricing` and the homepage).
- **Web search key** (`SEARCH_PROVIDER` + `SEARCH_API_KEY`) if you want live sources and
  Truth Layer checks — the feature pages say clearly that they're not enabled yet.
- Optionally a custom domain (better for branding and Search Console).
