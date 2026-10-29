// @ts-check
/* eslint-disable @typescript-eslint/no-require-imports -- VS Code loads extensions as CommonJS. */
/**
 * Reading the Orbis terminal app's saved sessions (~/.orbis/sessions/<id>.json): the latest one for a folder and
 * the files its last changing turn touched, before and after. No VS Code APIs here, so it can be tested on its own.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/** ~/.orbis, or ORBIS_HOME (the same rule as the terminal app). */
function orbisDir(env = process.env) {
  return env.ORBIS_HOME ? path.resolve(env.ORBIS_HOME) : path.join(os.homedir(), ".orbis");
}

/** The most recently updated session whose folder is `folder`, or null. */
function latestSessionFor(folder, dir = orbisDir()) {
  let real = folder;
  try {
    real = fs.realpathSync(folder);
  } catch {
    /* compare as given */
  }
  const sessions = path.join(dir, "sessions");
  let names = [];
  try {
    names = fs.readdirSync(sessions).filter((n) => n.endsWith(".json"));
  } catch {
    return null;
  }
  let best = null;
  for (const n of names) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(path.join(sessions, n), "utf8"));
    } catch {
      continue;
    }
    if (!s || s.cwd !== real) continue;
    if (!best || String(s.updatedAt) > String(best.updatedAt)) best = s;
  }
  return best;
}

/**
 * The files changed in the latest turn that changed any: { index, text, files: [{ rel, before, after, ... }] }.
 * `before` null: the file was created. `after` null: it was deleted; undefined: not kept (read the file on disk).
 */
function lastChanges(session) {
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const entries = Object.entries(turns[i].files ?? {});
    if (!entries.length) continue;
    return {
      index: i,
      text: String(turns[i].text ?? ""),
      files: entries.map(([rel, snap]) => ({
        rel,
        before: snap.before === undefined ? null : snap.before,
        after: snap.after,
        tooLarge: !!snap.tooLarge,
        created: snap.before === null,
        deleted: snap.after === null,
      })),
    };
  }
  return null;
}

module.exports = { orbisDir, latestSessionFor, lastChanges };
