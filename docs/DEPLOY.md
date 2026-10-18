# Deploying NOVA publicly

This guide puts NOVA on the internet as a real app, with sign-in, saved history, Agents and real AI answers. You'll use three services, all with free tiers to start:

| Service | Role | Required? |
| --- | --- | --- |
| **GitHub** | Holds the code; Vercel deploys from it | Yes |
| **Vercel** | Hosts the website and API (Next.js) | Yes |
| **Supabase** | Accounts, database, per-user privacy | Strongly recommended |
| **OpenAI** (or Hugging Face) | Real AI answers | For real answers |
| Tavily or Brave | Web search for Research agents | Optional |
| Render / Railway / Fly.io | Python engine for AI Lab and Radar | Optional |

Total time is about 30–45 minutes the first time.

---

## Step 1: Put the code on GitHub

1. Go to https://github.com/new and create an **empty, private** repository named `nova-ai`. Don't add a README or a licence.
2. In a terminal, inside the `nova-ai` folder:
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/nova-ai.git
   git push -u origin HEAD:main
   ```
3. Check that `.env.local` is **not** in the repository. It's git-ignored, but confirm on GitHub.

## Step 2: Create the Supabase project (accounts and database)

1. At https://supabase.com, go to **New project**. Choose a region near your users and save the database password.
2. Apply NOVA's database schema (tables, row-level security, agents) from the `nova-ai` folder:
   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR-PROJECT-REF   # shown in Project Settings → General
   npx supabase db push
   ```
   This runs every file in `supabase/migrations/`, in order.
3. In **Project Settings → API**, copy the **Project URL** and the **publishable key** (`sb_publishable_…`). Both are safe to expose in the browser because row-level security protects the data.
4. In **Authentication → URL Configuration**, set:
   - **Site URL:** your production address, for example `https://nova-ai.vercel.app`. Change it later if you add a domain.
   - **Redirect URLs:** add `https://nova-ai.vercel.app/auth/callback`, and `http://localhost:3000/auth/callback` for local testing.
5. In **Authentication → Providers**, Email is on by default. For real sign-up emails at volume, set a custom SMTP server (Project Settings → Auth); the built-in sender is heavily rate-limited.

## Step 3: Get the AI keys

- **OpenAI:** create an API key at https://platform.openai.com/api-keys.
- **Set a monthly budget limit** under Settings → Limits. Every visitor's message is billed to you.
- **Optional:**
  - Hugging Face: a fine-grained token with "Make calls to Inference Providers".
  - Web search: a Tavily key (https://tavily.com) or a Brave Search key.

## Step 4: Deploy on Vercel

1. At https://vercel.com, sign in with GitHub, choose **Add New → Project** and import `nova-ai`. The Next.js framework is detected automatically; leave the build settings as they are.
2. Under **Environment Variables**, add the following, all for the **Production** environment:

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key |
   | `NEXT_PUBLIC_SITE_URL` | `https://nova-ai.vercel.app` (your final address) |
   | `ANTHROPIC_API_KEY` | your Anthropic key (Claude Haiku 5.5 becomes the default model) |
| `OPENAI_API_KEY` | your OpenAI key (optional) |
   | `GEMINI_API_KEY` | your Google Gemini key (optional) |
   | `DEEPSEEK_API_KEY` | your DeepSeek key (optional) |
   | `NOVA_DAILY_REQUEST_LIMIT` | `30` (guest requests per day; signed-in users follow the plan limits in `src/lib/plans.ts`) |
   | `NOVA_RATE_LIMIT_PER_MINUTE` | `10` |
   | `NOVA_TRIAL_SECRET` | output of `openssl rand -base64 32` |
   | `SEARCH_PROVIDER`, `SEARCH_API_KEY` | optional: `tavily` and your key |

3. Click **Deploy**. When it finishes, open the address and go to `/chat` and `/agents`.
4. **Custom domain (optional):** in Project → Settings → Domains, add your domain and follow the DNS instructions. Then update `NEXT_PUBLIC_SITE_URL` in Vercel and the Site URL and Redirect URLs in Supabase, and redeploy.

Every later `git push` to `main` redeploys automatically.

## Step 5: Check it works

- [ ] Sign up with an email address, click the link, and you land back in the app signed in.
- [ ] `/chat`: send a message. The reply is **not** marked "Simulated".
- [ ] `/agents`: create an agent, reload the page, and it's still there.
- [ ] Sign in from a second browser with a different account. You can't see the first account's chats or agents.
- [ ] Send messages quickly. After the per-minute limit you get a "Too many requests" message.

## Step 5b: Administer models

Administrators are rows in `public.admins` (add one in the Supabase SQL editor: `insert into public.admins (user_id) values ('<auth user id>');`). Admins see **Admin** in the sidebar, where they can:

- check each provider's key with **Test connection** (lists the model IDs the key can use);
- enable or disable models, pick the default, and add newly released models without a code change;
- turn **Auto mode** and **Backup models** (fallback) on or off;
- set how many usage units a message to each model costs.

API keys are never entered in the app; they stay in your hosting environment variables.

## Step 6 (optional): The Python engine (AI Lab, Signal Radar, Workspaces)

Chat and Agents don't need it.

1. Deploy the `engine/` folder (it has a `Dockerfile`) to Render, Railway or Fly.io as a web service.
2. Set these variables on the engine:
   - `NOVA_ENGINE_SECRET`: generate with `openssl rand -base64 32`.
   - `NOVA_ENGINE_DATABASE_URL`: your Supabase Postgres connection string, using the pooler.
   - `NOVA_TOKEN_KEYS`: `k1:` followed by a base64 32-byte key.
3. Run the Radar worker (`python -m nova_engine.worker`) as a second, background service.
4. In Vercel, set `NOVA_ENGINE_URL` (the engine's public address) and the **same** `NOVA_ENGINE_SECRET`, then redeploy.

---

## Safety and cost notes

- **Without Supabase:**
  - In production, NOVA **refuses** to spend your AI key on anonymous visitors. Visitors see "This site isn't accepting anonymous AI requests yet."
  - To override this, set `NOVA_ALLOW_GUEST_AI=1`. That isn't recommended: anyone could then use your credit.
- **Rate limits:**
  - The per-minute limiter is in memory, so each Vercel instance counts separately.
  - The **daily** limit for signed-in users is stored in the database and is reliable.
  - For a strict global per-minute limit, put a shared store such as Upstash Redis behind `src/lib/rate-limit.ts`.
- **Keys:** keep every key in Vercel's environment variables only. Only `NEXT_PUBLIC_*` values reach the browser, and those contain no secrets.
- **Legal:** before inviting the public, add a privacy policy and terms. Chats are stored in your Supabase project and sent to your AI provider.
- **Monitoring:** for error tracking, set `SENTRY_DSN` and connect Sentry in `src/lib/observability.ts`.
