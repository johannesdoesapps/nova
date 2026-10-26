# Publishing websites from Orbis Code

The **Publish** button (top right of a Code project, where **Run** used to be; Run is now **Run the project** in the ⋯ menu) puts the project's saved files on a public address anyone can open, such as `bloom-florist-7f7d808b5d15.vercel.app`.

## How it works

1. **Save**: edits still waiting in the editor are saved first, so what goes live is what you see. If saving fails, nothing is published.
2. **Check** (`src/lib/publish/site.ts`):
   - **Entry point**: a plain site needs `index.html` at the top level. A project with `package.json` and a `build` script is built by the host: Vercel's framework preset is chosen from the dependencies (Next.js, Vite, Astro, SvelteKit, Nuxt, Remix, Gatsby, Create React App, Angular), otherwise `npm run build` runs.
   - **Broken references**: local `src`/`href`/`url()` links to files that don't exist are reported as warnings. The site still publishes.
   - **Secrets**: `.env*`, keys, `.git`, `node_modules` and Orbis's effect notes are never uploaded. A live credential written into a page or script (Stripe, OpenAI, Anthropic, GitHub, AWS, Slack, Supabase secret, private key) **blocks** publishing. A Google API key only warns, because browser keys for Maps and similar are meant to be public.
   - **Limits**: 300 files and 8 MB.
3. **Upload and build**: each file is uploaded once by its SHA-1, then a **production** deployment of exactly those files is created.
4. **Publish**: when the host reports the deployment ready, Orbis opens the address from outside (no cookies) and only calls the site live once it loads.
5. **Share**: the dialog shows the address with **Copy link** and **Open website**.

### Republishing and status

- Each project has one site whose name comes from the project and a key from its id (`<name>-<12 hex>`), so the address never changes, even if the project is renamed. Publishing again replaces the live version at the same address.
- Every deployment carries a fingerprint of the files it contains. The button's dot is green when the live site matches the saved files and amber when there are unpublished changes; the dialog says the same.
- If a build fails, the previous version stays live and the project's files are untouched; **Retry** publishes again.
- **Take site down** deletes the site at the host. The address stops working; the project is unchanged and can be published again.
- No database tables are needed: the host is the record of what's published.

### Security

- The hosting token lives only on the server (`src/lib/publish/vercel.ts`). It is sent to `api.vercel.com` and nowhere else; a different API address is accepted only for a loopback test server.
- Every request goes through the user's own session (row-level security). A deployment id is only reported if it belongs to that project's site. Orbis only opens addresses on `*.vercel.app`.
- Publishing is the Bastion operation `site.publish` (high risk, under the Exports capability), so lockdown or switching exports off stops it. It's limited to 6 publishes a minute per person.
- Sites are served from their own domain, never `tryorbis.app`, so a published page can't read Orbis cookies.

## Set-up (required before Publish works)

Until this is done the button opens a dialog explaining that publishing isn't set up yet.

1. In Vercel, choose the account or team that will host users' sites. A separate team keeps them apart from Orbis itself. Create an **access token** scoped to it (Account Settings → Tokens).
2. In the Orbis Vercel project's environment variables (Production), add:
   - `ORBIS_PUBLISH_VERCEL_TOKEN`: the token.
   - `ORBIS_PUBLISH_VERCEL_TEAM_ID`: the team's id (`team_…`). Leave it out for a personal account.
3. Redeploy Orbis.

### Things to decide

- **Who may publish.** Every signed-in user can publish today, within the rate limit. Gate it by plan if wanted.
- **Hosting terms and cost.** Sites are hosted on your Vercel account: check the plan's usage limits and terms for hosting other people's sites.
- **Abuse.** Public hosting can be misused (phishing, spam). Take sites down with **Take site down** or in Vercel; consider a report link.
- **Custom domains.** Not included. Vercel supports them per project if you want to offer them later.

## Tests

- `tests/publish.test.ts`: site checks, secrets, frameworks, limits, naming, fingerprints, and the Vercel client against a fake API (uploads by SHA-1, public projects, production deployments, retries, refusals without leaking the token, the reachability check).
- A browser run against a local copy of the Vercel API covered (35 checks):
  - first publish and the live link, Copy and Open, a separate signed-out visitor loading the page and its styles;
  - unpublished-changes indicator, republishing to the same address, unsaved editor edits saved before publishing;
  - a failed build (old version stays live, Retry works), host 5xx and 403, offline;
  - a missing `index.html` and a leaked key blocked (in the API too), `.env` never uploaded;
  - another project's or deployment's status refused, signed-out requests refused;
  - phone layout, and taking the site down.
