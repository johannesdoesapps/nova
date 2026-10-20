import "server-only";
import { gunzipSync } from "node:zlib";
import { isScannable, type SourceFile } from "./code-rules";

/**
 * Read-only repository snapshots from GitHub for Code Guardian. Nothing is
 * cloned or executed: the tarball is downloaded, unpacked in memory, and only
 * text files with supported extensions are kept.
 */

const LIMITS = { tarball: 40 * 1024 * 1024, unpacked: 120 * 1024 * 1024, file: 400 * 1024, files: 3000, total: 12 * 1024 * 1024 };
const MANIFEST = /(^|\/)(package-lock\.json|yarn\.lock|package\.json|requirements[^/]*\.txt)$/;

export function parseRepo(input: string): { owner: string; repo: string; ref: string | null } {
  const s = input.trim().replace(/\.git$/, "");
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:\/tree\/([A-Za-z0-9._\/-]{1,200}))?\/?$/.exec(s);
  if (!m) throw new Error("Enter a GitHub repository as owner/name or its github.com URL.");
  return { owner: m[1]!, repo: m[2]!, ref: m[3] ?? null };
}

export async function fetchRepoFiles(
  input: string,
  opts: { token?: string | null; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<{ files: SourceFile[]; label: string; ref: string; skipped: number; truncated: boolean }> {
  const { owner, repo, ref } = parseRepo(input);
  const f = opts.fetchImpl ?? fetch;
  let res: Response | null = null;
  let usedRef = ref ?? "HEAD";
  if (opts.token) {
    res = await f(`https://api.github.com/repos/${owner}/${repo}/tarball${ref ? `/${encodeURIComponent(ref)}` : ""}`, {
      headers: { authorization: `Bearer ${opts.token}`, accept: "application/vnd.github+json", "user-agent": "orbis-code-guardian" },
      signal: opts.signal,
    });
  } else {
    for (const r of ref ? [ref] : ["HEAD", "main", "master"]) {
      res = await f(`https://codeload.github.com/${owner}/${repo}/tar.gz/${r.split("/").map(encodeURIComponent).join("/")}`, { signal: opts.signal });
      usedRef = r;
      if (res.ok || res.status !== 404) break;
    }
  }
  if (!res || !res.ok) {
    throw new Error(
      res?.status === 404
        ? "Repository not found. It may be private — private repositories need GITHUB_TOKEN, which only administrators can use."
        : `GitHub returned HTTP ${res?.status ?? "error"}.`,
    );
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > LIMITS.tarball) throw new Error("The repository is too large to review here (over 40 MB compressed).");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > LIMITS.tarball) throw new Error("The repository is too large to review here (over 40 MB compressed).");
  let tar: Buffer;
  try {
    tar = gunzipSync(buf, { maxOutputLength: LIMITS.unpacked });
  } catch {
    throw new Error("The repository is too large to unpack here, or the download was corrupted.");
  }
  const { files, skipped, truncated } = untar(tar);
  return { files, label: `${owner}/${repo}`, ref: usedRef, skipped, truncated };
}

/** Minimal ustar/pax reader: regular files only, links and devices ignored. */
export function untar(tar: Buffer): { files: SourceFile[]; skipped: number; truncated: boolean } {
  const files: SourceFile[] = [];
  let skipped = 0;
  let total = 0;
  let truncated = false;
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, n: number) => h.subarray(a, a + n).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(h[156]!);
    const prefix = str(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /\d+ path=([^\n]+)\n/.exec(data.toString("utf8"));
      if (m) longName = m[1]!;
      continue;
    }
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type !== "0" && type !== "\0") continue;
    name = name.split("/").slice(1).join("/"); // drop the "repo-sha/" folder
    if (!name || !(isScannable(name) || MANIFEST.test(name))) {
      skipped++;
      continue;
    }
    if (size > (MANIFEST.test(name) ? 5 * 1024 * 1024 : LIMITS.file) || data.includes(0)) {
      skipped++;
      continue;
    }
    if (files.length >= LIMITS.files || total + size > LIMITS.total) {
      truncated = true;
      skipped++;
      continue;
    }
    total += size;
    files.push({ path: name, content: data.toString("utf8") });
  }
  return { files, skipped, truncated };
}
