import { callJson, ConnectorError } from "../connectors/http";
import type { ToolContext } from "../connectors/types";
import { isPublicAddress } from "./net-pure";
import { fingerprint, type Confidence, type FindingDraft, type Severity } from "./types";

/**
 * Cloudflare Application Protection review (Workflow G, Sentinel action "cloudflare"). Read-only inspection of a
 * zone's TLS/HTTPS settings, WAF / rate-limit / HTTP DDoS rulesets, bot protection, DNS records that bypass the proxy,
 * and the account's Zero Trust Access policies, through the person's own scoped API token. Every area records whether
 * it was checked; an area the token can't read is "missing permission" — never assumed secure — and the audit is then
 * incomplete. Nothing is changed here; the few setting changes Orbis offers are in `CF_CHANGES` and run only after
 * approval (see the changes route).
 */

const API = "https://api.cloudflare.com/client/v4";

export type Area = "tls" | "waf" | "ratelimit" | "ddos" | "bot" | "dns" | "access" | "events";
export const AREA_LABEL: Record<Area, string> = {
  tls: "TLS and HTTPS settings",
  waf: "WAF managed and custom rules",
  ratelimit: "Rate limiting",
  ddos: "HTTP DDoS protection",
  bot: "Bot protection",
  dns: "DNS proxying (origin exposure)",
  access: "Zero Trust Access policies",
  events: "Security events (last 24 hours)",
};
/** Which rule prefix each area's findings use (for "not detected" on re-check). */
export const AREA_PREFIX: Record<Exclude<Area, "events">, string> = {
  tls: "cloudflare.tls.",
  waf: "cloudflare.waf.",
  ratelimit: "cloudflare.ratelimit.",
  ddos: "cloudflare.ddos.",
  bot: "cloudflare.bot.",
  dns: "cloudflare.dns.",
  access: "cloudflare.access.",
};

export type Coverage = Record<Area, { status: "checked" | "missing_permission" | "unavailable" | "error"; detail: string }>;

export interface ZoneInfo {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  plan: string;
  accountId: string | null;
  accountName: string | null;
}

export interface ZoneSnapshot {
  zone: ZoneInfo;
  settings: Record<string, unknown> | null;
  /** Entrypoint rulesets by phase; null = none deployed; undefined = not read. */
  phases: Partial<Record<"http_request_firewall_managed" | "http_request_firewall_custom" | "http_ratelimit" | "ddos_l7", RulesetRule[] | null>>;
  bot: { fightMode: boolean | null; definitelyAutomated: string | null; aiBotsProtection: string | null } | null;
  dns: { name: string; type: string; content: string; proxied: boolean }[] | null;
  events: { action: string; source: string; count: number }[] | null;
  coverage: Coverage;
}

export interface RulesetRule {
  action: string;
  enabled: boolean;
  description: string;
  expression: string;
  /** For "execute" rules: the managed ruleset deployed. */
  executes: string | null;
  overrides: { action?: string; sensitivity?: string } | null;
}

export interface AccessApp {
  id: string;
  name: string;
  domain: string | null;
  type: string;
  policies: { name: string; decision: string; everyone: boolean; mfa: boolean; include: string[] }[];
}

/** Cloudflare's managed WAF rulesets (stable public ids). */
export const MANAGED_RULESETS: Record<string, string> = {
  efb7b8c949ac4650a09736fc376e9aee: "Cloudflare Managed Ruleset",
  "4814384a9e5d4991b9815dcfc25d2f1f": "Cloudflare OWASP Core Ruleset",
  "77454fe2d30c4220b5701f6fdfb893ba": "Cloudflare Free Managed Ruleset",
  c2e184081120413c86c3ab7e14069605: "Cloudflare Exposed Credentials Check",
};

/* ------------------------------------------------------------------ reads */

interface Env<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
}

type Read<T> = { ok: true; value: T } | { ok: false; status: Coverage[Area]["status"]; detail: string };

async function read<T>(ctx: ToolContext, path: string, opts: { notFoundIsEmpty?: boolean } = {}): Promise<Read<T | null>> {
  try {
    const r = await callJson<Env<T>>(`${API}${path}`, { token: ctx.token, service: "Cloudflare", signal: ctx.signal, retries: 1 }, ctx.fetch);
    if (!r.success) return { ok: false, status: "error", detail: r.errors?.[0]?.message?.slice(0, 160) ?? "request failed" };
    return { ok: true, value: r.result };
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    if (err instanceof ConnectorError) {
      if (err.kind === "not_found" && opts.notFoundIsEmpty) return { ok: true, value: null };
      if (err.kind === "permission" || err.status === 403) return { ok: false, status: "missing_permission", detail: "the token can't read this" };
      if (err.kind === "auth") throw err;
      return { ok: false, status: err.kind === "not_found" || err.kind === "bad_request" ? "unavailable" : "error", detail: err.message.slice(0, 160) };
    }
    return { ok: false, status: "error", detail: "request failed" };
  }
}

export async function listZones(ctx: ToolContext): Promise<ZoneInfo[]> {
  const r = await read<{ id: string; name: string; status: string; paused?: boolean; plan?: { name?: string }; account?: { id?: string; name?: string } }[]>(ctx, "/zones?per_page=50");
  if (!r.ok) throw new ConnectorError(r.status === "missing_permission" ? "permission" : "unavailable", r.status === "missing_permission" ? "The token can't list zones. Add Zone: Read to it." : `Cloudflare: ${r.detail}`);
  return (r.value ?? []).map((z) => ({ id: z.id, name: z.name, status: z.status, paused: !!z.paused, plan: z.plan?.name ?? "unknown", accountId: z.account?.id ?? null, accountName: z.account?.name ?? null }));
}

const rules = (raw: unknown): RulesetRule[] =>
  (Array.isArray((raw as { rules?: unknown[] })?.rules) ? (raw as { rules: Record<string, unknown>[] }).rules : []).map((r) => {
    const ap = (r.action_parameters ?? {}) as { id?: string; overrides?: { action?: string; sensitivity_level?: string; rules?: { action?: string; sensitivity_level?: string }[] } };
    return {
      action: String(r.action ?? ""),
      enabled: r.enabled !== false,
      description: String(r.description ?? "").slice(0, 200),
      expression: String(r.expression ?? "").slice(0, 300),
      executes: typeof ap.id === "string" ? ap.id : null,
      overrides: ap.overrides ? { action: ap.overrides.action ?? ap.overrides.rules?.[0]?.action, sensitivity: ap.overrides.sensitivity_level ?? ap.overrides.rules?.[0]?.sensitivity_level } : null,
    };
  });

/** Everything about one zone, each area marked checked or not. */
export async function readZone(ctx: ToolContext, zone: ZoneInfo): Promise<ZoneSnapshot> {
  const z = encodeURIComponent(zone.id);
  const coverage = {} as Coverage;
  const mark = (area: Area, r: Read<unknown>, detail = "") => (coverage[area] = r.ok ? { status: "checked", detail } : { status: r.status, detail: r.detail });

  const [settingsR, managedR, customR, rateR, ddosR, botR, dnsR] = await Promise.all([
    read<{ id: string; value: unknown }[]>(ctx, `/zones/${z}/settings`),
    read<unknown>(ctx, `/zones/${z}/rulesets/phases/http_request_firewall_managed/entrypoint`, { notFoundIsEmpty: true }),
    read<unknown>(ctx, `/zones/${z}/rulesets/phases/http_request_firewall_custom/entrypoint`, { notFoundIsEmpty: true }),
    read<unknown>(ctx, `/zones/${z}/rulesets/phases/http_ratelimit/entrypoint`, { notFoundIsEmpty: true }),
    read<unknown>(ctx, `/zones/${z}/rulesets/phases/ddos_l7/entrypoint`, { notFoundIsEmpty: true }),
    read<{ fight_mode?: boolean; sbfm_definitely_automated?: string; ai_bots_protection?: string }>(ctx, `/zones/${z}/bot_management`),
    read<{ name: string; type: string; content: string; proxied?: boolean }[]>(ctx, `/zones/${z}/dns_records?per_page=200`),
  ]);

  const settings = settingsR.ok ? Object.fromEntries((settingsR.value ?? []).map((s) => [s.id, s.value])) : null;
  mark("tls", settingsR);
  const phases: ZoneSnapshot["phases"] = {};
  if (managedR.ok) phases.http_request_firewall_managed = managedR.value == null ? null : rules(managedR.value);
  if (customR.ok) phases.http_request_firewall_custom = customR.value == null ? null : rules(customR.value);
  mark("waf", managedR.ok ? customR : managedR);
  if (rateR.ok) phases.http_ratelimit = rateR.value == null ? null : rules(rateR.value);
  mark("ratelimit", rateR);
  if (ddosR.ok) phases.ddos_l7 = ddosR.value == null ? null : rules(ddosR.value);
  mark("ddos", ddosR, ddosR.ok && ddosR.value == null ? "Cloudflare's default HTTP DDoS protection (no overrides)" : "");
  const bot = botR.ok && botR.value ? { fightMode: typeof botR.value.fight_mode === "boolean" ? botR.value.fight_mode : null, definitelyAutomated: botR.value.sbfm_definitely_automated ?? null, aiBotsProtection: botR.value.ai_bots_protection ?? null } : null;
  mark("bot", botR);
  const dns = dnsR.ok ? (dnsR.value ?? []).map((d) => ({ name: d.name, type: d.type, content: String(d.content).slice(0, 255), proxied: !!d.proxied })) : null;
  mark("dns", dnsR);

  // Security events: optional (needs Analytics: Read). Counts only, as context for the report.
  let events: ZoneSnapshot["events"] = null;
  try {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const q = {
      query: "query($zone:String!,$since:Time!){viewer{zones(filter:{zoneTag:$zone}){firewallEventsAdaptiveGroups(limit:20,filter:{datetime_geq:$since},orderBy:[count_DESC]){count dimensions{action source}}}}}",
      variables: { zone: zone.id, since },
    };
    const r = await callJson<{ data?: { viewer?: { zones?: { firewallEventsAdaptiveGroups?: { count: number; dimensions: { action: string; source: string } }[] }[] } }; errors?: { message: string }[] | null }>(
      `${API}/graphql`,
      { method: "POST", token: ctx.token, json: q, service: "Cloudflare", signal: ctx.signal, retries: 0 },
      ctx.fetch,
    );
    if (r.errors?.length) coverage.events = { status: /authoriz|permission|access/i.test(r.errors[0]!.message) ? "missing_permission" : "unavailable", detail: r.errors[0]!.message.slice(0, 160) };
    else {
      events = (r.data?.viewer?.zones?.[0]?.firewallEventsAdaptiveGroups ?? []).map((g) => ({ action: g.dimensions.action, source: g.dimensions.source, count: g.count }));
      coverage.events = { status: "checked", detail: "" };
    }
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    coverage.events = { status: err instanceof ConnectorError && err.kind === "permission" ? "missing_permission" : "error", detail: err instanceof ConnectorError ? err.message.slice(0, 160) : "request failed" };
  }
  coverage.access = { status: "unavailable", detail: "read per account" };
  return { zone, settings, phases, bot, dns, events, coverage };
}

/** Zero Trust Access applications and their policies for an account. */
export async function readAccess(ctx: ToolContext, accountId: string): Promise<Read<AccessApp[]>> {
  const r = await read<Record<string, unknown>[]>(ctx, `/accounts/${encodeURIComponent(accountId)}/access/apps?per_page=100`);
  if (!r.ok) return r;
  const apps: AccessApp[] = [];
  for (const a of (r.value ?? []).slice(0, 50)) {
    let pols = Array.isArray(a.policies) ? (a.policies as Record<string, unknown>[]) : null;
    if (!pols) {
      const p = await read<Record<string, unknown>[]>(ctx, `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(String(a.id))}/policies`);
      pols = p.ok ? (p.value ?? []) : [];
    }
    apps.push({
      id: String(a.id),
      name: String(a.name ?? a.domain ?? "app").slice(0, 120),
      domain: typeof a.domain === "string" ? a.domain : null,
      type: String(a.type ?? "self_hosted"),
      policies: pols.map((p) => {
        const include = (Array.isArray(p.include) ? p.include : []) as Record<string, unknown>[];
        const require = (Array.isArray(p.require) ? p.require : []) as Record<string, unknown>[];
        return {
          name: String(p.name ?? "policy").slice(0, 120),
          decision: String(p.decision ?? "allow"),
          everyone: include.some((i) => "everyone" in i),
          mfa: [...require, ...include].some((i) => JSON.stringify(i).includes('"mfa"')),
          include: include.map((i) => Object.keys(i)[0] ?? "?").slice(0, 10),
        };
      }),
    });
  }
  return { ok: true, value: apps };
}

/* ----------------------------------------------------------------- findings */

type Draft = { key: string; ruleId: string; title: string; description: string; severity: Severity; confidence: Confidence; rationale: string; location: string; evidence: { source: string; detail: string }[]; remediation: string; references: string[] };

const REF = {
  ssl: "https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/",
  https: "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/",
  tls: "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/",
  hsts: "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/",
  waf: "https://developers.cloudflare.com/waf/managed-rules/",
  rate: "https://developers.cloudflare.com/waf/rate-limiting-rules/",
  ddos: "https://developers.cloudflare.com/ddos-protection/managed-rulesets/http/",
  bot: "https://developers.cloudflare.com/bots/get-started/bot-fight-mode/",
  origin: "https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/",
  access: "https://developers.cloudflare.com/cloudflare-one/policies/access/",
};

export const zoneAsset = (zone: string) => `cloudflare:${zone}`;
export const accountAsset = (name: string) => `cloudflare-account:${name}`;

const MAIL_NAME = /^(mail|smtp|imap|pop3?|mx\d*|autodiscover|autoconfig|webmail|ftp|sftp|ssh|vpn)\./i;

/** Findings for one zone. Areas that weren't checked produce no findings (they're listed in coverage). */
export function zoneFindings(s: ZoneSnapshot): FindingDraft[] {
  const out: Draft[] = [];
  const z = s.zone.name;
  const ev = (area: string, detail: string) => ({ source: `Cloudflare API (${area}, read-only)`, detail });

  if (s.zone.paused) {
    out.push({
      key: "paused",
      ruleId: "cloudflare.tls.zone-paused",
      title: `Cloudflare is paused for ${z}`,
      description: "While a zone is paused, traffic goes straight to the origin: none of Cloudflare's DDoS, WAF, bot or TLS protection applies.",
      severity: "high",
      confidence: "confirmed",
      rationale: "Zone status reported by Cloudflare.",
      location: `${z} → Overview`,
      evidence: [ev("zone", "paused: true")],
      remediation: "Resume Cloudflare for the zone (Overview → Resume) unless it was paused deliberately for troubleshooting.",
      references: [REF.origin],
    });
  }

  if (s.settings) {
    const ssl = String(s.settings.ssl ?? "");
    if (ssl === "off" || ssl === "flexible") {
      out.push({
        key: "ssl",
        ruleId: `cloudflare.tls.ssl-${ssl}`,
        title: ssl === "off" ? `HTTPS is off for ${z}` : `Traffic from Cloudflare to the origin of ${z} isn't encrypted (Flexible SSL)`,
        description:
          ssl === "off"
            ? "SSL/TLS encryption mode is Off: visitors can't use HTTPS at all."
            : "In Flexible mode visitors see HTTPS, but Cloudflare connects to your server over plain HTTP, so anyone on that network path can read or change the traffic, including sign-in cookies.",
        severity: "high",
        confidence: "confirmed",
        rationale: "Setting reported by Cloudflare.",
        location: `${z} → SSL/TLS → Overview`,
        evidence: [ev("zone settings", `ssl: ${ssl}`)],
        remediation: "Install a certificate on the origin (a free Cloudflare Origin CA certificate works) and set the encryption mode to Full (strict).",
        references: [REF.ssl],
      });
    } else if (ssl === "full") {
      out.push({
        key: "ssl",
        ruleId: "cloudflare.tls.ssl-full-unvalidated",
        title: `Cloudflare doesn't validate the origin certificate for ${z} (Full, not strict)`,
        description: "In Full mode the connection to your server is encrypted, but any certificate is accepted, including a self-signed or expired one, so an attacker who can intercept that path can impersonate the origin.",
        severity: "medium",
        confidence: "confirmed",
        rationale: "Setting reported by Cloudflare; exploiting it needs a position between Cloudflare and the origin.",
        location: `${z} → SSL/TLS → Overview`,
        evidence: [ev("zone settings", "ssl: full")],
        remediation: "Make sure the origin has a valid or Cloudflare Origin CA certificate, then switch to Full (strict).",
        references: [REF.ssl],
      });
    }
    if (s.settings.always_use_https === "off" && ssl !== "off") {
      out.push({
        key: "https",
        ruleId: "cloudflare.tls.http-allowed",
        title: `${z} still serves plain HTTP`,
        description: "Always Use HTTPS is off, so visitors who type the address or follow an old http:// link use an unencrypted connection unless the origin redirects them.",
        severity: "medium",
        confidence: "firm",
        rationale: "Setting reported by Cloudflare; the origin or a redirect rule may still redirect, so a person should confirm.",
        location: `${z} → SSL/TLS → Edge Certificates`,
        evidence: [ev("zone settings", "always_use_https: off")],
        remediation: "Turn on Always Use HTTPS.",
        references: [REF.https],
      });
    }
    const minTls = String(s.settings.min_tls_version ?? "");
    if (minTls === "1.0" || minTls === "1.1") {
      out.push({
        key: "tls",
        ruleId: "cloudflare.tls.min-tls-old",
        title: `${z} accepts TLS ${minTls}`,
        description: `The minimum TLS version is ${minTls}. TLS 1.0 and 1.1 are deprecated (RFC 8996) and lack modern protections; all current browsers support TLS 1.2.`,
        severity: "low",
        confidence: "confirmed",
        rationale: "Setting reported by Cloudflare; practical attacks need old clients and a network position.",
        location: `${z} → SSL/TLS → Edge Certificates`,
        evidence: [ev("zone settings", `min_tls_version: ${minTls}`)],
        remediation: "Set Minimum TLS Version to 1.2.",
        references: [REF.tls],
      });
    }
    const hsts = (s.settings.security_header as { strict_transport_security?: { enabled?: boolean } } | undefined)?.strict_transport_security;
    if (hsts && hsts.enabled === false && ssl !== "off") {
      out.push({
        key: "hsts",
        ruleId: "cloudflare.tls.hsts-off",
        title: `HSTS isn't set by Cloudflare for ${z}`,
        description: "Cloudflare's HSTS setting is off. Unless your origin sends Strict-Transport-Security itself, browsers can be downgraded to HTTP on first visit.",
        severity: "low",
        confidence: "tentative",
        rationale: "The origin may send HSTS; Sentinel's header check on the live site confirms either way.",
        location: `${z} → SSL/TLS → Edge Certificates → HSTS`,
        evidence: [ev("zone settings", "security_header.strict_transport_security.enabled: false")],
        remediation: "Enable HSTS (start with a short max-age), or send the header from the origin. Only enable preload once every subdomain serves HTTPS.",
        references: [REF.hsts],
      });
    }
  }

  const managed = s.phases.http_request_firewall_managed;
  if (managed !== undefined) {
    const deployed = (managed ?? []).filter((r) => r.enabled && r.action === "execute" && r.executes && MANAGED_RULESETS[r.executes]);
    const logOnly = deployed.filter((r) => r.overrides?.action === "log");
    if (!deployed.length) {
      out.push({
        key: "waf",
        ruleId: "cloudflare.waf.managed-off",
        title: `No managed WAF rules are deployed on ${z}`,
        description: "Cloudflare's managed rulesets block common attacks (SQL injection, XSS, known CVE exploits) before they reach your server. None are deployed on this zone.",
        severity: "medium",
        confidence: "firm",
        rationale: `Read from the zone's managed WAF rules. On the ${s.zone.plan} plan only some managed rulesets may be available.`,
        location: `${z} → Security → WAF → Managed rules`,
        evidence: [ev("rulesets", managed == null ? "http_request_firewall_managed: no rules deployed" : `${managed.length} rule(s), none executing a managed ruleset`)],
        remediation: "Deploy the Cloudflare Managed Ruleset (or the Free Managed Ruleset on Free plans) in Security → WAF → Managed rules.",
        references: [REF.waf],
      });
    } else if (logOnly.length === deployed.length) {
      out.push({
        key: "waf-log",
        ruleId: "cloudflare.waf.managed-log-only",
        title: `Managed WAF rules on ${z} only log, they don't block`,
        description: `${deployed.map((r) => MANAGED_RULESETS[r.executes!]).join(", ")} ${deployed.length === 1 ? "is" : "are"} deployed with the action overridden to Log, so attacks are recorded but not stopped.`,
        severity: "medium",
        confidence: "confirmed",
        rationale: "Ruleset configuration reported by Cloudflare.",
        location: `${z} → Security → WAF → Managed rules`,
        evidence: [ev("rulesets", deployed.map((r) => `${MANAGED_RULESETS[r.executes!]}: override action log`).join("; "))],
        remediation: "Remove the Log override (use the default actions) once you've checked the logged events for false positives.",
        references: [REF.waf],
      });
    }
  }

  const rate = s.phases.http_ratelimit;
  if (rate !== undefined && !(rate ?? []).some((r) => r.enabled)) {
    out.push({
      key: "rate",
      ruleId: "cloudflare.ratelimit.none",
      title: `No rate-limiting rules on ${z}`,
      description: "Without rate limiting, sign-in, password-reset and API endpoints can be hammered (credential stuffing, scraping, cost attacks) as fast as the attacker likes.",
      severity: "low",
      confidence: "firm",
      rationale: "Read from the zone's rate-limiting rules; the application may limit requests itself.",
      location: `${z} → Security → WAF → Rate limiting rules`,
      evidence: [ev("rulesets", "http_ratelimit: no enabled rules")],
      remediation: "Add a rate-limiting rule for sensitive paths such as /login, /api/auth and password reset (for example 10 requests per minute per IP).",
      references: [REF.rate],
    });
  }

  const ddos = s.phases.ddos_l7;
  if (ddos) {
    const weakened = ddos.filter((r) => r.enabled && r.overrides && (r.overrides.action === "log" || r.overrides.sensitivity === "eoff"));
    if (weakened.length) {
      out.push({
        key: "ddos",
        ruleId: "cloudflare.ddos.l7-weakened",
        title: `HTTP DDoS protection on ${z} is set to log or essentially off`,
        description: "The HTTP DDoS managed ruleset has an override that logs instead of mitigating, or sets sensitivity to essentially off, so application-layer floods may reach your origin.",
        severity: "high",
        confidence: "confirmed",
        rationale: "Override reported by Cloudflare.",
        location: `${z} → Security → DDoS`,
        evidence: [ev("rulesets", weakened.map((r) => `${r.description || "override"}: action ${r.overrides!.action ?? "default"}, sensitivity ${r.overrides!.sensitivity ?? "default"}`).join("; "))],
        remediation: "Remove the override or restore the default action and sensitivity, unless it was set temporarily to stop false positives.",
        references: [REF.ddos],
      });
    }
  }

  if (s.bot && s.bot.fightMode === false && !s.bot.definitelyAutomated) {
    out.push({
      key: "bot",
      ruleId: "cloudflare.bot.off",
      title: `Bot protection is off for ${z}`,
      description: "Bot Fight Mode (or Super Bot Fight Mode) isn't on, so automated scrapers and credential-stuffing bots aren't challenged.",
      severity: "low",
      confidence: "firm",
      rationale: "Read from the zone's bot settings; it can interfere with legitimate API clients, so it isn't always right to turn on.",
      location: `${z} → Security → Bots`,
      evidence: [ev("bot management", `fight_mode: false${s.bot.aiBotsProtection ? ` · ai_bots_protection: ${s.bot.aiBotsProtection}` : ""}`)],
      remediation: "Turn on Bot Fight Mode, or on paid plans configure Super Bot Fight Mode to challenge definitely-automated traffic. Exclude API clients that need access.",
      references: [REF.bot],
    });
  }

  if (s.dns) {
    const proxiedIps = new Set(s.dns.filter((d) => d.proxied && (d.type === "A" || d.type === "AAAA")).map((d) => d.content));
    const exposed = s.dns.filter((d) => !d.proxied && (d.type === "A" || d.type === "AAAA") && isPublicAddress(d.content) && !MAIL_NAME.test(d.name));
    const sameOrigin = exposed.filter((d) => proxiedIps.has(d.content));
    for (const d of sameOrigin.slice(0, 10)) {
      out.push({
        key: `dns:${d.name}:${d.content}`,
        ruleId: "cloudflare.dns.origin-exposed",
        title: `${d.name} reveals the origin IP of proxied hostnames`,
        description: `${d.name} is DNS-only and points to ${d.content}, the same address that proxied hostnames on ${z} use. Anyone can look it up and send traffic straight to the origin, skipping Cloudflare's WAF and DDoS protection.`,
        severity: "high",
        confidence: "confirmed",
        rationale: "Both records are in the zone's DNS; DNS is public, so the bypass needs no special access.",
        location: `${z} → DNS → ${d.name}`,
        evidence: [ev("DNS records", `${d.type} ${d.name} → ${d.content} (DNS only); proxied records share this address`)],
        remediation: "Proxy this record (orange cloud) or move the service to another address, and make the origin accept web traffic only from Cloudflare's IP ranges (or use Cloudflare Tunnel).",
        references: [REF.origin],
      });
    }
    const others = exposed.filter((d) => !proxiedIps.has(d.content));
    if (others.length) {
      out.push({
        key: "dns-only",
        ruleId: "cloudflare.dns.unproxied",
        title: `${others.length} web-facing DNS record${others.length === 1 ? "" : "s"} on ${z} bypass Cloudflare`,
        description: `These records are DNS-only, so traffic to them gets none of Cloudflare's protection: ${others.slice(0, 8).map((d) => d.name).join(", ")}${others.length > 8 ? "…" : ""}. That can be intended (non-HTTP services), but if any of them serves a website or API, or shares a server with proxied sites, it's an unprotected way in.`,
        severity: "low",
        confidence: "tentative",
        rationale: "Whether each record serves web traffic, and whether it shares the origin, can't be told from DNS alone.",
        location: `${z} → DNS`,
        evidence: [ev("DNS records", others.slice(0, 15).map((d) => `${d.type} ${d.name} → ${d.content}`).join("; "))],
        remediation: "Proxy records that serve HTTP(S). For the rest, make sure they don't point at the same server as your proxied sites.",
        references: [REF.origin],
      });
    }
  }

  const asset = zoneAsset(z);
  return out.map<FindingDraft>(({ key, ...d }) => ({ ...d, agent: "sentinel", asset, evidenceSource: "cloudflare:api", fingerprint: fingerprint("sentinel", d.ruleId, asset, key) }));
}

/** Findings for an account's Access applications. Never proposes changes to policies (that could lock people out). */
export function accessFindings(accountName: string, apps: AccessApp[]): FindingDraft[] {
  const out: Draft[] = [];
  for (const a of apps) {
    const open = a.policies.filter((p) => p.everyone && (p.decision === "allow" || p.decision === "bypass"));
    if (open.length) {
      const bypass = open.some((p) => p.decision === "bypass");
      out.push({
        key: `everyone:${a.id}`,
        ruleId: "cloudflare.access.everyone",
        title: `Access application ${a.name} ${bypass ? "is bypassed for everyone" : "lets everyone in"}`,
        description: bypass
          ? `A Bypass policy that includes Everyone turns Access off for ${a.domain ?? a.name}: anyone on the internet reaches it without signing in.`
          : `An Allow policy that includes Everyone admits anyone who can authenticate with any login method (including a one-time PIN to any email address), which is close to no restriction for ${a.domain ?? a.name}.`,
        severity: "high",
        confidence: "confirmed",
        rationale: "Policy reported by Cloudflare. Intended for public resources only.",
        location: `Zero Trust → Access → Applications → ${a.name}`,
        evidence: [{ source: "Cloudflare API (Access, read-only)", detail: open.map((p) => `${p.name}: ${p.decision}, include ${p.include.join(", ")}`).join("; ") }],
        remediation: "Replace Everyone with specific emails, email domains or identity-provider groups. Orbis doesn't change Access policies: review the change and keep an admin path so nobody gets locked out.",
        references: [REF.access],
      });
    } else if (a.policies.some((p) => p.decision === "allow") && !a.policies.some((p) => p.mfa)) {
      out.push({
        key: `mfa:${a.id}`,
        ruleId: "cloudflare.access.no-mfa",
        title: `Access application ${a.name} doesn't require MFA`,
        description: `No policy on ${a.domain ?? a.name} requires multi-factor authentication, so a stolen password (or email account) is enough to get in.`,
        severity: "medium",
        confidence: "tentative",
        rationale: "Your identity provider may enforce MFA itself; Cloudflare can't see that.",
        location: `Zero Trust → Access → Applications → ${a.name}`,
        evidence: [{ source: "Cloudflare API (Access, read-only)", detail: a.policies.map((p) => `${p.name}: ${p.decision}, include ${p.include.join(", ")}`).join("; ") }],
        remediation: "Add a Require rule for authentication method MFA, or confirm your identity provider enforces it.",
        references: [REF.access],
      });
    }
  }
  const asset = accountAsset(accountName);
  return out.map<FindingDraft>(({ key, ...d }) => ({ ...d, agent: "sentinel", asset, evidenceSource: "cloudflare:api", fingerprint: fingerprint("sentinel", d.ruleId, asset, key) }));
}

/** Coverage problems, in words: what wasn't checked and which permission would fix it. */
export const PERMISSION_FOR: Record<Area, string> = {
  tls: "Zone Settings: Read",
  waf: "Zone WAF: Read",
  ratelimit: "Zone WAF: Read",
  ddos: "Zone WAF: Read (DDoS rulesets)",
  bot: "Bot Management: Read",
  dns: "DNS: Read",
  access: "Access: Apps and Policies Read (account)",
  events: "Analytics: Read",
};

export function coverageGaps(c: Partial<Coverage>): { area: Area; status: string; fix: string | null }[] {
  return (Object.keys(AREA_LABEL) as Area[])
    .filter((a) => c[a] && c[a]!.status !== "checked")
    .map((a) => ({ area: a, status: c[a]!.status, fix: c[a]!.status === "missing_permission" ? PERMISSION_FOR[a] : null }));
}

/* ----------------------------------------------------- approved setting changes */

export interface ChangeDef {
  setting: "ssl" | "always_use_https" | "min_tls_version";
  value: string;
  label: string;
  impact: string;
  /** Values from which this change makes sense (anything else: nothing to do). */
  from: string[];
}

/**
 * The only changes Orbis offers on Cloudflare: three zone settings, each reversible by setting the old value back.
 * DNS, firewall rules and Access policies are never changed by Orbis.
 */
export const CF_CHANGES: Record<string, ChangeDef> = {
  "cloudflare.tls.ssl-off": { setting: "ssl", value: "strict", label: "Set SSL/TLS encryption mode to Full (strict)", from: ["off"], impact: "Cloudflare will connect to your origin over HTTPS and require a valid certificate (publicly trusted or Cloudflare Origin CA). If the origin has none, visitors get error 526 until one is installed. Check the origin first." },
  "cloudflare.tls.ssl-flexible": { setting: "ssl", value: "strict", label: "Set SSL/TLS encryption mode to Full (strict)", from: ["flexible"], impact: "Cloudflare will connect to your origin over HTTPS and require a valid certificate. If the origin only serves HTTP or has no valid certificate, visitors get error 525/526. Install an Origin CA certificate first." },
  "cloudflare.tls.ssl-full-unvalidated": { setting: "ssl", value: "strict", label: "Set SSL/TLS encryption mode to Full (strict)", from: ["full"], impact: "Cloudflare will reject an invalid, expired or self-signed origin certificate (error 526). Fine if the origin has a publicly trusted or Cloudflare Origin CA certificate for this hostname." },
  "cloudflare.tls.http-allowed": { setting: "always_use_https", value: "on", label: "Turn on Always Use HTTPS", from: ["off"], impact: "All http:// requests get a 301 redirect to https://. Clients that can't use HTTPS (rare: very old devices, some IoT) stop working on this zone." },
  "cloudflare.tls.min-tls-old": { setting: "min_tls_version", value: "1.2", label: "Set Minimum TLS Version to 1.2", from: ["1.0", "1.1"], impact: "Clients that only support TLS 1.0/1.1 (Android 4.3 and older, Internet Explorer 10 and older, some old embedded clients) can no longer connect." },
};

export async function readSetting(ctx: ToolContext, zoneId: string, setting: string): Promise<string> {
  const r = await callJson<Env<{ id: string; value: unknown }>>(`${API}/zones/${encodeURIComponent(zoneId)}/settings/${encodeURIComponent(setting)}`, { token: ctx.token, service: "Cloudflare", signal: ctx.signal }, ctx.fetch);
  return String(r.result.value);
}

export async function writeSetting(ctx: ToolContext, zoneId: string, setting: string, value: string): Promise<string> {
  const r = await callJson<Env<{ id: string; value: unknown }>>(
    `${API}/zones/${encodeURIComponent(zoneId)}/settings/${encodeURIComponent(setting)}`,
    { method: "PATCH", token: ctx.token, json: { value }, service: "Cloudflare", signal: ctx.signal, retries: 0 },
    ctx.fetch,
  );
  return String(r.result.value);
}
