/**
 * Orbis Desktop Agent: folder limits (including symlink escapes), the file tools (never deleting or
 * overwriting), sorting a folder from an approved list, undo, the emergency stop, app launching without a shell,
 * and the HTTP layer (Host and Origin checks, pairing, tokens, Private Network Access).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { categoryFor, createAgent, createServer, parseArgs } from "../public/downloads/orbis-desktop-agent.mjs";

let base: string;
let home: string;
let allowed: string;
let outside: string;

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "orbis-agent-"));
afterAll(() => fs.rm(temp, { recursive: true, force: true }));

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(temp, "t-"));
  home = path.join(base, "home");
  allowed = path.join(home, "Downloads");
  outside = path.join(home, "Private");
  await fs.mkdir(allowed, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  for (const f of ["report.pdf", "photo.JPG", "notes.md", "budget.xlsx", "song.mp3", "setup.dmg", "mystery.xyz", "big.zip.crdownload", ".hidden"]) await fs.writeFile(path.join(allowed, f), f);
});

const make = async (over: Record<string, unknown> = {}) =>
  createAgent({ roots: ["~/Downloads"], dataDir: path.join(base, "data"), platform: "linux", home, ...over });
const files = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) out.push(...(e.isDirectory() ? (await files(path.join(dir, e.name))).map((f) => `${e.name}/${f}`) : [e.name]));
  return out.sort();
};

describe("folders", () => {
  it("reaches only the allowed folders", async () => {
    const a = await make();
    expect(a.folders).toEqual(["~/Downloads"]);
    expect(await a.run("list_directory", { path: "~/Private" })).toMatchObject({ outcome: "permission_denied", summary: "~/Private is outside the folders this agent may use." });
    expect(await a.run("list_directory", { path: "~/Downloads/../Private" })).toMatchObject({ outcome: "permission_denied" });
    expect(await a.run("list_directory", { path: "Downloads" })).toMatchObject({ outcome: "permission_denied", summary: expect.stringMatching(/full path/) });
    expect(await a.run("move_file", { from: "~/Private/secret.txt", to: "~/Downloads/secret.txt" })).toMatchObject({ outcome: "permission_denied" });
    expect(await a.run("move_file", { from: "~/Downloads/report.pdf", to: "~/Private/report.pdf" })).toMatchObject({ outcome: "permission_denied" });
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("isn't fooled by symlinks that point outside", async () => {
    await fs.symlink(outside, path.join(allowed, "escape"));
    const a = await make();
    expect(await a.run("list_directory", { path: "~/Downloads/escape" })).toMatchObject({ outcome: "permission_denied" });
    expect(await a.run("move_file", { from: "~/Downloads/notes.md", to: "~/Downloads/escape/notes.md" })).toMatchObject({ outcome: "permission_denied" });
    expect(await fs.readdir(outside)).toEqual(["secret.txt"]);
  });

  it("reads folders and finds files", async () => {
    const a = await make();
    const list = await a.run("list_directory", { path: "~/Downloads" });
    expect(list.outcome).toBe("success");
    expect(list.details.items.map((i: { name: string }) => i.name)).not.toContain(".hidden");
    const found = await a.run("find_files", { folder: "~/Downloads", extensions: [".pdf", "md"] });
    expect(found.details.items.map((i: { name: string }) => i.name).sort()).toEqual(["notes.md", "report.pdf"]);
    expect(found.summary).toBe("Found 2 matching files in ~/Downloads.");
  });
});

describe("changes", () => {
  it("moves without overwriting, and never moves an allowed folder itself", async () => {
    const a = await make();
    expect(await a.run("move_file", { from: "~/Downloads/notes.md", to: "~/Downloads/Docs/notes.md" })).toMatchObject({ outcome: "success", verified: true });
    await fs.writeFile(path.join(allowed, "notes2.md"), "new");
    expect(await a.run("move_file", { from: "~/Downloads/notes2.md", to: "~/Downloads/Docs/notes.md" })).toMatchObject({ outcome: "permission_denied", summary: expect.stringMatching(/already exists/) });
    expect(await fs.readFile(path.join(allowed, "Docs/notes.md"), "utf8")).toBe("notes.md");
    expect(await a.run("copy_file", { from: "~/Downloads/notes2.md", to: "~/Downloads/Docs/notes.md" })).toMatchObject({ outcome: "permission_denied" });
    expect(await a.run("move_file", { from: "~/Downloads", to: "~/Downloads2" })).toMatchObject({ outcome: "permission_denied" });
    expect(await a.run("rename_file", { path: "~/Downloads/song.mp3", new_name: "../song.mp3" })).toMatchObject({ outcome: "permission_denied" });
    expect(await a.run("rename_file", { path: "~/Downloads/song.mp3", new_name: "track.mp3" })).toMatchObject({ outcome: "success" });
  });

  it("sorts a folder by type from the approved list, deleting nothing", async () => {
    const a = await make();
    const before = (await files(allowed)).length;
    const preview = await a.run("organize_preview", { path: "~/Downloads" });
    expect(preview.summary).toBe("7 files in ~/Downloads would move into 7 folders.");
    expect(preview.details.skipped).toEqual([{ name: "big.zip.crdownload", reason: "still downloading" }]);
    expect(preview.details.moves).toContainEqual({ from: "~/Downloads/photo.JPG", to: "~/Downloads/Images/photo.JPG" });
    const applied = await a.run("organize_apply", { path: "~/Downloads", moves: preview.details.moves });
    expect(applied).toMatchObject({ outcome: "success", verified: true, summary: "Moved 7 of 7 files in ~/Downloads into 7 folders; nothing was deleted." });
    expect(await files(allowed)).toEqual(
      [".hidden", "Audio/song.mp3", "Documents/notes.md", "Images/photo.JPG", "Installers/setup.dmg", "Other/mystery.xyz", "PDFs/report.pdf", "Spreadsheets/budget.xlsx", "big.zip.crdownload"].sort(),
    );
    expect((await files(allowed)).length).toBe(before);
  });

  it("applies only genuine sorting moves inside the folder", async () => {
    const a = await make();
    for (const moves of [
      [{ from: "~/Downloads/report.pdf", to: "~/Downloads/Secret/report.pdf" }],
      [{ from: "~/Downloads/report.pdf", to: "~/Downloads/PDFs/renamed.pdf" }],
      [{ from: "~/Private/secret.txt", to: "~/Downloads/Other/secret.txt" }],
      [{ from: "~/Downloads/report.pdf", to: "~/Private/PDFs/report.pdf" }],
    ]) expect((await a.run("organize_apply", { path: "~/Downloads", moves })).outcome).toBe("permission_denied");
    expect(await fs.readdir(allowed)).toContain("report.pdf");
  });

  it("undoes the last batch", async () => {
    const a = await make();
    const preview = await a.run("organize_preview", { path: "~/Downloads" });
    await a.run("organize_apply", { path: "~/Downloads", moves: preview.details.moves });
    const undo = await a.run("undo_last_change", {});
    expect(undo).toMatchObject({ outcome: "success", summary: "Put back 7 of 7 items.", verified: true });
    expect((await fs.readdir(allowed)).sort()).toEqual([".hidden", "big.zip.crdownload", "budget.xlsx", "mystery.xyz", "notes.md", "photo.JPG", "report.pdf", "setup.dmg", "song.mp3"]);
    expect((await a.run("undo_last_change", {})).summary).toBe("There's no change to undo.");
    const log = await a.readLog();
    expect(log.every((e: Record<string, unknown>) => !JSON.stringify(e).includes("secret"))).toBe(true);
  });

  it("refuses everything while stopped, until resumed", async () => {
    const a = await make();
    a.halt();
    expect(await a.run("list_directory", { path: "~/Downloads" })).toMatchObject({ outcome: "permission_denied", summary: expect.stringMatching(/Automation is stopped/) });
    a.resume();
    expect((await a.run("list_directory", { path: "~/Downloads" })).outcome).toBe("success");
  });

  it("refuses unknown tools", async () => {
    const a = await make();
    expect(await a.run("delete_file", { path: "~/Downloads/report.pdf" })).toMatchObject({ outcome: "unsupported" });
    expect(await a.run("__proto__", {})).toMatchObject({ outcome: "unsupported" });
  });
});

describe("apps", () => {
  it("opens apps by name on macOS without a shell, and checks they're running", async () => {
    const calls: [string, string[]][] = [];
    const a = await make({
      platform: "darwin",
      exec: async (file: string, args: string[]) => {
        calls.push([file, args]);
        return { ok: true, code: 0, stdout: file === "osascript" ? "true\n" : "", stderr: "" };
      },
    });
    expect(await a.run("open_application", { name: "Visual Studio Code" })).toMatchObject({ outcome: "success", verified: true, summary: "Opened Visual Studio Code." });
    expect(calls[0]).toEqual(["open", ["-a", "Visual Studio Code"]]);
    expect(await a.run("open_application", { name: 'Safari" & do shell script "rm' })).toMatchObject({ outcome: "permission_denied" });
    expect(calls).toHaveLength(2);
  });

  it("says plainly when launching apps isn't supported", async () => {
    const a = await make();
    expect(await a.run("open_application", { name: "Firefox" })).toMatchObject({ outcome: "unsupported" });
  });

  it("sorts names into categories", () => {
    expect([categoryFor("a.PDF"), categoryFor("b.heic"), categoryFor("c"), categoryFor("d.tar.gz")]).toEqual(["PDFs", "Images", "Other", "Archives"]);
    expect(parseArgs(["--allow", "/x", "--origin", "http://localhost:3000/path", "--port", "5000"], "/h")).toMatchObject({ roots: ["/x"], port: 5000, origins: expect.arrayContaining(["http://localhost:3000"]) });
    expect(() => parseArgs(["--port", "80"], "/h")).toThrow();
  });
});

describe("http", () => {
  it("checks Host and Origin, pairs with the code, and requires the token", async () => {
    const a = await make();
    const port = 40000 + Math.floor(Math.random() * 20000);
    let code = "";
    const server = createServer(a, { port, origins: ["https://tryorbis.app"], onPairCode: (c: string) => (code = c) });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const url = `http://127.0.0.1:${port}`;
    const orbis = { origin: "https://tryorbis.app", "content-type": "application/json" };
    try {
      expect((await fetch(`${url}/status`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
      const pre = await fetch(`${url}/tool`, { method: "OPTIONS", headers: { origin: "https://tryorbis.app", "access-control-request-method": "POST", "access-control-request-private-network": "true" } });
      expect(pre.headers.get("access-control-allow-private-network")).toBe("true");
      expect(pre.headers.get("access-control-allow-origin")).toBe("https://tryorbis.app");
      expect(await (await fetch(`${url}/status`, { headers: orbis })).json()).toMatchObject({ paired: false });
      expect((await fetch(`${url}/tool`, { method: "POST", headers: orbis, body: JSON.stringify({ tool: "list_directory", args: { path: "~/Downloads" } }) })).status).toBe(401);
      expect((await fetch(`${url}/pair`, { method: "POST", headers: orbis, body: JSON.stringify({ code: "000000" === code ? "111111" : "000000" }) })).status).toBe(401);
      const paired = await (await fetch(`${url}/pair`, { method: "POST", headers: orbis, body: JSON.stringify({ code }) })).json();
      expect(paired).toMatchObject({ folders: ["~/Downloads"], platform: "linux" });
      const auth = { ...orbis, authorization: `Bearer ${paired.token}` };
      const listed = await (await fetch(`${url}/tool`, { method: "POST", headers: auth, body: JSON.stringify({ tool: "list_directory", args: { path: "~/Downloads" } }) })).json();
      expect(listed.outcome).toBe("success");
      expect((await fetch(`${url}/tool`, { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
      await fetch(`${url}/halt`, { method: "POST", headers: auth, body: "{}" });
      expect((await (await fetch(`${url}/tool`, { method: "POST", headers: auth, body: JSON.stringify({ tool: "list_directory", args: { path: "~/Downloads" } }) })).json()).outcome).toBe("permission_denied");
      await fetch(`${url}/resume`, { method: "POST", headers: auth, body: "{}" });
      // DNS rebinding: a request that names another host is refused.
      const http = await import("node:http");
      const status = await new Promise<number>((resolve) => http.get({ host: "127.0.0.1", port, path: "/status", headers: { host: `attacker.example:${port}` } }, (r) => resolve(r.statusCode ?? 0)));
      expect(status).toBe(403);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
