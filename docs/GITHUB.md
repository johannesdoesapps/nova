# GitHub: sign-in and adding repository files to chat

Three things, each working on its own:

1. **Continue with GitHub** on the sign-in page.
   - Uses Supabase Auth's GitHub provider, like Google.
   - Orbis asks only for the public profile and email (`read:user user:email`).
   - The button only appears once GitHub is switched on in Supabase.
2. **Connect GitHub** for people who already have an Orbis account. It's in the chat composer: `+` → **Add from GitHub**.
   - Uses Supabase `linkIdentity`, which needs **manual linking** switched on in Supabase.
   - If that GitHub account already belongs to another Orbis user, they see "That GitHub account is already connected to another Orbis account."
3. **Add from GitHub** in the chat composer. Users install Orbis's **GitHub App** on the repositories they choose, then pick files to attach to a message. The usual limits apply: up to 3 files, about 150 KB of text per message.
   - Access is read-only: the app asks only for *Contents: read* (plus *Metadata: read*, which GitHub requires).
   - Orbis never writes to GitHub.

## How access is checked

On every request, Orbis:
1. Reads the GitHub account linked to the signed-in user from Supabase Auth (`getUser().identities`). The browser can't change this.
2. Looks up the app's installation on that account (`GET /users/{login}/installation`, as the app).
3. Uses the installation only if its owner's **numeric account id** matches. A renamed or reused login therefore can't pick up someone else's installation.

There's no table of installations, so there's nothing to tamper with. Installation tokens last an hour and are kept only in server memory.

Version 1 limits:
- **Organisation installations aren't used:** only an installation on the user's own account works.
- **What's listed:**
  - only text files of up to 100 KB, at most 5,000 per repository;
  - `node_modules`, build folders and binaries are skipped;
  - files containing NUL bytes are refused.

Endpoints (signed-in users, 60 requests a minute):

| Endpoint | Returns |
| --- | --- |
| `GET /api/github/status` | Whether GitHub is configured, linked and installed, plus the install and manage links |
| `GET /api/github/repos` | Repositories the user shared with Orbis |
| `GET /api/github/tree?repo=owner/name` | Text files on the default branch |
| `GET /api/github/file?repo=owner/name&path=…` | One file. Paths with `..`, a leading `/`, `\` or NUL are refused before GitHub is called. |

GitHub's own error text is never shown to users, because it can name private repositories.

## Setup (one time, about 15 minutes)

### A. Sign-in: GitHub OAuth App → Supabase

1. In GitHub, go to **Settings → Developer settings → OAuth Apps → New OAuth App**.
   - **Application name:** Orbis
   - **Homepage URL:** `https://tryorbis.app`
   - **Authorization callback URL:** the one Supabase shows in **Authentication → Sign In / Providers → GitHub**. It looks like `https://<project-ref>.supabase.co/auth/v1/callback`.
2. Create it. Copy the **Client ID**, then **Generate a new client secret** and copy it.
3. In Supabase, go to **Authentication → Sign In / Providers → GitHub**. Turn it on, paste the Client ID and secret, and save.
4. In Supabase, go to **Authentication → Sign In / Providers** (user settings) and turn on **Allow manual linking**. This lets existing users connect GitHub.

The sign-in button appears within about a minute; no redeploy is needed.

### B. Repository access: GitHub App → Vercel

1. In GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub App**.
   - **GitHub App name:** something unique, e.g. `Orbis AI johannes`. The web address of the app ("slug") comes from this name.
   - **Homepage URL:** `https://tryorbis.app`
   - **Setup URL:** `https://tryorbis.app/chat`. Tick **Redirect on update**.
   - **Webhook:** untick **Active**.
   - **Repository permissions → Contents:** Read-only. Metadata stays Read-only automatically. Leave everything else at No access.
     - To use **Code → Changes → Push to GitHub**, choose **Read and write** instead. Pushes only ever create new branches; see CODE_AGENT.md.
   - **Where can this GitHub App be installed?** Any account.
2. Click **Create GitHub App**. On the app's page:
   - copy the **App ID**;
   - note the **slug**, which is the last part of the app's public link (`https://github.com/apps/<slug>`);
   - under **Private keys**, click **Generate a private key**. A `.pem` file downloads.
3. In Vercel, go to **Project → Settings → Environment Variables**. Add these for Production and mark each one **Sensitive**:
   - `GITHUB_APP_ID` = the App ID
   - `GITHUB_APP_SLUG` = the slug
   - `GITHUB_APP_PRIVATE_KEY` = the whole contents of the `.pem` file, including the `BEGIN` and `END` lines
4. Redeploy (Deployments → ⋯ → Redeploy). Then delete the downloaded `.pem` file from your computer, or store it in a password manager.

### Check

Sign in, open a chat, and go to `+` → **Add from GitHub**. You should be able to:
1. click **Connect GitHub**, then **Choose repositories**;
2. pick a repository;
3. tick a file and click **Add**.

The file then shows as an attachment on the message.
