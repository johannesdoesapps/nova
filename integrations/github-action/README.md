# Orbis GitHub Action

Runs the Orbis coding agent on your repository inside a GitHub Actions job, using the terminal app
(`orbis -p`, see [docs/ORBIS_CLI.md](../../docs/ORBIS_CLI.md)), and can post its answer as a comment on the
pull request or issue.

The agent loop and its tools run on the Actions runner, in the checked-out repository. Only the model calls go
to your Orbis site, which meters them against the plan of the account whose token you use.

## Setup

1. On your computer, sign in and print a refresh token for CI:

   ```sh
   node orbis-cli.mjs token --url https://your-orbis-site
   ```

   This opens a new, separate session (your computer's sign-in isn't affected) and prints its refresh token.

2. In the repository: **Settings → Secrets and variables → Actions**
   - variable `ORBIS_URL`: your Orbis site, e.g. `https://orbis.example.com`
   - secret `ORBIS_REFRESH_TOKEN`: the token from step 1
   - secret `ORBIS_SECRETS_TOKEN` (strongly recommended, see "Token rotation"): a fine-grained personal access
     token for this repository with **Secrets: Read and write**

3. Copy [`examples/orbis-mention.yml`](examples/orbis-mention.yml) to `.github/workflows/orbis.yml`. Point its
   `uses:` at this folder: `./integrations/github-action` in the Orbis repository itself, or
   `<owner>/<repo>/integrations/github-action@<tag>` from another repository (or copy the folder into
   `.github/actions/orbis` and use `./.github/actions/orbis`).

Now a comment like `@orbis the date picker test fails on Safari, please fix it` on a pull request makes Orbis
work on the pull request's branch, push a commit (not for pull requests from forks) and reply in the thread. On
an issue it opens a pull request with its changes.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `prompt` | (required) | What Orbis should do. |
| `orbis-url` | (required) | Your Orbis site. The terminal app is downloaded from `<orbis-url>/downloads/orbis-cli.mjs`. |
| `refresh-token` | (required) | Pass `${{ secrets.ORBIS_REFRESH_TOKEN }}`. |
| `permission-mode` | `acceptEdits` | `default` (reads and safe commands only), `acceptEdits` (plus file edits), `plan` (read-only), `bypass`. |
| `allowed-tools` | | Extra allow rules, e.g. `bash(npm ci),bash(npm run lint*)`. Anything not allowed is denied (there's no one to ask). |
| `disallowed-tools` | `bash(git push*)` | Extra deny rules. A bare tool name (`web_fetch`) hides the tool. |
| `max-turns` | `40` | Stops after this many model turns (the step then fails). |
| `model` | Auto | A model id from your site (`/api/cli/config` lists them). |
| `working-directory` | `.` | |
| `trust-project` | `false` | Use the repository's `.orbis` hooks, MCP servers and allow rules. |
| `comment` | `true` | Post the answer on the pull request / issue. |
| `issue-number` | the triggering one | |
| `github-token` | `github.token` | For the comment. |
| `secret-update-token` | | Writes the rotated refresh token back to `secret-name`. |
| `secret-name` | `ORBIS_REFRESH_TOKEN` | |
| `cli-sha256` | | Pin the downloaded app to a known checksum. |

Outputs: `result` (the answer), `session-id`, `exit-code`.

## Token rotation

Orbis signs in with Supabase Auth, which **rotates refresh tokens**: using one returns a new one and retires the
old. A token stored as a secret therefore works for one run unless the new token is stored again. With
`secret-update-token` set, the action does that after every run (`gh secret set`); keep the workflow's
`concurrency` group so two runs never use the same token. If a run fails with "Your sign-in has expired or was
revoked", create a new token with `orbis token` and update the secret.

## Security

- **Who can trigger it.** The example only reacts to `OWNER`, `MEMBER` and `COLLABORATOR` comments and then
  checks the commenter's actual permission (write, maintain or admin) through the API.
- **Untrusted content.** Pull request code, issue text and comments are data the agent reads; a hostile one can
  try to steer it ("prompt injection"). Keep `permission-mode` at `acceptEdits` or stricter, allow only the
  commands you need, keep `bash(git push*)` denied (the workflow pushes, not the agent) and never use `bypass` on
  input from outsiders.
- **`trust-project`.** With it, `.orbis/settings.json` hooks and `.orbis/mcp.json` servers from the checked-out
  code run on the runner. Leave it off for pull requests from forks: their code could run with your secrets.
- The agent's commands never see `ORBIS_REFRESH_TOKEN` (the terminal app removes it from their environment), but
  any other secret you put in the job's environment is visible to them.
- The comment is posted with the job's `GITHUB_TOKEN`; the refresh token is never printed.
