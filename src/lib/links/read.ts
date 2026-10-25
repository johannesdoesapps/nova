import "server-only";
import { BlockedAddressError, header, safeRequest } from "@/lib/security/net";
import { kindOf, readablePage, statusReason } from "./parse";

/**
 * Fetches a link the user pasted into chat. Every hop goes through the security scanner's guarded request: public
 * addresses only (checked at connect time, so DNS rebinding can't reach internal networks), ports 80/443, size and
 * time limits. Redirects are followed by hand, each one checked the same way. Nothing on the page is run.
 */

export type LinkResult = { ok: true; url: string; finalUrl: string; title: string | null; text: string } | { ok: false; url: string; reason: string };

const MAX_REDIRECTS = 4;

export async function readLink(url: string, signal?: AbortSignal): Promise<LinkResult> {
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await safeRequest(current, {
        timeoutMs: 8000,
        maxBytes: 2 * 1024 * 1024,
        signal,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; OrbisLinkReader/1.0; +https://tryorbis.app)",
          accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
          "accept-language": "en",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = header(res, "location");
        if (!loc) return { ok: false, url, reason: "the site redirected without saying where" };
        current = new URL(loc, current).toString();
        continue;
      }
      if (res.status >= 400) return { ok: false, url, reason: statusReason(res.status) };
      const type = header(res, "content-type");
      if (kindOf(type) === "unsupported")
        return { ok: false, url, reason: `it's a ${(type ?? "binary").split(";")[0]} file, which chat can't read from a link yet (download it and attach it instead)` };
      const page = readablePage(res.body, type);
      if (page.text.length < 80) return { ok: false, url, reason: "the page has almost no readable text (it may build its content with JavaScript, which Orbis doesn't run)" };
      return { ok: true, url, finalUrl: current, title: page.title, text: page.text };
    }
    return { ok: false, url, reason: "the site redirected too many times" };
  } catch (err) {
    if (err instanceof BlockedAddressError) return { ok: false, url, reason: "it points to a private or internal address, which Orbis never opens" };
    const msg = err instanceof Error ? err.message : "";
    if (/Unsupported (protocol|port)/.test(msg)) return { ok: false, url, reason: "only ordinary web addresses (http/https on the standard ports) can be opened" };
    if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return { ok: false, url, reason: "that web address doesn't exist (the domain couldn't be found)" };
    if (/too long|timeout|aborted/i.test(msg)) return { ok: false, url, reason: "the site took too long to respond" };
    return { ok: false, url, reason: "the site couldn't be reached" };
  }
}
