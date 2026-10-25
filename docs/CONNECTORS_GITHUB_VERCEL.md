# GitHub and Vercel connectors

Both are ordinary Orbis connectors (see docs/CONNECTORS.md): they appear on **/connectors**, sign in with OAuth 2.0
through the shared flow (state + PKCE in a signed, HTTP-only cookie; code exchanged on the server), store tokens
sealed with `ORBIS_CONNECTOR_KEY`, refresh them before they expire, and revoke access on disconnect. Every write
runs only after the person reviews and confirms it on a card in chat.

## GitHub

**Sign-in:** a GitHub App's user authorization (`github.com/login/oauth/authorize`). GitHub's recommended model:
- the person installs the app on **only the repositories they choose**;
- the token reaches only repositories that both the person and the app can access;
- the token has only the app's permissions;
- user tokens expire after 8 hours and are refreshed automatically.

**Disconnect** deletes Orbis's copy of the tokens and revokes the authorization at GitHub
(`DELETE /applications/{client_id}/grant`). Removing the repositories themselves is done by uninstalling the app on
GitHub; the page says so.

| Orbis can… | API | Needs |
| --- | --- | --- |
| List the repositories you chose | `GET /user/installations`, `/user/installations/{id}/repositories` | — |
| List files, read a text file (≤ 1 MB; binaries refused) | `GET /repos/{r}/git/trees/{ref}?recursive=1`, `GET /repos/{r}/contents/{path}` | Contents: read |
| List branches and pull requests; search issues and PRs | `GET /repos/{r}/branches`, `/pulls`, `GET /search/issues` | Contents, Pull requests, Issues: read |
| **Create a branch** (confirmed) | `POST /repos/{r}/git/refs` | Contents: write |
| **Commit a file change** to a branch, creating the branch if needed (confirmed). Never to the default branch. | `PUT /repos/{r}/contents/{path}` | Contents: write |
| **Open a pull request** (confirmed) | `POST /repos/{r}/pulls` | Pull requests: write |
| **Open an issue** (confirmed) | `POST /repos/{r}/issues` | Issues: write |

Write actions are offered only when the person ticked **"Also allow…"** when connecting. Read-only is the default.

### Setup (site owner, about 10 minutes)

1. Go to GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Fill in the app details:
   - **GitHub App name:** something unique, e.g. `Orbis for tryorbis`. Its slug becomes `github.com/apps/<slug>`.
   - **Homepage URL:** `https://tryorbis.app`
   - **Callback URL:** `https://tryorbis.app/api/connectors/callback`
   - Leave **Expire user authorization tokens** ticked.
   - Leave **Request user authorization (OAuth) during installation** unticked. Orbis starts the sign-in itself, so it can check the request.
   - **Setup URL:** `https://tryorbis.app/connectors?connector=github`, with **Redirect on update** ticked.
   - **Webhook:** untick **Active**.
3. Under **Repository permissions**, set these and leave everything else at **No access**:
   - **Contents:** Read and write
   - **Issues:** Read and write
   - **Pull requests:** Read and write
   - **Metadata:** Read-only (required)
4. **Where can this GitHub App be installed?** Any account, so other Orbis users can install it.
5. Click **Create GitHub App**. On the app's page:
   - copy the **Client ID**;
   - click **Generate a new client secret** and copy it;
   - note the **slug** (the last part of the app's public link).
6. In Vercel → Project → Settings → Environment Variables, add these for Production, marked **Sensitive**:
   - `GITHUB_APP_CLIENT_ID`
   - `GITHUB_APP_CLIENT_SECRET`
   - `GITHUB_APP_SLUG`
7. Redeploy.

The same GitHub App can also power the chat composer's "Add from GitHub" and Code's "Push to GitHub" (docs/GITHUB.md).
Those use the app's ID and private key (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`). They're independent of the
connector and optional.

## Vercel

**Sign-in:** a Vercel App ("Sign in with Vercel"):
- authorize at `vercel.com/oauth/authorize` with PKCE;
- exchange the code at `api.vercel.com/login/oauth/token`;
- scopes are `openid email profile offline_access`, so a refresh token is issued;
- access tokens are short-lived and refreshed automatically.

What the token may touch is decided on Vercel: the app is installed on an account or team with the permissions the
owner grants there.

**Disconnect** deletes Orbis's copy and revokes the refresh and access tokens (`POST /login/oauth/token/revoke`).

| Orbis can… | API |
| --- | --- |
| List projects across your personal account and teams, with production URL and status | `GET /v2/teams`, `GET /v10/projects` |
| List a project's deployments (status, target, branch, commit, URL) | `GET /v9/projects/{id}`, `GET /v6/deployments` |
| Show one deployment with its error and the last 150 lines of its build log | `GET /v13/deployments/{id}`, `GET /v3/deployments/{id}/events` |
| **Redeploy** an existing deployment to production or as a preview (confirmed) | `POST /v13/deployments` with `deploymentId` |

A team that Orbis's app isn't installed on is skipped, and the reply says so. A refused call gets a message
explaining how to grant access.

### Setup (site owner, about 10 minutes)

1. In the Vercel dashboard, open your team → **Settings → Apps**, and create an app (Sign in with Vercel).
2. Fill in the app details:
   - **Name:** Orbis.
   - **Authorization Callback URL:** `https://tryorbis.app/api/connectors/callback`
   - **Scopes:** `openid`, `email`, `profile`, `offline_access`.
3. **Permissions:** Projects (read) and Deployments (read and write). Grant nothing else.
4. Generate a **client secret**. Copy the **Client ID** (it starts with `cl_`) and the secret.
5. Install the app on the team whose projects Orbis should see. You can also do this when connecting.
6. In Vercel → Project → Settings → Environment Variables, add these for Production, marked **Sensitive**:
   - `ORBIS_VERCEL_CLIENT_ID`
   - `ORBIS_VERCEL_CLIENT_SECRET`
7. Redeploy.

The names start with `ORBIS_` because Vercel reserves some `VERCEL_*` names.

Vercel's App permissions are labelled in its dashboard. Orbis shows them as `read:project`, `read:deployment` and
`write:deployment`, the names Vercel's CLI uses (`vercel oauth-apps install --permission …`).

## Testing after setup

1. Sign in to Orbis and open **Connectors → GitHub → Connect**. Tick "Also allow…" if you want write actions.
2. Approve on GitHub. If the app isn't installed yet, use **Choose repositories on GitHub** on the card.
3. Back on Orbis, the card should say **Connected** with `@your-login`. **Check connection** should say it works.
4. In chat, ask "list my GitHub repositories", then "what's in README.md of owner/repo".
5. For writes, ask "create a branch orbis/test in owner/repo". Confirm the card; the branch appears on GitHub.
6. Do the same for **Vercel**:
   - "list my Vercel projects";
   - "why did the last deployment of <project> fail?";
   - "redeploy <dpl id> as a preview", then confirm.
7. **Disconnect** both. GitHub → Settings → Applications → Authorized GitHub Apps should no longer list Orbis.

## Code

- **Providers:**
  - `src/lib/connectors/providers/github.ts`
  - `src/lib/connectors/providers/vercel.ts`
- **Catalog entries:** `src/lib/connectors/catalog.ts`
- **Shared OAuth:** `src/lib/connectors/oauth.ts`
  - `urlScopes: "base"` for app-permission services;
  - `recordedScopes`.
- **Tests:** `tests/connectors-github-vercel.test.ts`, covering:
  - authorization URLs;
  - code exchange;
  - refresh and revoke;
  - every tool and action against mocked API responses;
  - default-branch protection;
  - input validation.
