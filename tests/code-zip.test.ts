import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, zipBaseName, zipFiles } from "@/lib/code/zip";

const FILES = [
  { path: "index.html", content: "<!doctype html>\n<h1>Héllo — 你好</h1>\n".repeat(20) },
  { path: "src/app.js", content: "console.log(1);\n" },
  { path: "empty.txt", content: "" },
];

/** Read every entry back from the central directory. */
function readZip(zip: Uint8Array) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const out: { name: string; content: string; crcOk: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    const dataAt = local + 30 + v.getUint16(local + 26, true);
    const data = zip.subarray(dataAt, dataAt + size);
    const raw = method === 8 ? new Uint8Array(inflateRawSync(data)) : data;
    out.push({ name, content: new TextDecoder().decode(raw), crcOk: crc32(raw) === crc });
    at += 46 + nameLen;
  }
  return out;
}

describe("project zip", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips every file under one folder, compressed or stored", () => {
    const entries = readZip(zipFiles("my-site", FILES));
    expect(entries.map((e) => e.name)).toEqual(["my-site/index.html", "my-site/src/app.js", "my-site/empty.txt"]);
    expect(entries.map((e) => e.content)).toEqual(FILES.map((f) => f.content));
    expect(entries.every((e) => e.crcOk)).toBe(true);
  });

  it("an empty project is still a valid zip", () => {
    expect(readZip(zipFiles("p", []))).toEqual([]);
  });

  it("safe names for the folder and download", () => {
    expect(zipBaseName("My Bakery Site!")).toBe("My-Bakery-Site");
    expect(zipBaseName('../../etc"; rm')).toBe("etc-rm");
    expect(zipBaseName("你好")).toBe("project");
  });

  it("the system unzip accepts it", () => {
    let unzip = true;
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      unzip = false;
    }
    if (!unzip) return;
    const dir = mkdtempSync(join(tmpdir(), "zip-"));
    try {
      writeFileSync(join(dir, "a.zip"), zipFiles("my-site", FILES));
      execFileSync("unzip", ["-tq", join(dir, "a.zip")]);
      execFileSync("unzip", ["-q", join(dir, "a.zip"), "-d", join(dir, "out")]);
      expect(readFileSync(join(dir, "out/my-site/index.html"), "utf8")).toBe(FILES[0]!.content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
