import { inflateRawSync } from "node:zlib";

/**
 * A small, strict ZIP reader for uploads to Code Review: text files only, stored or deflated, with hard
 * limits so a zip bomb or a huge archive can't exhaust memory. It reads the central directory (not the
 * local headers' sizes, which streaming zips leave empty) and never writes anything to disk.
 */

export interface UnzipLimits {
  /** Files kept (the rest are counted as skipped). */
  maxFiles: number;
  /** Uncompressed bytes per file. */
  maxFileBytes: number;
  /** Uncompressed bytes in total. */
  maxTotalBytes: number;
}

export interface UnzipResult {
  files: { path: string; content: string }[];
  skipped: number;
  truncated: boolean;
}

const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|\.next|out|coverage|vendor|__pycache__|\.venv|venv|target|\.turbo|\.cache)\//;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|bz2|7z|rar|jar|class|exe|dll|so|dylib|woff2?|ttf|otf|eot|mp[34]|mov|avi|wasm|bin|lock|map|min\.js)$/i;

export function unzip(buf: Buffer, limits: UnzipLimits): UnzipResult {
  // The end-of-central-directory record is within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("That file isn't a ZIP archive.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files: UnzipResult["files"] = [];
  let skipped = 0;
  let total = 0;
  let truncated = false;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("The ZIP archive is damaged.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    const path = rawName.replace(/\\/g, "/").replace(/^\.\//, "");
    const isDir = path.endsWith("/");
    if (isDir) continue;
    // Unsafe or unwanted entries are skipped, never resolved against a directory.
    if (!path || path.startsWith("/") || path.split("/").includes("..") || path.includes("\0") || /^__MACOSX\//.test(path) || SKIP_DIR.test(path) || BINARY_EXT.test(path) || flags & 0x1) {
      skipped++;
      continue;
    }
    if (files.length >= limits.maxFiles || size > limits.maxFileBytes || total + size > limits.maxTotalBytes) {
      skipped++;
      truncated = true;
      continue;
    }
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error("The ZIP archive is damaged.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    let bytes: Buffer;
    try {
      if (method === 0) bytes = data;
      else if (method === 8) bytes = inflateRawSync(data, { maxOutputLength: limits.maxFileBytes });
      else {
        skipped++;
        continue;
      }
    } catch {
      skipped++;
      continue;
    }
    if (bytes.length !== size || bytes.includes(0)) {
      skipped++;
      continue;
    }
    total += bytes.length;
    files.push({ path, content: bytes.toString("utf8") });
  }
  // A single top-level folder (the usual "project-main/") is dropped from every path.
  const tops = new Set(files.map((f) => f.path.split("/")[0]));
  if (tops.size === 1 && files.every((f) => f.path.includes("/"))) {
    const top = [...tops][0]!.length + 1;
    for (const f of files) f.path = f.path.slice(top);
  }
  return { files, skipped, truncated };
}
