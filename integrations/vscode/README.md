# Orbis for VS Code

A small extension around the Orbis terminal app (`orbis-cli.mjs`, see
[docs/ORBIS_CLI.md](../../docs/ORBIS_CLI.md)). The agent itself runs in VS Code's integrated terminal; the
extension starts it in the right folder, hands it a question about the code you selected, and shows what it
changed.

## Commands

| Command | |
| --- | --- |
| **Orbis: Open in terminal** (`Ctrl+Alt+O` / `Cmd+Alt+O`) | Starts Orbis in a new terminal in the workspace folder. |
| **Orbis: Ask about selection** (also in the editor's right-click menu) | Asks for your question, then starts Orbis with it, the file and line range, and the selected code as its first message. |
| **Orbis: Review last changes** | Reads the latest Orbis session for this folder from `~/.orbis/sessions` and opens a diff (before → after) for each file the agent changed in its last turn that changed files, from the snapshots the terminal app keeps for `/rewind`. |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `orbis.cliPath` | empty | Path to `orbis-cli.mjs` (run with Node) or to an `orbis` executable. Empty: the `orbis` command on your PATH. |
| `orbis.url` | empty | Your Orbis site, passed as `ORBIS_URL`. Empty: the site you signed in to with `orbis login`. |
| `orbis.nodePath` | `node` | Node.js 20 or newer. |

Sign in once in any terminal: `node orbis-cli.mjs login --url https://your-orbis-site`.

## Install

There's no build step. To try it from this folder: open `integrations/vscode` in VS Code and press F5 (Run
Extension). To make an installable package:

```sh
cd integrations/vscode
npx @vscode/vsce package          # creates orbis-vscode-0.1.0.vsix
code --install-extension orbis-vscode-0.1.0.vsix
```

## Notes

- The question and selection reach the terminal app through the `ORBIS_INITIAL_PROMPT` environment variable
  (not the command line, so nothing needs shell quoting). The selection is cut at 20,000 characters.
- "Review last changes" shows the agent's own snapshots. Changes made by commands it ran (`bash`) aren't
  snapshotted; use the Source Control view for those.
- The extension never reads `~/.orbis/credentials.json` and sends nothing anywhere.

License: the same terms as the Orbis repository it ships in.
