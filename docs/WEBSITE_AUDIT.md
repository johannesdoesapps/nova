# Website audit and redesign (20 October 2026)

An audit of https://tryorbis.app and its code (`src/app/(marketing)`, `src/components/marketing`, `src/content/site.ts`), done before the redesign. It records what was found and what was done about it.

How the site was checked:
- the live site, in Chromium at 1440 × 900 and 390 × 844;
- axe-core (WCAG 2.0/2.1/2.2 A and AA, plus best practice) on each public page;
- a check for horizontal overflow;
- a crawl of internal links;
- a read of the source.

## 1. What already worked well

- **Design language.** A restrained dark/light palette defined as tokens in `globals.css`. A serif display face for headlines and a sans for body text. Consistent rounded cards, and subtle motion that respects `prefers-reduced-motion`.
- **Honest status labels.** Every feature had a status (Available, Beta, Private preview, Planned).
- **SEO foundations:**
  - unique titles, descriptions and canonical URLs;
  - Open Graph images;
  - a sitemap and robots.txt;
  - JSON-LD;
  - `noindex` on the app, sign-in and API.
- **Accessibility basics.** A skip link, a keyboard-operable mobile menu, and labelled controls.
  - axe found no violations on pricing, features, security or docs.
  - The sign-in page had only "landmark" best-practice notes.
  - The homepage couldn't be checked: it returned a 502 during a deploy switchover. It was checked again after the redesign (see below).
- **Responsive layout.** No horizontal overflow on any public page at phone width.
- **Pricing tied to billing.** The pricing page reads plans, limits and model tiers from the same settings that enforce them. It says "Payments are being set up" while Stripe isn't configured, instead of showing a checkout that can't work.

## 2. What was confusing or unnecessary

- **The hero didn't say what Orbis is for.** "One AI workspace. Agents that help you get work done." was generic.
- **Repetition.** Seven feature cards had equal weight, followed by "Why Orbis", "Features" and "How it works" sections that repeated each other. The phone page was about 9,600 px tall.
- **An unreadable hero image on phones.** The hero screenshot shrank to about 350 px wide.
- **An unsupported claim.** The pricing page labelled Pro "Most popular", which no data supports.

## 3. What was out of date (misleading)

- **Code.** The site said Orbis's coding assistant "does not run your code or tests". Since then, the Code workspace (an editor, a terminal and a preview on an isolated computer) and a coding agent that runs tests have shipped. Neither was on the site.
- **Connectors** weren't mentioned anywhere.
- **"Agents can't take actions":**
  - The FAQ and the Security page said agents never act.
  - The coding agent now edits project files and runs commands, within approval rules.
  - Connected-app actions happen after the user confirms them.
- **Code execution.** The Security page said "the general assistant never runs code". Chat has had a Run button for code blocks, in an isolated sandbox, for a while.

## 4. What was redesigned

| Area | Change |
|---|---|
| Hero | New headline and supporting text (§ Positioning), "Get started free" with "Explore Orbis" as the secondary action, three facts that can be verified, and a real capture of the coding agent's finished run. Phones get a crop of the agent panel that stays readable. |
| Product demo | New **See it work** section, with tabs for Chat, Code, Compare and Plan. Each is a real capture from tryorbis.app, stating when and how it was made. The Code tab lists the agent's actual steps from that run, including the failing and then passing test runs. No account is needed, and nothing is simulated. |
| Structure | Features are grouped into three pillars: **Think** (Chat, Council & Arena), **Build** (Code, Autonomous Developer) and **Execute** (Agents, Mission Control, Connectors, Security Team). Each feature shows its status. |
| Trust | Six concrete points, each true today. For example: you see who answered; agents ask before they act; every change can be undone; code runs in isolation. |
| Navigation | The header shows Chat, Code, Agents, Pricing, Docs and Security, plus Sign in and Get started. It switches to the menu below 1024 px, so it never wraps. The footer adds "All features". |
| Pricing | A plan comparison table generated from the live plan settings, examples of what different tasks use (marked as examples), and what happens when you reach a limit. "Most popular" became "Recommended". |
| Features | The index is grouped by pillar. Feature pages show a real screenshot when there is one. New pages: Code (the coding agent and workspace) and Connectors. Statuses use "Coming soon" instead of "Planned". |
| Security & data | Rewritten to match the product: agent permissions and command rules, connected apps (OAuth, encrypted tokens, confirm-before-write, disconnect), the three kinds of code execution, revert, and what's stored for agent runs. |
| First run | The chat's empty state asks what you want to do (ask or research, documents, build software, create an agent, plan a project). It offers example prompts — some fill in the box so you can attach a file first — and links to Code, Agents (which opens the Create dialog) and Mission Control. First-time visitors get one line of introduction. |
| Docs | New guides: "Using the coding agent" and "Connecting apps to Orbis". |

## 5. What must not break

- Authentication, sign-up and sign-in (`/login`), and the `next` redirect into `/chat`.
- Billing: the plan buttons call the existing billing APIs. Nothing about prices, limits or entitlements was changed; every number shown is read from `src/lib/plans.ts` or the admin-configured billing settings.
- `noindex` on app routes, and the sitemap built from `FEATURES` and `GUIDES`.

## 6. What needs more backend work

- **Account self-deletion** isn't self-service yet. The Security page says so.
- **Background agent runs.** The coding agent works while its page is open.
- **A web search provider** (SEARCH_API_KEY), for live sources in Research mode and Council.

## 7. What can't be verified or done without the site owner

- **Analytics and funnel data.** No analytics provider is configured, so conversion, sign-up and retention can't be measured, and no A/B test can be run honestly. See WEBSITE.md → Analytics for the privacy-friendly setup.
- **A privacy policy and terms of service.** None exist. They must be written by the owner (legal text isn't invented here). Link them in the footer and on the sign-up form once published.
- **Customer testimonials, logos, usage statistics and certifications.** None exist, so none are shown.
- **Search Console** verification and sitemap submission need the owner's Google account.
- **Payments.** Stripe isn't configured, so Pro and Max show "Payments are being set up".
- **Connectors.** Only Wikipedia works until ORBIS_CONNECTOR_KEY and each provider's OAuth app are set up (CONNECTORS.md).
- **The GitHub App** is needed for GitHub import and Push to GitHub (GITHUB.md).

## Positioning

- **Headline:** "One workspace. Leading models. Agents that do the work."
  - It follows the suggested "One workspace. Every model. Agents that do the work." with one change. Orbis offers Claude and GPT models on tryorbis.app (and can add Gemini, Grok and DeepSeek), not *every* model. "Leading models" is accurate; "every" would be an exaggeration.
- **Supporting text:** "Use leading AI models, build specialised agents, and turn complex tasks into actionable plans — all in one workspace, with transparent results you can review."

## Measurements (production, 20 October 2026)

- **Lighthouse** 12, mobile preset with throttling, run from this environment through its proxy:

  | Page | Before | After |
  |---|---|---|
  | `/` | Performance 80, LCP 2.3 s, TBT 360 ms, CLS 0 | Performance 99, LCP 2.1 s, TBT 80 ms, CLS 0 |
  | `/pricing` | (run failed) | Performance 98–99, LCP 1.7–1.8 s, TBT 120–140 ms, CLS 0 |
  | `/features/ai-coding-assistant` | — | Performance 97, LCP 2.6 s, TBT 90 ms, CLS 0 |

  Accessibility, Best practices and SEO scored 100 on each page.
  - A first run after the redesign scored 82 (LCP 3.2 s), because phones preloaded both hero images. The hero now uses one `<picture>`, so a device downloads only the image that fits it.
  - Lab numbers only. Field data (real users' Core Web Vitals) needs analytics, which isn't enabled.
- **axe-core:** no violations on any public page. The sign-in page has two "moderate" best-practice notes about landmarks.
- **Layout:** no horizontal overflow at 1440 px or 390 px on any public page.
- **Links:** all 42 internal links return 200.
- **Live checks on tryorbis.app** (14 of 14 passed): hero and CTAs, the tour (including the keyboard), images and alt text, the phone menu (including Escape to close), the pricing comparison, the first-run introduction and goal chooser, the document prompt filling the box, and "Create an agent" opening the editor.
