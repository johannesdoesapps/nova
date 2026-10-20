import "server-only";
import { lookup as dnsLookup, resolveTxt } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { isPublicAddress } from "./net-pure";

export { isPublicAddress, normalizeHost } from "./net-pure";

/**
 * Outbound HTTP for scans. Every connection's resolved address is checked at
 * connect time (so DNS rebinding can't reach internal networks), only ports
 * 80/443 are allowed, redirects are never followed automatically, and
 * responses are size- and time-limited.
 */

export class BlockedAddressError extends Error {}

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as { address: string; family: number }[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (!list.length || bad) return callback(new BlockedAddressError(`${hostname} resolves to a private or reserved address`), "", 4);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface SafeResponse {
  url: string;
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
  truncated: boolean;
}

/** A single GET/HEAD with no redirect following. */
export function safeRequest(
  url: string,
  opts: { method?: "GET" | "HEAD"; headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; lookup?: LookupFunction } = {},
): Promise<SafeResponse> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") return Promise.reject(new Error("Unsupported protocol"));
  if (u.port && u.port !== "80" && u.port !== "443") return Promise.reject(new Error("Unsupported port"));
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: opts.method ?? "GET",
        headers: { "user-agent": "OrbisSentinel/1.0 (+authorized security check)", accept: "*/*", ...opts.headers },
        lookup: opts.lookup ?? guardedLookup,
        timeout: opts.timeoutMs ?? 8000,
        signal: opts.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            res.destroy();
            done();
          } else chunks.push(c);
        });
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          resolve({
            url,
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
          });
        };
        res.on("end", done);
        res.on("close", done);
        res.on("error", (e) => (truncated ? done() : reject(e)));
      },
    );
    req.on("timeout", () => req.destroy(new Error("The website took too long to respond.")));
    req.on("error", reject);
    req.end();
  });
}

/** TXT records for a name, or [] when there are none. */
export function txtRecords(name: string): Promise<string[]> {
  return new Promise((resolve) => resolveTxt(name, (err, recs) => resolve(err ? [] : recs.map((r) => r.join("")))));
}

export function header(res: SafeResponse, name: string): string | null {
  const v = res.headers[name.toLowerCase()];
  if (v === undefined) return null;
  return Array.isArray(v) ? v.join(", ") : v;
}

export function headerList(res: SafeResponse, name: string): string[] {
  const v = res.headers[name.toLowerCase()];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
