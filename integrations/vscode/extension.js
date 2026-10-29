// @ts-check
/* eslint-disable @typescript-eslint/no-require-imports -- VS Code loads extensions as CommonJS. */
/**
 * Orbis for VS Code: runs the Orbis terminal app (orbis-cli.mjs) in an integrated terminal, starts it with a
 * question about the selected code, and shows what the agent changed in its last turn as diffs, from the
 * snapshots the terminal app keeps in ~/.orbis/sessions. Plain JavaScript, no build step.
 */
const vscode = require("vscode");
const { latestSessionFor, lastChanges, orbisDir } = require("./sessions");

const SCHEME = "orbis-snapshot";
const MAX_SELECTION = 20_000;
const MAX_DIFFS = 20;
/** Snapshot contents by URI, for the diff views. */
const snapshots = new Map();

function folderFor(uri) {
  const f = uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
  return f ?? vscode.workspace.workspaceFolders?.[0] ?? null;
}

/** The command that starts the terminal app, from the settings. */
function cliCommand() {
  const cfg = vscode.workspace.getConfiguration("orbis");
  const cli = String(cfg.get("cliPath") || "").trim();
  const node = String(cfg.get("nodePath") || "node").trim();
  const q = (s) => (/^[\w./:@\\-]+$/.test(s) ? s : JSON.stringify(s));
  if (!cli) return "orbis";
  const cmd = /\.(mjs|js)$/i.test(cli) ? `${q(node)} ${q(cli)}` : q(cli);
  // PowerShell runs a quoted program only with the call operator.
  return process.platform === "win32" && cmd.startsWith('"') ? `& ${cmd}` : cmd;
}

/** Opens Orbis in a new terminal in the workspace folder; `initialPrompt` is its first message. */
function openTerminal(initialPrompt) {
  const folder = folderFor(vscode.window.activeTextEditor?.document.uri);
  if (!folder) {
    void vscode.window.showErrorMessage("Orbis works in a folder: open one first (File → Open Folder).");
    return;
  }
  const url = String(vscode.workspace.getConfiguration("orbis").get("url") || "").trim();
  const env = {};
  if (url) env.ORBIS_URL = url;
  // Passed in the environment, not on the command line, so no shell quoting can go wrong.
  if (initialPrompt) env.ORBIS_INITIAL_PROMPT = initialPrompt;
  const terminal = vscode.window.createTerminal({ name: "Orbis", cwd: folder.uri.fsPath, env });
  terminal.show();
  terminal.sendText(cliCommand());
}

async function askAboutSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showErrorMessage("Select some code in an editor first.");
    return;
  }
  const doc = editor.document;
  const sel = editor.selection;
  const range = sel.isEmpty ? doc.lineAt(sel.active.line).range : sel;
  let text = doc.getText(range);
  if (text.length > MAX_SELECTION) text = `${text.slice(0, MAX_SELECTION)}\n… (selection cut at ${MAX_SELECTION} characters)`;
  const start = range.start.line + 1;
  const end = range.end.line + 1;
  const where = `${vscode.workspace.asRelativePath(doc.uri, false)}:${start}${end !== start ? `-${end}` : ""}`;
  const question = await vscode.window.showInputBox({ title: `Ask Orbis about ${where}`, prompt: "Your question (Enter for an explanation)", placeHolder: "Why does this return undefined for empty lists?" });
  if (question === undefined) return;
  const fence = text.includes("```") ? "````" : "```";
  openTerminal(`${question.trim() || "Explain this code."}\n\nContext: ${where}, selected in the editor:\n${fence}${doc.languageId}\n${text}\n${fence}`);
}

async function reviewLastChanges() {
  const folder = folderFor(vscode.window.activeTextEditor?.document.uri);
  if (!folder) {
    void vscode.window.showErrorMessage("Open the folder Orbis worked in first.");
    return;
  }
  const session = latestSessionFor(folder.uri.fsPath, orbisDir());
  if (!session) {
    void vscode.window.showInformationMessage("No Orbis session for this folder yet.");
    return;
  }
  const changes = lastChanges(session);
  if (!changes) {
    void vscode.window.showInformationMessage("Orbis hasn't changed any files in this folder's latest session.");
    return;
  }
  const skipped = changes.files.filter((f) => f.tooLarge).map((f) => f.rel);
  const files = changes.files.filter((f) => !f.tooLarge).slice(0, MAX_DIFFS);
  const label = changes.text.split("\n")[0].slice(0, 60);
  for (const f of files) {
    const left = vscode.Uri.from({ scheme: SCHEME, path: `/${f.rel}`, query: `${session.id}:${changes.index}:before` });
    snapshots.set(left.toString(), f.before ?? "");
    let right;
    if (f.after === undefined) right = vscode.Uri.joinPath(folder.uri, f.rel);
    else {
      right = vscode.Uri.from({ scheme: SCHEME, path: `/${f.rel}`, query: `${session.id}:${changes.index}:after` });
      snapshots.set(right.toString(), f.after ?? "");
    }
    const state = f.created ? " (created)" : f.deleted ? " (deleted)" : "";
    await vscode.commands.executeCommand("vscode.diff", left, right, `${f.rel}${state} — Orbis: ${label}`, { preview: false });
  }
  const more = changes.files.length - skipped.length - files.length;
  void vscode.window.showInformationMessage(
    `Orbis changed ${changes.files.length} file${changes.files.length === 1 ? "" : "s"} for “${label}”.${more > 0 ? ` Showing the first ${files.length}.` : ""}${skipped.length ? ` Too large to have been kept: ${skipped.join(", ")}.` : ""}`,
  );
}

/** @param {import("vscode").ExtensionContext} context */
function activate(context) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: (uri) => snapshots.get(uri.toString()) ?? "" }),
    vscode.commands.registerCommand("orbis.openInTerminal", () => openTerminal()),
    vscode.commands.registerCommand("orbis.askAboutSelection", askAboutSelection),
    vscode.commands.registerCommand("orbis.reviewLastChanges", reviewLastChanges),
  );
}

function deactivate() {
  snapshots.clear();
}

module.exports = { activate, deactivate };
