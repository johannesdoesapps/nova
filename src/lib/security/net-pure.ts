import { isIP } from "node:net";

/** Address and hostname validation shared by scanners (no network access). */

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && ip.startsWith("192.0.0.")) || (b === 0 && ip.startsWith("192.0.2.")))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && ip.startsWith("198.51.100.")) return false;
    if (a === 203 && b === 0 && ip.startsWith("203.0.113.")) return false;
    return true;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return false;
    if (s.startsWith("::ffff:")) return isPublicAddress(s.slice(7));
    if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff") || s.startsWith("2001:db8") || s.startsWith("64:ff9b")) return false;
    return true;
  }
  return false;
}

const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** Parse a user-entered website into a normalised hostname, or throw a readable error. */
export function normalizeHost(input: string): string {
  let s = input.trim().toLowerCase();
  if (!s) throw new Error("Enter a website address.");
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("That isn't a valid website address.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http and https websites can be scanned.");
  if (u.username || u.password) throw new Error("Remove the username or password from the address.");
  if (u.port && u.port !== "80" && u.port !== "443") throw new Error("Only standard web ports (80 and 443) can be scanned.");
  const host = u.hostname.replace(/\.$/, "");
  if (isIP(host) || host.startsWith("[")) throw new Error("Use a domain name you own, not an IP address.");
  if (!HOST_RE.test(host) || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("That domain can't be scanned. Use a public domain you own.");
  }
  return host;
}

