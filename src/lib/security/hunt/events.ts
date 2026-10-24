import { redactAll } from "../../secrets";
import { parseLogs, type LogEvent, type LogFile } from "../logs";

/**
 * Threat Hunter's normalized events. Every supported log format — web access, SSH, Linux auth/syslog, AWS
 * CloudTrail, Okta System Log, Windows Security/Sysmon (JSON exports), DNS query logs and generic JSON — becomes
 * the same shape, with timestamps in UTC and a reference back to the file and line it came from.
 *
 * Raw lines are kept short and have secrets (tokens, keys, password parameters) masked before they're used as
 * evidence. Nothing here reads anything but the text it's given.
 */

export const SOURCE_KINDS = ["web_access", "ssh", "linux_auth", "cloudtrail", "okta", "windows", "dns", "json", "text"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_LABEL: Record<SourceKind, string> = {
  web_access: "Web server access log",
  ssh: "SSH authentication log",
  linux_auth: "Linux auth / syslog (sudo, su, accounts, cron, services)",
  cloudtrail: "AWS CloudTrail",
  okta: "Okta System Log",
  windows: "Windows Security / Sysmon events (JSON)",
  dns: "DNS query log",
  json: "Generic JSON log lines",
  text: "Other text lines (timestamp + sign-in failure)",
};

export type Category = "auth" | "web" | "privilege" | "account" | "process" | "logging" | "cloud" | "dns" | "other";

export interface HuntEvent {
  /** file:line (or file#Records[i] for whole-file JSON). */
  ref: string;
  file: string;
  line: number;
  /** ISO UTC, or null when the line has no usable time. */
  time: string | null;
  source: SourceKind;
  category: Category;
  /** What happened, in the source's own terms (e.g. "sudo", "ConsoleLogin", "4625", "user.session.start"). */
  action: string;
  outcome: "success" | "failure" | "unknown";
  user?: string;
  ip?: string;
  host?: string;
  /** The account, group, policy or resource acted on. */
  target?: string;
  process?: string;
  parent?: string;
  command?: string;
  path?: string;
  method?: string;
  status?: number;
  bytes?: number;
  agent?: string;
  query?: string;
  rcode?: string;
  /** A root/administrator identity (cloud root user, sudo to root, Windows admin groups). */
  privileged?: boolean;
  raw: string;
}

const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

/** Mask secrets and credential-looking parameters before a line is stored as evidence. */
export function cleanRaw(raw: string): string {
  return redactAll(raw)
    .replace(/([?&;\s"](?:password|passwd|pwd|token|access_token|api_key|apikey|secret|key|auth|session|sig|signature)=)[^&\s";]+/gi, "$1[redacted]")
    .slice(0, 500);
}

const isoOrNull = (v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return null;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Read a dotted path, also accepting keys that literally contain dots (Zeek's "id.orig_h"). */
function get(o: unknown, path: string): unknown {
  if (!o || typeof o !== "object") return undefined;
  const rec = o as Record<string, unknown>;
  if (path in rec) return rec[path];
  const [head, ...rest] = path.split(".");
  return rest.length ? get(rec[head!], rest.join(".")) : rec[head!];
}
const first = (o: unknown, paths: string[]): unknown => {
  for (const p of paths) {
    const v = get(o, p);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

/* ------------------------------------------------------------ JSON mappers */

type Mapped = Omit<HuntEvent, "ref" | "file" | "line" | "raw">;

const LOGGING_OFF =
  /^(StopLogging|DeleteTrail|UpdateTrail|PutEventSelectors|DeleteFlowLogs|DeleteDetector|UpdateDetector|DisassociateFromMasterAccount|DeleteConfigurationRecorder|StopConfigurationRecorder|DeleteLogGroup|DeleteLogStream)$/;
const IAM_PRIV = /^(AttachUserPolicy|AttachRolePolicy|AttachGroupPolicy|PutUserPolicy|PutRolePolicy|PutGroupPolicy|AddUserToGroup|CreatePolicyVersion|SetDefaultPolicyVersion|UpdateAssumeRolePolicy)$/;
const IAM_ACCOUNT = /^(CreateUser|CreateLoginProfile|UpdateLoginProfile|CreateAccessKey|CreateRole|DeactivateMFADevice|DeleteVirtualMFADevice)$/;
const EXPOSURE = /^(PutBucketPolicy|PutBucketAcl|DeletePublicAccessBlock|PutPublicAccessBlock|AuthorizeSecurityGroupIngress|ModifyDBInstance|ModifySnapshotAttribute|ModifyImageAttribute)$/;

export function mapCloudTrail(r: Record<string, unknown>): Mapped | null {
  const name = str(r.eventName);
  if (!name || !r.eventSource) return null;
  const id = (r.userIdentity ?? {}) as Record<string, unknown>;
  const type = str(id.type);
  const arn = str(id.arn);
  const user = str(id.userName) ?? (type === "Root" ? "root" : arn ? arn.split("/").pop() : str(id.principalId));
  const req = (r.requestParameters ?? {}) as Record<string, unknown>;
  const resp = (r.responseElements ?? {}) as Record<string, unknown>;
  const err = str(r.errorCode);
  const target = str(first(req, ["userName", "groupName", "roleName", "policyArn", "bucketName", "groupId", "name", "trailName", "detectorId"]));
  let category: Category = "cloud";
  let outcome: Mapped["outcome"] = err ? "failure" : "success";
  if (name === "ConsoleLogin") {
    category = "auth";
    outcome = str(resp.ConsoleLogin) === "Failure" || err ? "failure" : "success";
  } else if (LOGGING_OFF.test(name)) category = "logging";
  else if (IAM_PRIV.test(name)) category = "privilege";
  else if (IAM_ACCOUNT.test(name)) category = "account";
  const mfa = str(get(r, "additionalEventData.MFAUsed"));
  return {
    time: isoOrNull(r.eventTime),
    source: "cloudtrail",
    category,
    action: name,
    outcome,
    user,
    ip: str(r.sourceIPAddress),
    host: str(r.awsRegion),
    target: name === "AttachUserPolicy" || name === "AttachRolePolicy" || name === "PutUserPolicy" ? [target, str(req.policyArn ?? req.policyName)].filter(Boolean).join(" ← ") : target,
    agent: str(r.userAgent),
    privileged: type === "Root",
    command: [str(r.eventSource), mfa ? `MFAUsed=${mfa}` : "", EXPOSURE.test(name) ? JSON.stringify(req).slice(0, 300) : ""].filter(Boolean).join(" "),
  };
}

export function mapOkta(r: Record<string, unknown>): Mapped | null {
  const type = str(r.eventType);
  if (!type || !r.actor) return null;
  const result = str(get(r, "outcome.result"))?.toUpperCase();
  const targets = Array.isArray(r.target) ? (r.target as Record<string, unknown>[]) : [];
  const target =
    targets
      .map((t) => str(t.alternateId) ?? str(t.displayName))
      .filter(Boolean)
      .join(", ") || undefined;
  let category: Category = "other";
  if (/^user\.(session\.start|authentication\.)/.test(type)) category = "auth";
  else if (/^(group\.user_membership\.add|user\.account\.privilege\.grant|application\.user_membership\.add)$/.test(type)) category = "privilege";
  else if (/^(user\.lifecycle\.create|user\.mfa\.factor\.(deactivate|reset_all)|system\.api_token\.create|user\.account\.reset_password)$/.test(type)) category = "account";
  else if (/^(policy\.lifecycle\.(deactivate|delete)|policy\.rule\.(deactivate|delete)|system\.log_stream\.(deactivate|delete)|zone\.(deactivate|delete))$/.test(type)) category = "logging";
  return {
    time: isoOrNull(r.published),
    source: "okta",
    category,
    action: type,
    outcome: result === "SUCCESS" || result === "ALLOW" ? "success" : result === "FAILURE" || result === "DENY" ? "failure" : "unknown",
    user: str(get(r, "actor.alternateId")),
    ip: str(get(r, "client.ipAddress")),
    target,
    agent: str(get(r, "client.userAgent.rawUserAgent")),
    privileged: /admin|super/i.test(target ?? "") && category === "privilege",
  };
}

const ADMIN_GROUP = /^(administrators|domain admins|enterprise admins|schema admins|account operators|backup operators|sudo|wheel|admin|root)$/i;

export function mapWindows(r: Record<string, unknown>): Mapped | null {
  const idRaw = first(r, ["EventID", "event_id", "winlog.event_id", "Event.System.EventID", "System.EventID"]);
  const id = Number(typeof idRaw === "object" && idRaw ? (idRaw as Record<string, unknown>)["#text"] : idRaw);
  if (!Number.isFinite(id)) return null;
  const d = (first(r, ["EventData", "winlog.event_data", "event_data", "Event.EventData"]) ?? r) as Record<string, unknown>;
  const f = (...k: string[]) => str(first(d, k) ?? first(r, k));
  const provider = f("ProviderName", "winlog.provider_name", "Event.System.Provider.Name", "SourceName") ?? "";
  const time = isoOrNull(first(r, ["TimeCreated", "@timestamp", "timestamp", "TimeGenerated", "Event.System.TimeCreated.SystemTime", "winlog.time_created"]));
  const host = f("Computer", "host.name", "winlog.computer_name", "Hostname");
  const base = { time, source: "windows" as const, host, action: String(id) };
  const sysmon = /sysmon/i.test(provider) || (id === 1 && f("Image") !== undefined);
  if (sysmon && id === 1) return { ...base, action: "sysmon:1", category: "process", outcome: "success", user: f("User"), process: f("Image"), parent: f("ParentImage"), command: f("CommandLine") };
  switch (id) {
    case 4624:
    case 4625:
      return {
        ...base,
        category: "auth",
        outcome: id === 4624 ? "success" : "failure",
        user: f("TargetUserName"),
        ip: clean(f("IpAddress")),
        target: f("LogonType") ? `LogonType ${f("LogonType")}` : undefined,
      };
    case 4720:
      return { ...base, category: "account", outcome: "success", user: f("SubjectUserName"), target: f("TargetUserName") };
    case 4728:
    case 4732:
    case 4756: {
      const group = f("TargetUserName") ?? "";
      return {
        ...base,
        category: "privilege",
        outcome: "success",
        user: f("SubjectUserName"),
        target: `${f("MemberName") ?? f("MemberSid") ?? "member"} → ${group}`,
        privileged: ADMIN_GROUP.test(group),
      };
    }
    case 4688:
      return {
        ...base,
        category: "process",
        outcome: "success",
        user: f("SubjectUserName"),
        process: f("NewProcessName"),
        parent: f("ParentProcessName"),
        command: f("CommandLine", "ProcessCommandLine"),
      };
    case 4697:
    case 7045:
      return {
        ...base,
        category: "account",
        action: `${id} service installed`,
        outcome: "success",
        user: f("SubjectUserName", "AccountName"),
        target: f("ServiceName"),
        command: f("ServiceFileName", "ImagePath"),
      };
    case 1102:
    case 104:
      return { ...base, category: "logging", outcome: "success", user: f("SubjectUserName", "param1"), target: id === 1102 ? "Security log" : (f("Channel", "param2") ?? "event log") };
    default:
      return { ...base, category: "other", outcome: "unknown", user: f("SubjectUserName", "TargetUserName") };
  }
}
const clean = (ip?: string) => (ip && ip !== "-" && ip !== "::1" && ip !== "127.0.0.1" ? ip.replace(/^::ffff:/, "") : undefined);

export function mapZeekDns(r: Record<string, unknown>): Mapped | null {
  const q = str(first(r, ["query", "dns.question.name"]));
  const client = str(first(r, ["id.orig_h", "source.ip", "client.ip"]));
  if (!q || !client) return null;
  return {
    time: isoOrNull(first(r, ["ts", "@timestamp", "timestamp"])),
    source: "dns",
    category: "dns",
    action: "query",
    outcome: "unknown",
    ip: client,
    query: q.toLowerCase(),
    rcode: str(first(r, ["rcode_name", "dns.response_code"])),
  };
}

/* ---------------------------------------------------------- syslog parsers */

const SYSLOG = /^(?:(\w{3})\s+(\d{1,2}) (\d{2}:\d{2}:\d{2})|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)) (\S+) ([\w.-]+)(?:\[\d+\])?: (.*)$/;

export function parseSyslogLine(raw: string, year: number): Mapped | null {
  const m = SYSLOG.exec(raw);
  if (!m) return null;
  const [, mon, day, hms, iso, host, prog, msg] = m as unknown as string[];
  const time = iso ? isoOrNull(iso) : isoOrNull(`${year}-${MONTHS[mon!] ?? "01"}-${day!.padStart(2, "0")}T${hms}Z`);
  const base = { time, source: "linux_auth" as const, host };
  let x: RegExpExecArray | null;
  if (prog === "sudo") {
    if ((x = /^\s*(\S+) : (?:(\d+) incorrect password attempts? ; )?.*?USER=(\S+) ; COMMAND=(.*)$/.exec(msg!)))
      return { ...base, category: "privilege", action: "sudo", outcome: x[2] ? "failure" : "success", user: x[1], target: x[3], command: x[4], privileged: x[3] === "root" };
    if ((x = /pam_unix\(sudo:auth\): authentication failure;.*?user=(\S+)/.exec(msg!))) return { ...base, category: "privilege", action: "sudo", outcome: "failure", user: x[1], target: "root" };
    return null;
  }
  if (prog === "su") {
    if ((x = /^(FAILED SU )?\(to (\S+)\) (\S+) on/.exec(msg!)))
      return { ...base, category: "privilege", action: "su", outcome: x[1] ? "failure" : "success", user: x[3], target: x[2], privileged: x[2] === "root" };
    return null;
  }
  if (prog === "useradd" || prog === "adduser") {
    if ((x = /new user: name=([^,\s]+)/.exec(msg!))) return { ...base, category: "account", action: "useradd", outcome: "success", target: x[1] };
    return null;
  }
  if (prog === "usermod" || prog === "gpasswd") {
    if ((x = /add '([^']+)' to (?:shadow )?group '([^']+)'/.exec(msg!)) ?? (x = /user (\S+) added by \S+ to group (\S+)/.exec(msg!)))
      return { ...base, category: "privilege", action: "group_add", outcome: "success", user: x[1], target: `${x[1]} → ${x[2]}`, privileged: ADMIN_GROUP.test(x[2]!) };
    return null;
  }
  if (prog === "userdel" && (x = /delete user '([^']+)'/.exec(msg!))) return { ...base, category: "account", action: "userdel", outcome: "success", target: x[1] };
  if (prog === "passwd" && (x = /password changed for (\S+)/.exec(msg!))) return { ...base, category: "account", action: "password_change", outcome: "success", target: x[1] };
  if (prog === "crontab" && (x = /^\((\S+)\) (REPLACE|BEGIN EDIT|END EDIT|DELETE) \((\S+)\)/.exec(msg!)))
    return { ...base, category: "account", action: `crontab ${x[2]}`, outcome: "success", user: x[1], target: x[3] };
  if (prog === "CRON" && (x = /^\((\S+)\) CMD \((.*)\)$/.exec(msg!))) return { ...base, category: "process", action: "cron", outcome: "success", user: x[1], command: x[2], process: "cron" };
  if (prog === "systemd" && (x = /^(Stopp(?:ed|ing)) (.*(?:System Logging|Security Auditing|auditd|rsyslog|journal|syslog|osquery|falcon|crowdstrike|wazuh|ossec|clamav|fail2ban).*)$/i.exec(msg!)))
    return { ...base, category: "logging", action: "service_stop", outcome: "success", target: x[2]!.replace(/\.$/, "") };
  if (prog === "auditd" && /(audit daemon is exiting|auditd stopped|terminated)/i.test(msg!)) return { ...base, category: "logging", action: "auditd_stop", outcome: "success", target: "auditd" };
  return null;
}

const BIND = /^(\S+ \S+ )?.*?client (?:@\S+ )?([\da-fA-F.:]+)#\d+.*?query: (\S+) IN (\w+)/;
const DNSMASQ = /dnsmasq\[\d+\]: query\[(\w+)\] (\S+) from ([\da-fA-F.:]+)/;

function parseDnsLine(raw: string, year: number): Mapped | null {
  let m = BIND.exec(raw);
  if (m) {
    const t = /^(\d{2}-\w{3}-\d{4} \d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(raw)?.[1];
    return { time: t ? isoOrNull(`${t.replace(/-/g, " ")} UTC`) : null, source: "dns", category: "dns", action: "query", outcome: "unknown", ip: m[2], query: m[3]!.toLowerCase().replace(/\.$/, "") };
  }
  m = DNSMASQ.exec(raw);
  if (m) {
    const s = SYSLOG.exec(raw);
    const time = s ? (s[4] ? isoOrNull(s[4]) : isoOrNull(`${year}-${MONTHS[s[1]!] ?? "01"}-${s[2]!.padStart(2, "0")}T${s[3]}Z`)) : null;
    return { time, source: "dns", category: "dns", action: "query", outcome: "unknown", ip: m[3], query: m[2]!.toLowerCase() };
  }
  return null;
}

/* --------------------------------------------------------------- pipeline */

function fromLegacy(e: LogEvent, bytes: number | undefined): HuntEvent {
  const web = e.kind === "web";
  return {
    ref: `${e.file}:${e.line}`,
    file: e.file,
    line: e.line,
    time: e.time,
    source: /sshd\[/.test(e.raw) ? "ssh" : e.raw.trimStart().startsWith("{") ? "json" : web ? "web_access" : "text",
    category: web ? "web" : e.kind === "other" ? "other" : "auth",
    action: web ? `${e.method ?? "?"} ${e.path ?? ""}`.trim() : e.kind === "auth_fail" ? "login" : e.kind === "auth_ok" ? "login" : "event",
    outcome: e.kind === "auth_fail" ? "failure" : e.kind === "auth_ok" ? "success" : web && e.status ? (e.status < 400 ? "success" : "failure") : "unknown",
    user: e.user,
    ip: e.ip ?? undefined,
    method: e.method,
    path: e.path,
    status: e.status,
    bytes,
    agent: e.agent,
    raw: cleanRaw(e.raw),
  };
}

const JSON_MAPPERS = [mapCloudTrail, mapOkta, mapWindows, mapZeekDns];

export interface FileInventory {
  file: string;
  formats: Partial<Record<SourceKind, number>>;
  events: number;
  unparsed: number;
  first: string | null;
  last: string | null;
  /** Share of events with each field present (0–1). */
  fields: Record<"time" | "user" | "ip" | "host" | "process", number>;
  /** Large gaps between consecutive events: possible missing telemetry. */
  gaps: { from: string; to: string; hours: number }[];
  assumptions: string[];
}

export interface ParsedLogs {
  events: HuntEvent[];
  inventory: FileInventory[];
  /** Same events in the legacy shape, for the original web/auth detections. */
  legacy: LogEvent[];
}

export function parseHuntLogs(files: LogFile[], year = new Date().getUTCFullYear()): ParsedLogs {
  const events: HuntEvent[] = [];
  const legacy: LogEvent[] = [];
  const inventory: FileInventory[] = [];
  for (const f of files) {
    const mine: HuntEvent[] = [];
    let unparsed = 0;
    const text = f.content.trim();
    // Whole-file JSON: a CloudTrail {"Records":[...]} download or an array of events.
    let whole: unknown[] | null = null;
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const j = JSON.parse(text) as unknown;
        whole = Array.isArray(j) ? j : Array.isArray((j as { Records?: unknown[] }).Records) ? (j as { Records: unknown[] }).Records : null;
      } catch {
        whole = null;
      }
    }
    if (whole) {
      whole.slice(0, 50_000).forEach((rec, i) => {
        const m = rec && typeof rec === "object" ? JSON_MAPPERS.map((fn) => fn(rec as Record<string, unknown>)).find(Boolean) : null;
        if (m) mine.push({ ...m, ref: `${f.name}#${i + 1}`, file: f.name, line: i + 1, raw: cleanRaw(JSON.stringify(rec)) });
        else unparsed++;
      });
    } else {
      const lines = f.content.split(/\r?\n/);
      const rest = lines.map((raw, i) => {
        if (!raw.trim()) return "";
        let m: Mapped | null = null;
        if (raw.trimStart().startsWith("{")) {
          try {
            const o = JSON.parse(raw) as Record<string, unknown>;
            m = JSON_MAPPERS.map((fn) => fn(o)).find(Boolean) ?? null;
          } catch {
            m = null;
          }
        } else m = parseSyslogLine(raw, year) ?? parseDnsLine(raw, year);
        if (!m) return raw;
        mine.push({ ...m, ref: `${f.name}:${i + 1}`, file: f.name, line: i + 1, raw: cleanRaw(raw) });
        return "";
      });
      // Everything else goes through the original parsers (web access, SSH, generic JSON) with line numbers intact.
      const old = parseLogs([{ name: f.name, content: rest.join("\n") }], year);
      unparsed = old.unparsed;
      for (const e of old.events) {
        const bytes = e.kind === "web" ? Number(/" \d{3} (\d+)/.exec(e.raw)?.[1]) : NaN;
        mine.push(fromLegacy(e, Number.isFinite(bytes) ? bytes : undefined));
        legacy.push(e);
      }
    }
    mine.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.line - b.line);
    events.push(...mine);
    inventory.push(inventoryFor(f.name, mine, unparsed, /^\w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} /m.test(f.content)));
  }
  // Auth events from cloud, identity and Windows sources join the original brute-force/spray detections too.
  for (const e of events)
    if (e.category === "auth" && (e.source === "cloudtrail" || e.source === "okta" || e.source === "windows") && e.ip)
      legacy.push({ file: e.file, line: e.line, time: e.time, ip: e.ip, kind: e.outcome === "failure" ? "auth_fail" : e.outcome === "success" ? "auth_ok" : "other", user: e.user, raw: e.raw });
  return { events, inventory, legacy };
}

function inventoryFor(file: string, ev: HuntEvent[], unparsed: number, syslogDates: boolean): FileInventory {
  const formats: FileInventory["formats"] = {};
  for (const e of ev) formats[e.source] = (formats[e.source] ?? 0) + 1;
  const share = (k: keyof HuntEvent) => (ev.length ? Math.round((ev.filter((e) => e[k] !== undefined && e[k] !== null && e[k] !== "").length / ev.length) * 100) / 100 : 0);
  const times = ev
    .map((e) => e.time)
    .filter((t): t is string => !!t)
    .sort();
  const gaps: FileInventory["gaps"] = [];
  if (times.length >= 20) {
    const diffs = times.slice(1).map((t, i) => Date.parse(t) - Date.parse(times[i]!));
    const median = [...diffs].sort((a, b) => a - b)[Math.floor(diffs.length / 2)]!;
    const limit = Math.max(3_600_000, median * 20);
    diffs.forEach((d, i) => {
      if (d > limit) gaps.push({ from: times[i]!, to: times[i + 1]!, hours: Math.round((d / 3_600_000) * 10) / 10 });
    });
  }
  const assumptions: string[] = [];
  if (syslogDates) assumptions.push("Syslog-style lines carry no year or time zone: the current year and UTC were assumed.");
  if (times.length < ev.length) assumptions.push(`${ev.length - times.length} event(s) had no usable timestamp and are left out of timelines.`);
  return {
    file,
    formats,
    events: ev.length,
    unparsed,
    first: times[0] ?? null,
    last: times.at(-1) ?? null,
    fields: { time: share("time"), user: share("user"), ip: share("ip"), host: share("host"), process: share("process") },
    gaps: gaps.sort((a, b) => b.hours - a.hours).slice(0, 5),
    assumptions,
  };
}

/** Telemetry Orbis can't read today, and the investigations that are blocked without it. */
export const NOT_CONNECTED: { source: string; blocks: string }[] = [
  { source: "SIEM (Splunk, Microsoft Sentinel, Elastic…)", blocks: "Searching your full log history and existing alerts; queries are generated for you to run there." },
  { source: "EDR (CrowdStrike, Defender for Endpoint, SentinelOne…)", blocks: "Live process, file and network activity on endpoints beyond what you export." },
  { source: "Network flow, firewall, proxy and VPN logs", blocks: "Outbound connections, data volumes leaving the network and command-and-control traffic." },
  { source: "Email security and phishing reports", blocks: "Phishing delivery, clicks and mailbox rule changes." },
  { source: "Live cloud audit feeds (CloudTrail, Azure Activity, GCP Audit) and identity providers", blocks: "Anything outside the exports you upload; no continuous collection." },
  { source: "Container and Kubernetes audit logs", blocks: "Workload and cluster activity." },
];

const QUERY_FIELDS = new Set(["user", "ip", "host", "source", "category", "action", "outcome", "process", "command", "path", "query"]);

/** field:value terms (all must match, case-insensitive substring); other words search the raw line. */
export function filterEvents(events: HuntEvent[], q: string): HuntEvent[] {
  const terms = q.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return events;
  return events.filter((e) =>
    terms.every((t) => {
      const m = /^(\w+):(.+)$/.exec(t);
      if (m && QUERY_FIELDS.has(m[1]!))
        return String((e as unknown as Record<string, unknown>)[m[1]!] ?? "")
          .toLowerCase()
          .includes(m[2]!.toLowerCase());
      return e.raw.toLowerCase().includes(t.toLowerCase());
    }),
  );
}
