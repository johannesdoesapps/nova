# Public website (`src/app/(marketing)`)

The homepage and public pages explain Orbis to visitors and search engines. The
signed-in app (chat, agents, Council, Arena, Missions, Workforce, Admin) is unchanged
and is kept out of search results.

| URL | What it is |
|---|---|
| `/` | Homepage: hero with a real product screenshot, benefits, features with status, how it works, security & data, pricing, FAQ |
| `/features`, `/features/<slug>` | One page per capability: what it does, who it's for, how to use it, limits |
| `/pricing` | Free plan (live) and Pro (not on sale yet — no price is shown until there is one) |
| `/docs`, `/docs/<slug>` | Practical guides, each linked to its feature page |
| `/security` | What Orbis stores, where messages go, what agents may do, code execution, your control |

## Editing content

All public copy lives in **`src/content/site.ts`**: `FEATURES`, `GUIDES`, `FAQ` and the
pricing numbers (read from `src/lib/plans.ts`, so limits never drift from what's enforced).

- **Add a feature page:** add an entry to `FEATURES` with a `status` — `available`,
  `beta`, `preview` or `planned`. Never mark something available that users can't use.
  The page, the homepage card, the footer link and the sitemap entry appear automatically.
- **Add a guide:** add an entry to `GUIDES` (with `short` for navigation and `feature`
  to link it to its feature page). Write for a real question someone has; prefer one
  good guide over several thin ones.
- **Product screenshot:** `public/product/chat.webp` is a real capture of the chat studio
  with an example conversation (taken from a local run against a mock database). Retake it
  when the interface changes, and keep the `alt` text in `src/app/(marketing)/page.tsx`
  describing what the image actually shows.

## SEO in place

- Unique title, description and canonical URL per page (`pageMetadata` in `src/lib/seo.ts`),
  based on `NEXT_PUBLIC_SITE_URL` (production: `https://nova-supabase.vercel.app`).
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
2. Choose **URL prefix** and enter `https://nova-supabase.vercel.app/` (a *Domain*
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

- **Privacy policy and terms of service.** None exist yet; the Security & data page
  describes how the product works, but it is not a legal policy. Once written, add
  `/privacy` and `/terms` pages and link them in the footer (`SiteFooter` in
  `src/components/marketing/parts.tsx`) and on the sign-up form.
- **Contact details** (an email address or form) for support and data requests —
  account deletion currently needs the operator.
- **Pro plan price**, when it goes on sale (shown on `/pricing` and the homepage).
- **Web search key** (`SEARCH_PROVIDER` + `SEARCH_API_KEY`) if you want live sources and
  Truth Layer checks — the feature pages say clearly that they're not enabled yet.
- Optionally a custom domain (better for branding and Search Console).
