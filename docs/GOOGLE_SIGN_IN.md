# Continue with Google

NOVA's sign-in page offers **Continue with Google** next to email and password.
It uses the auth provider NOVA already has — **Supabase Auth** — so there is no
second account system: Google users are ordinary Supabase users with a `google`
identity, the same `profiles` row, the same RLS, plans and admin rules.

## How it works

1. The button calls `supabase.auth.signInWithOAuth({ provider: "google" })` in the
   browser (`src/components/common/login-form.tsx`). Supabase creates a PKCE
   verifier (S256), stores it in a cookie, and sends the browser to Google with
   `prompt=select_account` (Google always shows its account chooser, so a shared
   device never continues silently as the last Google user).
2. Google authenticates the user on Google's own pages. NOVA never sees or stores
   a Google password. Supabase requests only `openid email profile`, and checks
   the OAuth `state` and the OpenID `nonce`.
3. Supabase redirects to `/auth/callback?via=google&next=…&code=…`
   (`src/app/auth/callback/route.ts`), which exchanges the one-time code for a
   session using the verifier from the same browser and sets the session cookie.
4. The user continues to `next` — only same-site paths are accepted
   (`safeNext` in `src/lib/auth-flow.ts`); anything else goes to `/`.

Failures (cancelled at Google, expired or reused code, sign-in started in another
browser, provider switched off) return to `/login?msg=<code>`. The sign-in page
only shows a fixed list of messages for known codes — never text from the URL or
from the provider — so links can't put arbitrary text on NOVA's sign-in screen.

When Google is not enabled in Supabase, the button is shown disabled with
"Google sign-in isn't set up on this site yet". The page reads the public
`/auth/v1/settings` endpoint (cached 60 s), so enabling Google in Supabase turns
the button on within about a minute, without a redeploy.

### New and existing users

- **New Google user:** Supabase creates the user; the `handle_new_user` trigger
  creates the profile, named from Google's `full_name`/`name` (migration
  `20261019110000_oauth_profile_names.sql`). Same defaults as any new user: Free
  plan, no admin rights.
- **Returning Google user:** matched by the Google identity (Google's `sub`), not
  by email or name. One Google identity belongs to exactly one NOVA user
  (Supabase enforces `unique(provider, provider_id)` on `auth.identities`).
- **Email/password user who clicks Google with the same address:** Supabase's
  automatic identity linking attaches the Google identity to the existing account
  — the email is proven by Google (`email_verified`), and Supabase removes any
  *unconfirmed* identities on that account at the same time (pre-account-takeover
  protection). Projects, chats, plan and admin rights are kept; no duplicate
  account is created.

### ⚠ Account-linking and "Confirm email"

Supabase's automatic linking is safe only if every existing email/password
account has actually proven its email. With **Confirm email turned off**
(`mailer_autoconfirm: true`, as on this project at the time of writing), anyone
can sign up as `someone@gmail.com` with a password without owning that inbox; if
the real owner later uses Google, Supabase links Google to that account and the
squatter's password still works on it.

**Recommendation: turn "Confirm email" back on** (Supabase → Authentication →
Sign In / Providers). Google sign-ups are unaffected (Google already verified
the address); only email/password sign-ups get a confirmation link again.

Manual linking ("Connect Google" from settings while signed in) needs
"Allow manual linking" in Supabase and isn't built yet.

## Setup (one-time)

### 1. Google Cloud Console

1. https://console.cloud.google.com → create or pick a project (e.g. "NOVA").
2. **Google Auth Platform → Branding** (older consoles: *APIs & Services → OAuth
   consent screen*): app name "NOVA", support email, logo optional,
   homepage `https://nova-supabase.vercel.app`, Audience: **External**. Add
   `supabase.co` under authorized domains if the console asks for it (Google
   checks the redirect URI's domain). Note: Google's screen will say you are
   continuing to `vbsdxadumiogbdwgvrir.supabase.co`, because Supabase handles the
   callback; a Supabase custom domain changes that to your own domain.
3. **Data access / Scopes:** add only `openid`, `.../auth/userinfo.email`,
   `.../auth/userinfo.profile` (non-sensitive; no verification review needed).
4. **Audience:** while the app is in *Testing*, only listed test users can sign in
   (max 100). Click **Publish app** to let anyone sign in.
5. **Clients → Create client → Web application**, name "NOVA (Supabase)":
   - **Authorized JavaScript origins:** `https://nova-supabase.vercel.app`
     (add `http://localhost:3000` for local development)
   - **Authorized redirect URIs:**
     `https://vbsdxadumiogbdwgvrir.supabase.co/auth/v1/callback`
     (this is Supabase's callback, not NOVA's — Google returns to Supabase, which
     then returns to NOVA's `/auth/callback`)
6. Copy the **Client ID** and **Client secret**.

### 2. Supabase

1. **Authentication → Sign In / Providers → Google:** enable, paste the Client ID
   and Client secret, save. The secret is stored by Supabase only — it is never
   in NOVA's code, Vercel variables or the browser.
2. **Authentication → URL Configuration:**
   - Site URL: `https://nova-supabase.vercel.app`
   - Redirect URLs: `https://nova-supabase.vercel.app/**` (and
     `http://localhost:3000/**` for local development)
3. Recommended: turn **Confirm email** back on (see above).

No Vercel environment variables are needed for Google: NOVA only uses the
existing `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

### 3. Check

Open `/login`: the Google button becomes clickable within a minute. Sign in with
a Google account, confirm you land in NOVA signed in, then sign out.

## Tests

- `tests/auth-google.test.ts` (mocked Supabase): redirect safety, callback
  success/cancel/expired/invalid/no-code, provider error text never echoed, fixed
  message codes, profile names, provider detection.
- `tests/rls.test.ts`: the migration names Google profiles correctly (real
  Postgres via PGlite).
- Browser run (Playwright against a local NOVA with a mock Supabase that performs
  a real PKCE S256 check): both pages, keyboard focus, 390 px layout, full Google
  round trip to the requested page, double-click sends one request, cancel,
  forged code, crafted message text ignored, off-site `next` dropped, email
  sign-in, sign-out clears the session and verifier cookies, button disabled when
  Google is off. These are **mocked** — a real Google sign-in can only be tested
  after the setup above.
