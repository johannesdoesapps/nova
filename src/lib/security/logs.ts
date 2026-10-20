import { fingerprint, type Confidence, type FindingDraft, type Severity } from "./types";

/**
 * Orbis Threat Hunter's log analysis. Parses web access logs (combined/common),
 * SSH auth logs and JSON lines, then applies transparent, threshold-based
 * detections. Every finding states what was observed (facts from the log)
 * separately from what it might mean (hypotheses).
 */

export interface LogFile {
  name: string;
  content: string;
}

export interface LogEvent {
  file: string;
  line: number;
  time: string | null;
  ip: string | null;
  kind: "web" | "auth_fail" | "auth_ok" | "other";
  user?: string;
  method?: string;
  path?: string;
  status?: number;
  agent?: string;
  raw: string;
}

const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

const WEB = /^(\S+) \S+ (\S+) \[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{4})\] "(\S+) (\S+)[^"]*" (\d{3}) \S+(?: "[^"]*" "([^"]*)")?/;
const SSH_FAIL = /^(\w{3})\s+(\d{1,2}) (\d{2}:\d{2}:\d{2}) .*?sshd\[\d+\]: Failed (?:password|publickey) for (?:invalid user )?(\S+) from (\S+)/;
const SSH_INVALID = /^(\w{3})\s+(\d{1,2}) (\d{2}:\d{2}:\d{2}) .*?sshd\[\d+\]: Invalid user (\S+) from (\S+)/;
const SSH_OK = /^(\w{3})\s+(\d{1,2}) (\d{2}:\d{2}:\d{2}) .*?sshd\[\d+\]: Accepted \S+ for (\S+) from (\S+)/;
const ISO = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

const pick = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) {
    const v = k.split(".").reduce<unknown>((acc, p) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[p] : undefined), o);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

export function parseLogs(files: LogFile[], year = new Date().getUTCFullYear()): { events: LogEvent[]; unparsed: number; formats: Record<string, number> } {
  const events: LogEvent[] = [];
  let unparsed = 0;
  const formats: Record<string, number> = { web: 0, ssh: 0, json: 0 };
  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    lines.forEach((raw, i) => {
      if (!raw.trim()) return;
      const line = i + 1;
      let m: RegExpExecArray | null;
      if ((m = WEB.exec(raw))) {
        formats.web!++;
        const tz = m[7]!;
        events.push({
          file: f.name,
          line,
          ip: m[1]!,
          time: new Date(`${m[5]}-${MONTHS[m[4]!] ?? "01"}-${m[3]}T${m[6]}${tz.slice(0, 3)}:${tz.slice(3)}`).toISOString(),
          kind: "web",
          user: m[2] !== "-" ? m[2] : undefined,
          method: m[8],
          path: m[9],
          status: Number(m[10]),
          agent: m[11],
          raw,
        });
        return;
      }
      const ssh = (re: RegExp, kind: LogEvent["kind"]) => {
        const s = re.exec(raw);
        if (!s) return false;
        formats.ssh!++;
        const d = new Date(`${year}-${MONTHS[s[1]!] ?? "01"}-${s[2]!.padStart(2, "0")}T${s[3]}Z`);
        events.push({ file: f.name, line, ip: s[5]!, time: Number.isNaN(d.getTime()) ? null : d.toISOString(), kind, user: s[4], raw });
        return true;
      };
      if (ssh(SSH_FAIL, "auth_fail") || ssh(SSH_INVALID, "auth_fail") || ssh(SSH_OK, "auth_ok")) return;
      if (raw.trimStart().startsWith("{")) {
        try {
          const o = JSON.parse(raw) as Record<string, unknown>;
          formats.json!++;
          const msg = String(pick(o, ["message", "msg", "event", "action", "event.action"]) ?? "");
          const outcome = String(pick(o, ["outcome", "event.outcome", "result", "status_text"]) ?? "");
          const status = Number(pick(o, ["status", "status_code", "statusCode", "http.response.status_code", "response.status"]));
          const isAuth = /login|sign.?in|auth|password/i.test(msg);
          const failed = /fail|denied|invalid|unauthori[sz]ed|wrong/i.test(`${msg} ${outcome}`) || (isAuth && (status === 401 || status === 403));
          const success = isAuth && !failed && (/success|ok|accepted|logged in/i.test(`${msg} ${outcome}`) || status === 200);
          const t = pick(o, ["timestamp", "@timestamp", "time", "ts", "date"]);
          const parsed = typeof t === "number" ? new Date(t < 1e12 ? t * 1000 : t) : t ? new Date(String(t)) : null;
          events.push({
            file: f.name,
            line,
            ip: (pick(o, ["ip", "client_ip", "clientIp", "src_ip", "source.ip", "remote_addr", "remoteAddr", "ip_address"]) as string | undefined) ?? null,
            time: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
            kind: isAuth ? (failed ? "auth_fail" : success ? "auth_ok" : "other") : Number.isFinite(status) && pick(o, ["path", "url", "request", "http.request.path", "url.path"]) ? "web" : "other",
            user: pick(o, ["user", "username", "email", "user.name", "user_name"]) as string | undefined,
            method: pick(o, ["method", "http.request.method"]) as string | undefined,
            path: pick(o, ["path", "url", "request", "http.request.path", "url.path", "url.original"]) as string | undefined,
            status: Number.isFinite(status) ? status : undefined,
            agent: pick(o, ["user_agent", "userAgent", "ua", "user_agent.original"]) as string | undefined,
            raw: raw.slice(0, 500),
          });
          return;
        } catch {
          /* fall through */
        }
      }
      const iso = ISO.exec(raw);
      if (iso && /fail|invalid|denied/i.test(raw) && /login|auth|password/i.test(raw)) {
        const ip = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(raw)?.[1] ?? null;
        events.push({ file: f.name, line, ip, time: new Date(iso[1]!).toISOString(), kind: "auth_fail", raw: raw.slice(0, 500) });
        return;
      }
      unparsed++;
    });
  }
  return { events, unparsed, formats };
}

const PAYLOADS: { id: string; label: string; re: RegExp }[] = [
  { id: "sqli", label: "SQL injection", re: /(\bunion\b(\s|%20|\+)+(all(\s|%20|\+)+)?select\b|'\s*(or|and)\s*'?\d+'?\s*=\s*'?\d+|%27\s*(or|and)|\bsleep\s*\(\s*\d+\s*\)|benchmark\s*\(|information_schema)/i },
  { id: "xss", label: "Cross-site scripting", re: /(<script|%3Cscript|javascript:|onerror\s*=|onload\s*=|%3Csvg)/i },
  { id: "traversal", label: "Path traversal", re: /(\.\.\/|\.\.%2f|%2e%2e%2f|%2e%2e\/|\/etc\/passwd|win\.ini)/i },
  { id: "cmdi", label: "Command injection", re: /(;|%3B|\||%7C|`|\$\()\s*(cat|wget|curl|bash|sh|nc|id|whoami)\b/i },
  { id: "log4shell", label: "Log4Shell (JNDI lookup)", re: /\$\{jndi:|%24%7Bjndi/i },
];

const SCANNER_PATHS = /(\/wp-login\.php|\/wp-admin|\/xmlrpc\.php|\/\.env|\/\.git\/|\/phpmyadmin|\/pma\/|\/admin\.php|\/actuator|\/cgi-bin\/|\/vendor\/phpunit|\/boaform|\/HNAP1|\/\.aws\/|\/config\.json|\/server-status)/i;
const SCANNER_AGENTS = /(sqlmap|nikto|nmap|masscan|zgrab|nuclei|gobuster|dirbuster|wpscan|acunetix|nessus|openvas|hydra|python-requests|curl\/|go-http-client|libwww-perl)/i;

export interface HuntOptions {
  bruteForceThreshold: number;
  sprayUserThreshold: number;
  scanErrorThreshold: number;
}
export const DEFAULT_HUNT: HuntOptions = { bruteForceThreshold: 10, sprayUserThreshold: 5, scanErrorThreshold: 30 };

export interface TimelineEntry {
  time: string | null;
  ip: string | null;
  label: string;
  ref: string;
}

export function huntThreats(
  events: LogEvent[],
  asset: string,
  opts: HuntOptions = DEFAULT_HUNT,
): { findings: FindingDraft[]; timeline: TimelineEntry[]; indicators: string[]; stats: Record<string, number> } {
  const findings: FindingDraft[] = [];
  const timeline: TimelineEntry[] = [];
  const byIp = new Map<string, LogEvent[]>();
  for (const e of events) if (e.ip) (byIp.get(e.ip) ?? byIp.set(e.ip, []).get(e.ip)!).push(e);
  const ref = (e: LogEvent) => `${e.file}:${e.line}`;
  const span = (list: LogEvent[]) => {
    const ts = list.map((e) => e.time).filter(Boolean).sort() as string[];
    return ts.length ? `${ts[0]} → ${ts[ts.length - 1]}` : "times not available";
  };
  const evid = (list: LogEvent[], n = 4) => list.slice(0, n).map((e) => ({ source: ref(e), detail: e.raw.slice(0, 300) }));
  const push = (d: { ruleId: string; ip: string; title: string; description: string; severity: Severity; confidence: Confidence; rationale: string; evidence: { source: string; detail: string }[]; remediation: string; key?: string }) => {
    findings.push({
      agent: "threat_hunter",
      ruleId: d.ruleId,
      fingerprint: fingerprint("threat_hunter", d.ruleId, asset, d.ip, d.key ?? ""),
      title: d.title,
      description: d.description,
      severity: d.severity,
      confidence: d.confidence,
      rationale: d.rationale,
      asset,
      location: d.ip,
      evidence: d.evidence,
      evidenceSource: "nova:log-analyzer",
      remediation: d.remediation,
      references: ["https://attack.mitre.org/techniques/T1110/"].filter(() => d.ruleId.startsWith("auth.")).concat(d.ruleId.startsWith("web.") ? ["https://owasp.org/www-community/attacks/"] : []),
    });
  };

  const indicators = new Set<string>();
  for (const [ip, list] of byIp) {
    const fails = list.filter((e) => e.kind === "auth_fail");
    const oks = list.filter((e) => e.kind === "auth_ok");
    const users = new Set(fails.map((e) => e.user).filter(Boolean));
    if (fails.length >= opts.bruteForceThreshold) {
      indicators.add(ip);
      const lastFail = fails.map((e) => e.time).filter(Boolean).sort().pop() ?? null;
      const after = oks.filter((e) => !lastFail || !e.time || e.time >= (fails[0]!.time ?? ""));
      const success = after.length > 0;
      push({
        ruleId: success ? "auth.success-after-failures" : "auth.brute-force",
        ip,
        title: success ? `Successful sign-in from ${ip} after ${fails.length} failures` : `${fails.length} failed sign-ins from ${ip}`,
        description: success
          ? `Observed: ${fails.length} failed attempts${users.size ? ` for ${users.size} account name(s)` : ""}, then ${after.length} successful sign-in(s) as ${[...new Set(after.map((e) => e.user))].join(", ") || "unknown user"} from the same address (${span(list)}). Hypothesis: a password was guessed. It could also be a legitimate user who mistyped — confirm with the account owner.`
          : `Observed: ${fails.length} failed attempts${users.size ? ` against ${users.size} account name(s)` : ""} from one address (${span(fails)}), and no successful sign-in from it in these logs. Hypothesis: automated password guessing.`,
        severity: success ? "high" : "medium",
        confidence: success ? "firm" : "confirmed",
        rationale: success
          ? "A success after many failures is a common sign of a guessed password, but the logs alone can't prove the sign-in was malicious."
          : `Repeated failures (threshold ${opts.bruteForceThreshold}) are directly observed; no evidence of success.`,
        evidence: [...evid(fails, 3), ...evid(after, 2)],
        remediation: success
          ? "Contact the account owner, reset the password, end active sessions, review what the account did after the sign-in, and enable MFA. Block or rate-limit the address."
          : "Rate-limit or block the address, enforce account lockout or exponential back-off, and require MFA. For SSH, disable password authentication.",
      });
      timeline.push({ time: fails[0]!.time, ip, label: `Failed sign-ins begin (${fails.length} total)`, ref: ref(fails[0]!) });
      if (success) timeline.push({ time: after[0]!.time, ip, label: `Successful sign-in as ${after[0]!.user ?? "unknown"}`, ref: ref(after[0]!) });
    }
    if (users.size >= opts.sprayUserThreshold) {
      indicators.add(ip);
      push({
        ruleId: "auth.password-spray",
        ip,
        title: `Password spraying pattern from ${ip} (${users.size} accounts)`,
        description: `Observed: failed sign-ins for ${users.size} different account names from one address (${span(fails)}). Hypothesis: one or a few common passwords being tried across many accounts.`,
        severity: "medium",
        confidence: "confirmed",
        rationale: `Many distinct usernames (threshold ${opts.sprayUserThreshold}) from one source is directly observed.`,
        evidence: evid(fails, 4),
        remediation: "Block the address, check whether any targeted account signed in successfully, and enforce MFA and breached-password checks.",
      });
    }
    const web = list.filter((e) => e.kind === "web");
    for (const p of PAYLOADS) {
      const hits = web.filter((e) => e.path && p.re.test(safeDecode(e.path)));
      if (!hits.length) continue;
      indicators.add(ip);
      const ok = hits.filter((e) => (e.status ?? 0) >= 200 && (e.status ?? 0) < 300);
      push({
        ruleId: `web.payload-${p.id}`,
        ip,
        key: p.id,
        title: `${p.label} attempts from ${ip} (${hits.length})`,
        description: `Observed: ${hits.length} request(s) containing ${p.label.toLowerCase()} patterns (${span(hits)}).${ok.length ? ` ${ok.length} received a 2xx response — that does not prove success, but those endpoints should be checked.` : " None received a successful response."}`,
        severity: ok.length ? "high" : "medium",
        confidence: ok.length ? "tentative" : "confirmed",
        rationale: ok.length
          ? "Attack payloads were sent and the server answered normally; whether the attack worked needs code review or deeper logs."
          : "Attack attempts are directly observed; all were rejected or failed.",
        evidence: evid(ok.length ? ok : hits, 4),
        remediation: ok.length
          ? "Review the code for the endpoints that returned 2xx (Code Guardian can help), add input validation and parameterised queries, and consider a WAF rule."
          : "Block or rate-limit the address. No action on the application is indicated by these logs alone.",
      });
      timeline.push({ time: hits[0]!.time, ip, label: `${p.label} attempts (${hits.length})`, ref: ref(hits[0]!) });
    }
    const probes = web.filter((e) => e.path && SCANNER_PATHS.test(e.path));
    const errors = web.filter((e) => (e.status ?? 0) >= 400 && (e.status ?? 0) < 500);
    const tools = web.filter((e) => e.agent && SCANNER_AGENTS.test(e.agent));
    if (probes.length >= 3 || errors.length >= opts.scanErrorThreshold || tools.length >= 3) {
      indicators.add(ip);
      const exposed = probes.filter((e) => e.status === 200);
      push({
        ruleId: "web.scanning",
        ip,
        title: `Automated scanning from ${ip}`,
        description: `Observed: ${probes.length} request(s) for commonly attacked paths, ${errors.length} client errors${tools.length ? `, and scanner user agents such as "${tools[0]!.agent!.slice(0, 60)}"` : ""} (${span(web)}).${exposed.length ? ` ${exposed.length} probe(s) got HTTP 200: ${[...new Set(exposed.map((e) => e.path))].slice(0, 3).join(", ")} — Sentinel can check whether these expose anything.` : ""}`,
        severity: exposed.length ? "medium" : "low",
        confidence: "confirmed",
        rationale: exposed.length ? "Scanning is routine internet noise, but some probed paths answered successfully." : "Routine internet scanning; all probes failed.",
        evidence: evid(exposed.length ? exposed : probes.length ? probes : tools.length ? tools : errors, 4),
        remediation: exposed.length ? "Verify the paths that returned 200 don't expose sensitive files, and block dotfiles and admin paths at the web server." : "No action required beyond normal rate-limiting; consider blocking the address if traffic is heavy.",
      });
      timeline.push({ time: (probes[0] ?? errors[0] ?? tools[0])!.time, ip, label: "Scanning activity", ref: ref((probes[0] ?? errors[0] ?? tools[0])!) });
    }
  }
  timeline.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  return {
    findings,
    timeline: timeline.slice(0, 200),
    indicators: [...indicators].slice(0, 50),
    stats: {
      events: events.length,
      sources: byIp.size,
      authFailures: events.filter((e) => e.kind === "auth_fail").length,
      authSuccesses: events.filter((e) => e.kind === "auth_ok").length,
      webRequests: events.filter((e) => e.kind === "web").length,
    },
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** Validate a pasted list of indicators: IPs, domains and URLs. */
export function parseIndicators(text: string): { ips: string[]; domains: string[]; urls: string[]; invalid: string[] } {
  const ips: string[] = [];
  const domains: string[] = [];
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 200)) {
    const s = raw.replace(/\[\.\]/g, ".").replace(/^hxxp/i, "http");
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split(".").every((n) => Number(n) <= 255)) ips.push(s);
    else if (/^https?:\/\//i.test(s)) {
      try {
        urls.push(new URL(s).toString());
      } catch {
        invalid.push(raw);
      }
    } else if (/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i.test(s)) domains.push(s.toLowerCase());
    else invalid.push(raw);
  }
  return { ips: [...new Set(ips)], domains: [...new Set(domains)], urls: [...new Set(urls)], invalid };
}
