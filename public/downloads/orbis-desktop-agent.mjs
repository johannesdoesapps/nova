#!/usr/bin/env node
/**
 * Orbis Desktop Agent — lets Orbis Jarvis Mode act on this computer, within limits you set.
 *
 *   node orbis-desktop-agent.mjs [--allow <folder>]... [--origin <https://site>]... [--port 47821]
 *
 * - Listens only on 127.0.0.1 and answers only Orbis's own web address (Origin and Host are checked).
 * - Pairs with a 6-digit code shown here; the browser then holds a token that lasts until this process stops.
 * - Reaches only the folders you allow (by default Downloads, Documents and Desktop).
 * - Never deletes or overwrites files, never runs shell commands, and logs every change it makes
 *   (~/.orbis-agent/operations.jsonl: paths and outcomes only, never file contents).
 * - Runs one action at a time. "Stop" (the emergency stop in Orbis) refuses every action until you resume.
 *
 * No dependencies: Node.js 20 or newer.
 */
import http from "node:http";
import fs from "node:fs/promises";
import { constants as FS, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const DEFAULT_PORT = 47821;
export const DEFAULT_ORIGINS = ["https://tryorbis.app", "https://www.tryorbis.app"];
const MAX_BODY = 1_000_000;
const PAIR_TTL_MS = 10 * 60_000;
const MAX_PAIR_ATTEMPTS = 5;
const MAX_LIST = 500;
const MAX_FIND_RESULTS = 200;
const MAX_FIND_SCANNED = 5000;
const MAX_ORGANIZE = 500;
const PARTIAL_DOWNLOAD = /\.(crdownload|part|partial|download|tmp)$/i;

export const TOOLS = [
  "open_application",
  "open_path",
  "list_directory",
  "find_files",
  "create_directory",
  "move_file",
  "copy_file",
  "rename_file",
  "organize_preview",
  "organize_apply",
  "undo_last_change",
  "system_info",
];

export const CATEGORIES = {
  Images: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "svg", "bmp", "tif", "tiff", "avif", "ico", "raw", "cr2", "nef"],
  PDFs: ["pdf"],
  Documents: ["doc", "docx", "odt", "rtf", "txt", "md", "pages", "tex", "epub"],
  Spreadsheets: ["xls", "xlsx", "ods", "csv", "tsv", "numbers"],
  Presentations: ["ppt", "pptx", "odp", "key"],
  Archives: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"],
  Audio: ["mp3", "wav", "aac", "flac", "m4a", "ogg", "aiff", "opus"],
  Video: ["mp4", "mov", "avi", "mkv", "webm", "m4v", "wmv", "flv"],
  Code: ["js", "mjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "c", "cpp", "h", "cs", "php", "html", "css", "json", "xml", "yml", "yaml", "sh", "ipynb", "sql"],
  Installers: ["dmg", "pkg", "exe", "msi", "deb", "rpm", "appimage", "apk"],
};
const CATEGORY_NAMES = [...Object.keys(CATEGORIES), "Other"];

export function categoryFor(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  for (const [cat, exts] of Object.entries(CATEGORIES)) if (exts.includes(ext)) return cat;
  return "Other";
}

const result = (outcome, summary, verified = null, details) => ({ outcome, summary, verified, ...(details ? { details } : {}) });
const fail = (summary, outcome = "failure") => result(outcome, summary, null);
class Refused extends Error {}

/** Reads command-line options. */
export function parseArgs(argv, home = os.homedir()) {
  const opts = { port: DEFAULT_PORT, roots: [], origins: [...DEFAULT_ORIGINS], dataDir: path.join(home, ".orbis-agent") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value.`);
      return v;
    };
    if (a === "--allow") opts.roots.push(next());
    else if (a === "--origin") opts.origins.push(new URL(next()).origin);
    else if (a === "--port") opts.port = Number(next());
    else if (a === "--data") opts.dataDir = next();
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown option ${a}. Try --help.`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535) throw new Error("--port must be between 1024 and 65535.");
  if (!opts.roots.length) opts.roots = ["Downloads", "Documents", "Desktop"].map((d) => path.join(home, d)).filter((d) => existsSync(d));
  return opts;
}

function execFileP(file, args, { timeout = 15_000, signal } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, signal, windowsHide: true }, (error, stdout, stderr) => resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

/**
 * The agent itself, without the HTTP server: the allowed folders, the tools and the operation log.
 * `exec` runs a program without a shell (tests replace it).
 */
export async function createAgent({ roots, dataDir, platform = process.platform, home = os.homedir(), exec = execFileP }) {
  const caseless = platform === "darwin" || platform === "win32";
  const norm = (p) => (caseless ? p.toLowerCase() : p);
  const allowed = [];
  for (const r of roots) {
    const abs = path.resolve(r.startsWith("~") ? path.join(home, r.slice(1)) : r);
    try {
      const real = realpathSync(abs);
      if ((await fs.stat(real)).isDirectory()) allowed.push(real);
    } catch {
      /* missing folders are skipped */
    }
  }
  await fs.mkdir(dataDir, { recursive: true });
  const logFile = path.join(dataDir, "operations.jsonl");
  let halted = false;
  let queue = Promise.resolve();

  const tilde = (p) => (norm(p).startsWith(norm(home + path.sep)) ? `~${p.slice(home.length)}` : p);
  const inside = (real) => allowed.some((r) => norm(real) === norm(r) || norm(real).startsWith(norm(r + path.sep)));
  const isRoot = (real) => allowed.some((r) => norm(real) === norm(r));

  /** A path the user gave → a real absolute path inside an allowed folder, or a refusal. */
  async function resolveInside(p, { mustExist = true } = {}) {
    if (typeof p !== "string" || !p.trim() || p.includes("\0")) throw new Refused("That isn't a valid path.");
    let s = p.trim();
    if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(home, s.slice(1));
    if (!path.isAbsolute(s)) throw new Refused(`Use a full path or one starting with ~ (got “${p}”).`);
    const abs = path.resolve(s);
    let real;
    try {
      real = await fs.realpath(abs);
    } catch {
      if (mustExist) {
        // Report "outside" before "missing", so nothing about other folders is revealed.
        const parent = await nearestExisting(abs);
        if (!inside(parent.real)) throw new Refused(`${p} is outside the folders this agent may use.`);
        throw new Refused(`${tilde(abs)} doesn't exist.`);
      }
      const parent = await nearestExisting(abs);
      real = path.join(parent.real, path.relative(parent.abs, abs));
    }
    if (!inside(real)) throw new Refused(`${p} is outside the folders this agent may use.`);
    return real;
  }

  async function nearestExisting(abs) {
    let cur = abs;
    for (;;) {
      try {
        return { abs: cur, real: await fs.realpath(cur) };
      } catch {
        const up = path.dirname(cur);
        if (up === cur) return { abs: cur, real: cur };
        cur = up;
      }
    }
  }

  const exists = async (p) => !!(await fs.lstat(p).catch(() => null));

  async function log(entry) {
    await fs.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  }

  async function readLog() {
    const text = await fs.readFile(logFile, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /** Move without overwriting; across drives, a file is copied, checked and only then removed from its old place. */
  async function moveNoOverwrite(from, to) {
    if (await exists(to)) throw new Refused(`Something already exists at ${tilde(to)}.`);
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.rename(from, to);
    } catch (err) {
      if (err.code !== "EXDEV") throw err;
      const st = await fs.stat(from);
      if (!st.isFile()) throw new Refused("Moving a folder to another drive isn't supported; move its files instead.");
      await fs.copyFile(from, to, FS.COPYFILE_EXCL);
      if ((await fs.stat(to)).size !== st.size) throw new Error("The copy didn't match the original; the original was kept.");
      await fs.unlink(from);
    }
    return (await exists(to)) && !(await exists(from));
  }

  async function organizePreview(folder) {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const moves = [];
    const skipped = [];
    for (const e of entries) {
      if (moves.length >= MAX_ORGANIZE) {
        skipped.push({ name: "…", reason: `only ${MAX_ORGANIZE} files are sorted at a time` });
        break;
      }
      if (!e.isFile() || e.name.startsWith(".")) continue;
      if (PARTIAL_DOWNLOAD.test(e.name)) {
        skipped.push({ name: e.name, reason: "still downloading" });
        continue;
      }
      const cat = categoryFor(e.name);
      const to = path.join(folder, cat, e.name);
      if (await exists(to)) skipped.push({ name: e.name, reason: `${cat}/${e.name} already exists` });
      else moves.push({ from: path.join(folder, e.name), to });
    }
    return { moves, skipped };
  }

  const tools = {
    async list_directory({ path: p }) {
      const dir = await resolveInside(p);
      const entries = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith("."));
      const items = [];
      for (const e of entries.slice(0, MAX_LIST)) {
        const kind = e.isDirectory() ? "folder" : e.isFile() ? "file" : "other";
        const size = kind === "file" ? (await fs.stat(path.join(dir, e.name)).catch(() => null))?.size : undefined;
        items.push({ name: e.name, kind, ...(size !== undefined ? { size } : {}) });
      }
      const files = items.filter((i) => i.kind === "file").length;
      return result("success", `${tilde(dir)} has ${files} file${files === 1 ? "" : "s"} and ${items.length - files} other item${items.length - files === 1 ? "" : "s"}${entries.length > MAX_LIST ? ` (first ${MAX_LIST} shown)` : ""}.`, true, {
        kind: "files",
        folder: tilde(dir),
        items,
        truncated: entries.length > MAX_LIST,
      });
    },

    async find_files({ folder, name, extensions, min_size_mb }) {
      const root = await resolveInside(folder);
      const exts = (extensions ?? []).map((x) => String(x).replace(/^\./, "").toLowerCase());
      const needle = name ? String(name).toLowerCase() : "";
      const minBytes = min_size_mb ? Number(min_size_mb) * 1024 * 1024 : 0;
      const found = [];
      let scanned = 0;
      const queue = [{ dir: root, depth: 0 }];
      while (queue.length && found.length < MAX_FIND_RESULTS && scanned < MAX_FIND_SCANNED) {
        const { dir, depth } = queue.shift();
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (++scanned > MAX_FIND_SCANNED || found.length >= MAX_FIND_RESULTS) break;
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (depth < 4) queue.push({ dir: full, depth: depth + 1 });
            continue;
          }
          if (!e.isFile()) continue;
          if (needle && !e.name.toLowerCase().includes(needle)) continue;
          if (exts.length && !exts.includes(path.extname(e.name).slice(1).toLowerCase())) continue;
          const size = (await fs.stat(full).catch(() => null))?.size ?? 0;
          if (size < minBytes) continue;
          found.push({ name: e.name, kind: "file", size, path: tilde(full) });
        }
      }
      const capped = found.length >= MAX_FIND_RESULTS || scanned >= MAX_FIND_SCANNED;
      return result("success", `Found ${found.length} matching file${found.length === 1 ? "" : "s"} in ${tilde(root)}${capped ? " (the search stopped early; narrow it down for more)" : ""}.`, true, {
        kind: "files",
        folder: tilde(root),
        items: found,
        truncated: capped,
      });
    },

    async create_directory({ path: p }) {
      const dir = await resolveInside(p, { mustExist: false });
      const st = await fs.stat(dir).catch(() => null);
      if (st?.isDirectory()) return result("success", `${tilde(dir)} already existed.`, true);
      if (st) return fail(`${tilde(dir)} exists and isn't a folder.`);
      await fs.mkdir(dir, { recursive: true });
      await log({ type: "mkdir", path: dir, batch: crypto.randomUUID() });
      const ok = !!(await fs.stat(dir).catch(() => null))?.isDirectory();
      return result(ok ? "success" : "failure", ok ? `Created ${tilde(dir)}.` : `Couldn't confirm ${tilde(dir)} was created.`, ok);
    },

    async move_file({ from, to }) {
      const src = await resolveInside(from);
      if (isRoot(src)) throw new Refused("An allowed folder itself can't be moved.");
      const dst = await resolveInside(to, { mustExist: false });
      const batch = crypto.randomUUID();
      const ok = await moveNoOverwrite(src, dst);
      await log({ type: "move", from: src, to: dst, batch, ok });
      return result(ok ? "success" : "failure", ok ? `Moved ${tilde(src)} to ${tilde(dst)}.` : `The move of ${tilde(src)} couldn't be confirmed.`, ok);
    },

    async copy_file({ from, to }) {
      const src = await resolveInside(from);
      const dst = await resolveInside(to, { mustExist: false });
      if (await exists(dst)) throw new Refused(`Something already exists at ${tilde(dst)}.`);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.cp(src, dst, { recursive: true, errorOnExist: true, force: false });
      const ok = await exists(dst);
      await log({ type: "copy", from: src, to: dst, batch: crypto.randomUUID(), ok });
      return result(ok ? "success" : "failure", ok ? `Copied ${tilde(src)} to ${tilde(dst)}.` : "The copy couldn't be confirmed.", ok);
    },

    async rename_file({ path: p, new_name }) {
      const src = await resolveInside(p);
      if (isRoot(src)) throw new Refused("An allowed folder itself can't be renamed.");
      if (typeof new_name !== "string" || !new_name.trim() || /[/\\\0]/.test(new_name) || new_name === "." || new_name === "..") throw new Refused("Give a new name, not a path.");
      const dst = await resolveInside(path.join(path.dirname(src), new_name.trim()), { mustExist: false });
      const ok = await moveNoOverwrite(src, dst);
      await log({ type: "move", from: src, to: dst, batch: crypto.randomUUID(), ok });
      return result(ok ? "success" : "failure", ok ? `Renamed ${path.basename(src)} to ${path.basename(dst)}.` : "The rename couldn't be confirmed.", ok);
    },

    async organize_preview({ path: p }) {
      const folder = await resolveInside(p);
      if (!(await fs.stat(folder)).isDirectory()) return fail(`${tilde(folder)} isn't a folder.`);
      const { moves, skipped } = await organizePreview(folder);
      const cats = new Set(moves.map((m) => path.basename(path.dirname(m.to))));
      return result(
        "success",
        moves.length ? `${moves.length} file${moves.length === 1 ? "" : "s"} in ${tilde(folder)} would move into ${cats.size} folder${cats.size === 1 ? "" : "s"}.` : `Nothing to sort in ${tilde(folder)}.`,
        true,
        { kind: "moves", moves: moves.map((m) => ({ from: tilde(m.from), to: tilde(m.to) })), skipped },
      );
    },

    /** Applies exactly the moves that were approved, after checking each is still the same sort of move. */
    async organize_apply({ path: p, moves }) {
      const folder = await resolveInside(p);
      if (!Array.isArray(moves) || !moves.length || moves.length > MAX_ORGANIZE) throw new Refused("No moves to apply.");
      const checked = [];
      for (const m of moves) {
        const from = await resolveInside(m?.from);
        const to = await resolveInside(m?.to, { mustExist: false });
        const cat = path.basename(path.dirname(to));
        if (norm(path.dirname(from)) !== norm(folder) || norm(path.dirname(path.dirname(to))) !== norm(folder) || !CATEGORY_NAMES.includes(cat) || path.basename(to) !== path.basename(from))
          throw new Refused(`${m?.from} → ${m?.to} isn't a sorting move inside ${tilde(folder)}.`);
        checked.push({ from, to });
      }
      const batch = crypto.randomUUID();
      const created = new Set();
      let moved = 0;
      const problems = [];
      for (const m of checked) {
        try {
          const dir = path.dirname(m.to);
          if (!(await exists(dir))) {
            await fs.mkdir(dir, { recursive: true });
            created.add(dir);
            await log({ type: "mkdir", path: dir, batch });
          }
          const ok = await moveNoOverwrite(m.from, m.to);
          await log({ type: "move", from: m.from, to: m.to, batch, ok });
          if (ok) moved++;
          else problems.push(`${path.basename(m.from)}: not confirmed`);
        } catch (err) {
          problems.push(`${path.basename(m.from)}: ${err instanceof Refused ? err.message : err.code ?? "failed"}`);
        }
      }
      const cats = new Set(checked.map((m) => path.basename(path.dirname(m.to))));
      const summary = `Moved ${moved} of ${checked.length} file${checked.length === 1 ? "" : "s"} in ${tilde(folder)} into ${cats.size} folder${cats.size === 1 ? "" : "s"}; nothing was deleted.${problems.length ? ` Not moved: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "; …" : ""}.` : ""}`;
      return result(moved === checked.length ? "success" : moved ? "partial" : "failure", summary, moved === checked.length);
    },

    async undo_last_change() {
      const entries = await readLog();
      const undone = new Set(entries.filter((e) => e.type === "undo").map((e) => e.batch));
      const last = [...entries].reverse().find((e) => (e.type === "move" || e.type === "mkdir") && !undone.has(e.batch));
      if (!last) return fail("There's no change to undo.");
      const ops = entries.filter((e) => e.batch === last.batch && (e.type === "mkdir" || (e.type === "move" && e.ok))).reverse();
      let restored = 0;
      const problems = [];
      for (const op of ops) {
        if (op.type === "move") {
          if (!inside(op.to) || !inside(op.from)) {
            problems.push(`${path.basename(op.to)}: outside the allowed folders now`);
            continue;
          }
          if (!(await exists(op.to))) problems.push(`${path.basename(op.to)}: no longer where it was moved`);
          else if (await exists(op.from)) problems.push(`${path.basename(op.from)}: something is back in its old place`);
          else {
            await fs.rename(op.to, op.from);
            restored++;
          }
        } else if (op.type === "mkdir" && inside(op.path)) {
          // Only folders this agent created, and only when empty again.
          await fs.rmdir(op.path).catch(() => {});
        }
      }
      await log({ type: "undo", batch: last.batch, restored });
      const moves = ops.filter((o) => o.type === "move").length;
      if (!moves) return result("success", "Removed the folder that was created, if it was still empty.", null);
      return result(problems.length ? (restored ? "partial" : "failure") : "success", `Put back ${restored} of ${moves} item${moves === 1 ? "" : "s"}.${problems.length ? ` Not restored: ${problems.slice(0, 5).join("; ")}.` : ""}`, problems.length === 0);
    },

    async open_application({ name }) {
      if (typeof name !== "string" || !/^[\w .+&()-]{1,60}$/.test(name)) throw new Refused("Use the app's plain name.");
      if (platform === "darwin") {
        const r = await exec("open", ["-a", name]);
        if (!r.ok) return fail(`Couldn't find an app called “${name}”.`);
        await new Promise((res) => setTimeout(res, 1200));
        const check = await exec("osascript", ["-e", `application "${name}" is running`]);
        const running = check.ok && check.stdout.trim() === "true";
        return result("success", running ? `Opened ${name}.` : `Asked macOS to open ${name}.`, check.ok ? running : null);
      }
      if (platform === "win32") {
        const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${name}'`]);
        return r.ok ? result("success", `Asked Windows to open ${name}.`, null) : fail(`Couldn't find an app called “${name}”.`);
      }
      return fail("Opening apps by name isn't supported on this system yet.", "unsupported");
    },

    async open_path({ path: p }) {
      const target = await resolveInside(p);
      const [cmd, args] = platform === "darwin" ? ["open", [target]] : platform === "win32" ? ["explorer.exe", [target]] : ["xdg-open", [target]];
      const r = await exec(cmd, args);
      // Explorer reports exit code 1 even when it opened the item.
      return r.ok || platform === "win32" ? result("success", `Opened ${tilde(target)}.`, null) : fail(`Couldn't open ${tilde(target)}.`);
    },

    async system_info() {
      const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;
      const rows = [
        { label: "System", value: `${os.type()} ${os.release()} (${os.arch()})` },
        { label: "Processors", value: String(os.cpus().length) },
        { label: "Memory", value: `${gb(os.freemem())} free of ${gb(os.totalmem())}` },
        { label: "Up for", value: `${Math.round(os.uptime() / 3600)} hours` },
      ];
      for (const r of allowed) {
        const s = await fs.statfs(r).catch(() => null);
        if (s) rows.push({ label: `Free space (${tilde(r)})`, value: gb(s.bavail * s.bsize) });
      }
      const battery = await batteryLevel();
      if (battery) rows.push({ label: "Battery", value: battery });
      return result("success", `${os.type()} ${os.release()}, ${gb(os.freemem())} memory free${battery ? `, battery ${battery}` : ""}.`, true, { kind: "info", rows });
    },
  };

  async function batteryLevel() {
    if (platform === "darwin") {
      const r = await exec("pmset", ["-g", "batt"], { timeout: 3000 });
      return r.stdout.match(/(\d+)%/)?.[0] ?? null;
    }
    if (platform === "win32") {
      const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Battery).EstimatedChargeRemaining"], { timeout: 5000 });
      const n = r.stdout.trim().match(/^\d+$/)?.[0];
      return n ? `${n}%` : null;
    }
    const n = (await fs.readFile("/sys/class/power_supply/BAT0/capacity", "utf8").catch(() => "")).trim();
    return /^\d+$/.test(n) ? `${n}%` : null;
  }

  /** Runs one tool, one at a time, and turns refusals and errors into plain results. */
  function run(name, args) {
    const task = queue.then(async () => {
      if (halted) return fail("Automation is stopped. Resume it in Orbis before Jarvis acts again.", "permission_denied");
      if (!Object.hasOwn(tools, name)) return fail(`Unknown tool “${String(name).slice(0, 40)}”.`, "unsupported");
      try {
        return await tools[name](args && typeof args === "object" ? args : {});
      } catch (err) {
        if (err instanceof Refused) return fail(err.message, "permission_denied");
        const code = err?.code;
        return fail(code === "EACCES" || code === "EPERM" ? "The system denied access to that file or folder." : code === "ENOENT" ? "That file or folder doesn't exist." : "The action failed.");
      }
    });
    queue = task.catch(() => {});
    return task;
  }

  return {
    folders: allowed.map(tilde),
    tools: TOOLS,
    platform,
    run,
    readLog,
    get halted() {
      return halted;
    },
    halt() {
      halted = true;
    },
    resume() {
      halted = false;
    },
  };
}

/**
 * The HTTP side: pairing, Origin and Host checks, and the endpoints Orbis calls.
 * @param {Awaited<ReturnType<typeof createAgent>>} agent
 * @param {{ port: number; origins: string[]; onPairCode?: (code: string) => void; now?: () => number }} opts
 */
export function createServer(agent, { port, origins, onPairCode = () => {}, now = Date.now }) {
  let token = null;
  let pair = null;
  const newCode = () => {
    pair = { code: String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"), expires: now() + PAIR_TTL_MS, attempts: 0 };
    onPairCode(pair.code);
    return pair.code;
  };
  newCode();
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, body) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...(origin && origins.includes(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
      });
      res.end(JSON.stringify(body));
    };
    // DNS rebinding: only our own address. Other websites: only Orbis may call.
    if (!hosts.has(String(req.headers.host))) return send(403, { error: "Wrong host." });
    if (origin && !origins.includes(origin)) return send(403, { error: "This site may not use the Orbis Desktop Agent." });
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": origin ?? "",
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type, authorization",
        "access-control-allow-private-network": "true",
        "access-control-max-age": "600",
        vary: "Origin",
      });
      return res.end();
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authed = !!token && same(String(req.headers.authorization ?? ""), `Bearer ${token}`);

    let body = {};
    if (req.method === "POST") {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, { error: "Send JSON." });
      let size = 0;
      const chunks = [];
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) return send(413, { error: "Too large." });
        chunks.push(c);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return send(400, { error: "Invalid JSON." });
      }
    }

    const info = () => ({ name: "Orbis Desktop Agent", version: VERSION, platform: agent.platform, folders: agent.folders, tools: agent.tools, halted: agent.halted });
    if (req.method === "GET" && url.pathname === "/status") return send(200, { name: "Orbis Desktop Agent", version: VERSION, platform: agent.platform, paired: !!token, halted: agent.halted });
    if (req.method === "POST" && url.pathname === "/pair") {
      if (!pair || now() > pair.expires) {
        newCode();
        return send(401, { error: "That code has expired. Use the new code in the agent's window." });
      }
      if (!same(String(body.code ?? ""), pair.code)) {
        if (++pair.attempts >= MAX_PAIR_ATTEMPTS) newCode();
        return send(401, { error: "That code doesn't match. Check the code in the agent's window." });
      }
      // One paired browser at a time: pairing again (with a new code) replaces this token.
      token = crypto.randomBytes(32).toString("hex");
      pair = null;
      return send(200, { token, ...info() });
    }
    if (!authed) return send(401, { error: "Pair this browser with the agent first." });
    if (req.method === "GET" && url.pathname === "/info") return send(200, info());
    if (req.method === "POST" && url.pathname === "/tool") return send(200, await agent.run(body.tool, body.args));
    if (req.method === "POST" && url.pathname === "/halt") {
      agent.halt();
      return send(200, info());
    }
    if (req.method === "POST" && url.pathname === "/resume") {
      agent.resume();
      return send(200, info());
    }
    if (req.method === "POST" && url.pathname === "/unpair") {
      token = null;
      return send(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/log") return send(200, { entries: (await agent.readLog()).slice(-100) });
    return send(404, { error: "Not found." });
  });
  return server;
}

const HELP = `Orbis Desktop Agent ${VERSION}

  node orbis-desktop-agent.mjs [options]

  --allow <folder>   A folder Jarvis may use (repeat for more). Default: Downloads, Documents, Desktop.
  --origin <url>     Another Orbis address allowed to connect (e.g. http://localhost:3000 for development).
  --port <n>         Port on 127.0.0.1 (default ${DEFAULT_PORT}).
  --data <folder>    Where the operation log is kept (default ~/.orbis-agent).
`;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) return console.log(HELP);
  const agent = await createAgent({ roots: opts.roots, dataDir: opts.dataDir });
  if (!agent.folders.length) console.warn("No allowed folders exist; file tools will refuse everything. Use --allow <folder>.");
  const server = createServer(agent, {
    port: opts.port,
    origins: opts.origins,
    onPairCode: (code) => console.log(`\nPairing code: ${code}  (enter it in Orbis → Jarvis → Desktop Agent; valid 10 minutes)\n`),
  });
  server.listen(opts.port, "127.0.0.1", () => {
    console.log(`Orbis Desktop Agent ${VERSION} on http://127.0.0.1:${opts.port} (${agent.platform})`);
    console.log(`Allowed folders: ${agent.folders.join(", ") || "none"}`);
    console.log(`Accepting Orbis at: ${opts.origins.join(", ")}`);
    console.log("Press Ctrl+C to stop. Nothing is deleted or overwritten; changes are logged in", path.join(opts.dataDir, "operations.jsonl"));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) void main();
