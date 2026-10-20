# Connectors

Connectors let people connect the apps they use — Gmail, Google Drive, Slack and others — so Orbis can:

- search them;
- answer questions from them, with the sources cited;
- prepare drafts, events, messages and issues that the user confirms before anything happens.

The page is **/connectors**, linked in the sidebar and in the command palette.

## What's supported

Every connector below has a working implementation against the service's official API. Nothing is listed that Orbis can't do.

| Connector | Sign-in | Reads | Writes (only after the user confirms) | Works today? |
| --- | --- | --- | --- | --- |
| Wikipedia | none (public data) | search, read articles | — | **Yes, no setup** |
| Google Drive | Google OAuth | search; read Docs, Sheets (CSV), Slides, text files | — | needs Google setup |
| Gmail | Google OAuth | search; read threads | save a draft (never sends) | needs Google setup |
| Google Calendar | Google OAuth | list and search events; free/busy | add an event (no invitations sent) | needs Google setup |
| Slack | Slack OAuth (user token) | search messages | post a message as the user | needs Slack setup |
| Notion | Notion OAuth (public connection) | search pages shared with Orbis; read pages | — | needs Notion setup |
| GitHub | Orbis's GitHub App (docs/GITHUB.md) | list repositories, read files, search issues and PRs | open an issue | needs the GitHub App |
| Microsoft OneDrive | Microsoft OAuth | search; read text files | — | needs Microsoft setup |
| Microsoft Outlook | Microsoft OAuth | search; read messages | save a draft (never sends) | needs Microsoft setup |
| HubSpot | HubSpot OAuth | search contacts, companies, deals | — | needs HubSpot setup |
| Figma | Figma OAuth | read a linked file's pages, frames and text; read comments | — | needs Figma setup |

Until the site owner sets a connector up, it shows as **Not set up yet** and can't be connected. Administrators see what's missing in each connector's panel.

## How it works

| Part | Where |
| --- | --- |
| Catalog: names, permissions, capabilities, setup needs (client-safe) | `src/lib/connectors/catalog.ts` |
| The interface each connector implements | `src/lib/connectors/types.ts` |
| Implementations against each official API | `src/lib/connectors/providers/*` |
| Registry | `src/lib/connectors/registry.ts` |
| OAuth 2.0 flow (state, PKCE, code exchange, refresh) | `src/lib/connectors/oauth.ts` |
| Token encryption and signed state | `src/lib/connectors/crypto.ts` |
| Calls with timeouts, retries and error mapping | `src/lib/connectors/http.ts` |
| Storing connections; running tools and confirmed actions | `src/lib/connectors/runtime.ts` |
| AI routing in chat | `src/lib/connectors/router.ts`, `chat.ts`, `src/app/api/chat/route.ts` |
| APIs | `src/app/api/connectors/**` |
| Database | `supabase/migrations/20261021000000_connectors.sql` |
| Pages | `src/app/(studio)/connectors`, `src/components/connectors/*` |

### Connecting

1. The user opens a connector and presses **Connect**.
   - Write permissions are asked for only if they tick "Also allow…", which is off by default.
2. `GET /api/connectors/[id]/connect` sends them to the service's own sign-in and consent page.
   - The request uses a random `state` and, where the provider supports it, PKCE.
   - Both are kept in a signed, HTTP-only cookie that expires after 10 minutes.
3. The service sends them back to `GET /api/connectors/callback`. That route checks:
   - the state matches;
   - it's the same signed-in user;
   - the request hasn't expired.
4. The server then:
   - exchanges the code for tokens using the client secret;
   - looks up the account name;
   - records which permissions were **actually granted** (people can untick some);
   - saves the connection.
5. Nothing is marked connected unless every step worked.
6. GitHub uses the existing GitHub App flow instead (link the GitHub account, then choose repositories).
7. Wikipedia has no account; the user only turns it on.

### Statuses

| Status | Meaning |
| --- | --- |
| Not connected | No connection. |
| Connecting | While the user is at the service's sign-in page. |
| Connected | Works. |
| Reconnect needed | The service rejected the saved sign-in (revoked, expired, password changed). Reconnect fixes it. |
| Connection error | The last check failed for another reason (the service is down, or a permission is missing). |
| Disconnected | The user disconnected. Tokens are deleted; the row remains without them. |

**Check connection** makes a cheap call to the service and records the result.

### Using connections in chat

For each chat message from a signed-in user (`connectorContext`):

1. **Which apps apply.** These are the apps the user names, plus, for connections set to *Automatically*, apps the message is about when it's about the user's own things ("my inbox", "our plan").
   - Connections set to *Only when I name it* join only when named.
   - Connections set to *Never* never join.
   - Public-data connectors (Wikipedia) join only when named.
   - If no app applies, nothing runs and nothing extra is charged.
2. **Planning.** A fast standard-tier model (Auto, Quick) picks the searches, their queries, and how many results to read in full. Its cost counts against the AI budget but uses no message allowance (`auxiliary` run, purpose `connector_plan`). Without a model, Orbis runs a keyword search.
3. **Retrieval.** The calls run in parallel, then the top results are read: at most 4 searches and 4 reads.
4. **Answer.**
   - Results become numbered sources that continue the web-source numbering. The model cites them as [n], and the chat shows which app each came from.
   - The model is told the results are private data, to treat their content as data rather than instructions, and never to invent records.
5. **Honest failures.**
   - An app that couldn't be used is shown under the reply ("Gmail needs reconnecting on the Connectors page").
   - The model is told about it too.
   - This includes apps the user named that aren't connected or set up.

### Actions (write operations)

Actions run only after the user confirms them in a card under the reply. These are the actions available:

- save a Gmail or Outlook draft;
- add a Google Calendar event;
- post a Slack message;
- open a GitHub issue.

How an action reaches the user:

1. An action is offered to the model only when the connection has write access turned on **and** the write permission was granted.
2. If the user asks for something an action does, the model ends its reply with an `orbis-action` block.
3. The server validates the block against the action's schema and shows it as a card. The user can edit the fields, then **Confirm** or **Dismiss**.
4. The model is told never to say an action happened.

When the user presses **Confirm**, `POST /api/connectors/actions` checks everything again (write access, granted permission, valid details) before running it.

Every attempt is logged in `connector_actions`: which action, whether it worked, and a short summary, without content. The card's state is saved with the reply, so it isn't offered again after a reload.

Some limits are built into the actions themselves:

- drafts are never sent;
- calendar events send no invitations;
- Slack posts and GitHub issues are visible to others, and their cards say so.

### Security

- **Tokens are never sent to the browser.** They are sealed with AES-256-GCM using a key only the server has (`ORBIS_CONNECTOR_KEY`).
- **Sealed tokens are bound to their row.** The binding is the user id plus the connector id, so a sealed token can't be moved to another row.
- **The database holds only sealed tokens.** Row-level security limits each row to its owner, and users can't set the owner column.
- **Users stay isolated.** Every call uses the user's own session and their own connection.
- **Least privilege.** Read-only is the default, write scopes are requested only on opt-in, and each connector asks only for its own scopes.
- **Provider error text is never shown or stored.** It can contain account details, so the user sees a message based on the status code instead.
- **Disconnecting** deletes the tokens and revokes access at the provider where possible:
  - Google and Slack revoke the token.
  - Google revokes the whole grant of a client, so Orbis doesn't revoke while other Google connectors still use it, and says so.
  - Microsoft, Notion, HubSpot and Figma have no revoke API for apps, so the page tells the user where to remove Orbis.
- **Rate limits:**
  - 60 connector requests a minute per user;
  - 20 searches a minute;
  - 10 confirmed actions a minute.
- **Service limits.** Retries honour the service's `Retry-After`.
- **Caching.** Identical calls are cached for 60 seconds per user.
- **Sync.** There's no background sync. Orbis reads live when needed, so it stores no copies of anyone's data.

## Setting a connector up (site owner)

All OAuth connectors need two things.

1. **The encryption key**, once.
   - On /connectors, an administrator sees **Generate a key**. The key is made in the browser and never sent to Orbis.
   - Add it in Vercel as `ORBIS_CONNECTOR_KEY` (Production, **Sensitive**) and redeploy.
   - Never change it later: saved connections would stop working.
2. **The provider's OAuth app.** Use this redirect URL everywhere: `https://tryorbis.app/api/connectors/callback`.

### Google (Drive, Gmail, Calendar)

1. In [Google Cloud Console](https://console.cloud.google.com/), use the project you use for Google sign-in, or create one.
2. **APIs & Services → Library**: enable the **Google Drive API**, **Gmail API** and **Google Calendar API**.
3. **OAuth consent screen**: add the scopes listed on each connector's panel.
   - Drive and Gmail scopes are *restricted*: until Google verifies the app (which includes a security assessment for Gmail and Drive), only **test users you add** (up to 100) can connect.
   - Calendar scopes are *sensitive*: Google shows an "unverified app" warning until it's verified.
4. **Credentials → Create credentials → OAuth client ID → Web application**:
   - authorized redirect URI: `https://tryorbis.app/api/connectors/callback`;
   - copy the client ID and secret.
5. In Vercel add `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (Sensitive), then redeploy.

### Slack

1. At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From scratch**.
2. **OAuth & Permissions**:
   - redirect URL: `https://tryorbis.app/api/connectors/callback`;
   - **User Token Scopes**: `search:read` and `chat:write`.
3. **Manage Distribution**: activate public distribution so other workspaces can connect.
4. **Basic Information**: copy the Client ID and Client Secret into Vercel as `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`.

### Notion

1. In the [Notion developer portal](https://www.notion.so/profile/integrations), create a **public** connection.
   - Capabilities: **Read content** only.
   - Redirect URI: `https://tryorbis.app/api/connectors/callback`.
2. Copy the OAuth client ID and secret into Vercel as `NOTION_OAUTH_CLIENT_ID` and `NOTION_OAUTH_CLIENT_SECRET`.

### Microsoft (OneDrive, Outlook)

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), go to **App registrations → New registration**.
   - Supported account types: **any organizational directory and personal Microsoft accounts**.
   - Redirect URI (Web): `https://tryorbis.app/api/connectors/callback`.
2. **API permissions → Microsoft Graph → Delegated**: add `User.Read`, `offline_access`, `Files.Read`, `Mail.Read` and `Mail.ReadWrite`.
3. **Certificates & secrets → New client secret**.
4. In Vercel add `MICROSOFT_OAUTH_CLIENT_ID` (the Application ID) and `MICROSOFT_OAUTH_CLIENT_SECRET`.

### HubSpot

1. In a [HubSpot developer account](https://developers.hubspot.com/), create an app.
   - **Auth**: redirect URL `https://tryorbis.app/api/connectors/callback`.
   - Scopes: `oauth`, `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read`.
2. In Vercel add `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET`.

### Figma

1. Go to [figma.com/developers/apps](https://www.figma.com/developers/apps) → **Create a new app**.
   - Redirect URL: `https://tryorbis.app/api/connectors/callback`.
   - Scopes: `current_user:read`, `file_content:read`, `file_comments:read`.
2. In Vercel add `FIGMA_CLIENT_ID` and `FIGMA_CLIENT_SECRET`.

### GitHub

See docs/GITHUB.md. For issues and pull requests, give the app these permissions:

- **Issues**: Read (Read and write to open issues);
- **Pull requests**: Read.

## Adding a connector

1. Add a catalog entry in `catalog.ts`: id, name, category, capabilities, read and write scopes, data use, keywords, setup.
2. Implement a `Connector` in `providers/`:
   - an `oauth` config for the provider's flavour of OAuth;
   - an `account()` call;
   - a `health()` call;
   - read `tools`, each with a zod input and a short `args` description for the planner;
   - optional write `actions`, each with fields for the review card and a `describe()`.
3. Register it in `registry.ts`.
4. Add tests with a stand-in shaped like the official API's responses (see `tests/connectors.test.ts`).

The page, sign-in, storage, AI routing and confirmations then work for it unchanged.

## Testing

- `tests/connectors.test.ts` covers:
  - sealing, signing and the OAuth flow, including each provider's details and callback checks;
  - retries and error mapping;
  - every provider's tools against official-API-shaped stand-ins;
  - the AI routing (which apps a message needs, citations, honest failures, write actions offered only with permission, the action block).
- `tests/connectors-db.test.ts` covers row-level security and column grants on the real migrations, and the server's checks before a confirmed action.
- **Checked against the real services** (2026-10-21):
  - every endpoint used for Google Drive, Gmail, Calendar, Slack, Notion, OneDrive, Outlook, HubSpot and Figma answered an invalid token with an authentication error, confirming the addresses and the error mapping;
  - Wikipedia search and read worked against the live API.

## Not built yet

- **Background sync and webhooks:** everything is read live, so nothing is kept to sync.
- **Automated multi-step workflows across connectors.**
- **Reading PDFs and Office files.**
  - Drive can't export PDF text.
  - OneDrive's Word, Excel and PowerPoint files show up in searches but can't be read as text.
- **Wikipedia rate limits:** Wikipedia limits anonymous API traffic per address. Heavy use may need a Wikimedia API token.
