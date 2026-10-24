import type { Confidence, FindingDraft, Severity } from "../types";
import { SEVERITY_ORDER } from "../types";
import type { FileInventory, HuntEvent, ParsedLogs } from "./events";
import { ruleById, TACTICS, type Detection, type Tactic, type Technique } from "./rules";

/**
 * Turns detections into investigations, following the seven stages: triage, enrichment, timeline,
 * correlation, hypothesis testing, assessment and recommended response. Pure and deterministic — the AI
 * report is written from this, never the other way round.
 *
 * Grouping rule: signals join an investigation through the same user, host or account. A source address only
 * links signals when it isn't shared (fewer than three different users signed in from it); otherwise it's
 * recorded as a weak link and not used, so unrelated people behind one office or VPN address aren't merged.
 *
 * States set automatically are only New → Suspicious / Likely malicious / Inconclusive. Confirmed malicious,
 * Benign, Contained and Resolved are decisions people make; a high score never confirms anything.
 */

export const INVESTIGATION_STATES = ["new", "investigating", "suspicious", "likely_malicious", "confirmed_malicious", "benign", "inconclusive", "contained", "resolved"] as const;
export type InvestigationState = (typeof INVESTIGATION_STATES)[number];
export const STATE_LABEL: Record<InvestigationState, string> = {
  new: "New",
  investigating: "Investigating",
  suspicious: "Suspicious",
  likely_malicious: "Likely malicious",
  confirmed_malicious: "Confirmed malicious",
  benign: "Benign",
  inconclusive: "Inconclusive",
  contained: "Contained",
  resolved: "Resolved",
};
/** States only a person may set (with a note), never the engine. */
export const HUMAN_STATES: InvestigationState[] = ["investigating", "confirmed_malicious", "benign", "contained", "resolved"];

export interface Signal {
  /** The saved finding's fingerprint. */
  id: string;
  ruleId: string;
  title: string;
  observed: string;
  severity: Severity;
  confidence: Confidence;
  first: string | null;
  last: string | null;
  users: string[];
  ips: string[];
  hosts: string[];
  refs: string[];
}

export interface Hypothesis {
  kind: "malicious" | "benign";
  statement: string;
  supports: string[];
  contradicts: string[];
  verdict: "supported" | "contradicted" | "open";
}

export interface ChainStep {
  tactic: Tactic;
  techniques: Technique[];
  signalIds: string[];
  /** observed: the events show it; attempted: tried, success not shown; inferred: plausible from other steps. */
  status: "observed" | "attempted" | "inferred";
  first: string | null;
}

export interface ResponseItem {
  text: string;
  /** Consequential actions need someone with authority to approve them first. */
  approval: boolean;
}

export interface ResponsePlan {
  priorities: string[];
  preserve: string[];
  scope: string[];
  containment: ResponseItem[];
  credentials: ResponseItem[];
  investigate: string[];
  eradication: ResponseItem[];
  validation: string[];
  followUp: string[];
}

export interface Handoff {
  to: "sentinel" | "code_guardian" | "research" | "writing";
  task: string;
  scope: string;
  evidence: string[];
  findings: string[];
  confidence: string;
  permissions: string;
  questions: string[];
}

export interface Investigation {
  id: string;
  title: string;
  state: InvestigationState;
  severity: Severity;
  /** How confident the assessment is, and why. */
  confidence: { level: "high" | "medium" | "low"; basis: string };
  urgency: "immediate" | "high" | "normal" | "low";
  /** For ordering only; never a verdict. */
  priority: number;
  signals: Signal[];
  entities: { users: string[]; ips: string[]; hosts: string[] };
  links: string[];
  window: { first: string | null; last: string | null };
  ongoing: boolean;
  timeline: { time: string | null; ref: string; label: string; signal?: string }[];
  gaps: { file: string; from: string; to: string; hours: number }[];
  chain: ChainStep[];
  hypotheses: Hypothesis[];
  assessment: string;
  questions: string[];
  blocked: string[];
  response: ResponsePlan;
  handoffs: Handoff[];
  /** Decisions people recorded (state changes with a reason, notes), oldest first. */
  decisions?: { at: string; state?: InvestigationState; note: string }[];
  /** What happened to each recommended action, keyed "section:index" (e.g. "containment:0"). Recorded by people. */
  actions?: Record<string, { status: ActionStatus; note?: string; at: string }>;
  /** Stored without timeline, hypotheses or response plan because the run record was full; the findings hold the evidence. */
  summaryOnly?: boolean;
  /** Earlier investigations that share an account, host or (unshared) address. */
  prior?: { runId: string; invId: string; title: string; state: InvestigationState; overlap: string[]; at: string }[];
}

export const ACTION_STATUSES = ["approved", "declined", "done", "verified"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** Earlier investigations sharing strong entities with this one (accounts, hosts, unshared addresses). */
export function relatedPrior(inv: Pick<Investigation, "entities">, earlier: { runId: string; at: string; investigations: Investigation[] }[]): NonNullable<Investigation["prior"]> {
  const mine = new Set([
    ...inv.entities.users.filter((u) => !GENERIC_USERS.has(u.toLowerCase())).map((u) => `account ${u.toLowerCase()}`),
    ...inv.entities.hosts.map((h) => `host ${h.toLowerCase()}`),
    ...inv.entities.ips.map((ip) => `address ${ip}`),
  ]);
  const out: NonNullable<Investigation["prior"]> = [];
  for (const run of earlier)
    for (const o of run.investigations) {
      const theirs = [...o.entities.users.map((u) => `account ${u.toLowerCase()}`), ...o.entities.hosts.map((h) => `host ${h.toLowerCase()}`), ...o.entities.ips.map((ip) => `address ${ip}`)];
      const overlap = [...new Set(theirs.filter((x) => mine.has(x)))];
      if (overlap.length) out.push({ runId: run.runId, invId: o.id, title: o.title, state: o.state, overlap: overlap.slice(0, 5), at: run.at });
    }
  return out.slice(0, 8);
}

const GENERIC_USERS = new Set(["root", "administrator", "admin", "system", "-", "unknown", "anonymous", "local system", "network service"]);
const uniq = <T>(xs: (T | undefined | null)[]) => [...new Set(xs.filter((x): x is T => x !== undefined && x !== null && x !== ""))];

/* ------------------------------------------------------------ signals */

export function signalFromDetection(d: Detection, fingerprintId: string): Signal {
  const times = d.events
    .map((e) => e.time)
    .filter((t): t is string => !!t)
    .sort();
  return {
    id: fingerprintId,
    ruleId: d.ruleId,
    title: d.title,
    observed: d.observed,
    severity: d.severity,
    confidence: d.confidence,
    first: times[0] ?? null,
    last: times.at(-1) ?? null,
    users: d.users,
    ips: d.ips,
    hosts: d.hosts,
    refs: d.events.map((e) => e.ref),
  };
}

/** A legacy finding (web/auth/reputation) as a signal, with its users and hosts looked up from the cited events. */
export function signalFromFinding(f: FindingDraft, byRef: Map<string, HuntEvent>): Signal {
  const refs = f.evidence.map((e) => e.source).filter((s) => byRef.has(s));
  const ev = refs.map((r) => byRef.get(r)!);
  const times = ev
    .map((e) => e.time)
    .filter((t): t is string => !!t)
    .sort();
  return {
    id: f.fingerprint,
    ruleId: f.ruleId,
    title: f.title,
    observed: f.description.replace(/ Hypothesis:.*$/s, ""),
    severity: f.severity,
    confidence: f.confidence,
    first: times[0] ?? null,
    last: times.at(-1) ?? null,
    users: uniq(ev.map((e) => e.user)),
    ips: uniq([...(f.location && /^[\d.:a-f]+$/i.test(f.location) ? [f.location] : []), ...ev.map((e) => e.ip)]),
    hosts: uniq(ev.map((e) => e.host)),
    refs,
  };
}

/* -------------------------------------------------------- correlation */

export function sharedAddresses(events: HuntEvent[]): Set<string> {
  const users = new Map<string, Set<string>>();
  for (const e of events) if (e.category === "auth" && e.outcome === "success" && e.ip && e.user) (users.get(e.ip) ?? users.set(e.ip, new Set()).get(e.ip)!).add(e.user.toLowerCase());
  return new Set([...users].filter(([, u]) => u.size >= 3).map(([ip]) => ip));
}

function groupSignals(signals: Signal[], shared: Set<string>): { members: Signal[]; links: string[] }[] {
  const parent = signals.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const reasons = new Map<number, Set<string>>();
  const union = (a: number, b: number, why: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) return;
    parent[rb] = ra;
    const r = reasons.get(ra) ?? new Set<string>();
    for (const x of reasons.get(rb) ?? []) r.add(x);
    r.add(why);
    reasons.set(ra, r);
  };
  const index = new Map<string, number>();
  const weak = new Set<string>();
  signals.forEach((s, i) => {
    const keys = [
      ...s.users.filter((u) => !GENERIC_USERS.has(u.toLowerCase())).map((u) => [`user:${u.toLowerCase()}`, `the account ${u}`] as const),
      // Accounts acted on (created, promoted) link to signals by that account.
      ...accountTargets(s).map((u) => [`user:${u}`, `the account ${u}`] as const),
      ...s.hosts.map((h) => [`host:${h.toLowerCase()}`, `the host ${h}`] as const),
      ...s.ips.filter((ip) => !shared.has(ip)).map((ip) => [`ip:${ip}`, `the source address ${ip}`] as const),
    ];
    for (const ip of s.ips.filter((x) => shared.has(x))) weak.add(`${ip} is used by several users, so it wasn't used to link signals.`);
    for (const [k, label] of keys) {
      const j = index.get(k);
      if (j === undefined) index.set(k, i);
      else union(j, i, `Linked through ${label}.`);
    }
  });
  const groups = new Map<number, Signal[]>();
  signals.forEach((s, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(s));
  return [...groups].map(([root, members]) => ({ members, links: [...(reasons.get(root) ?? []), ...[...weak].filter((w) => members.some((m) => m.ips.some((ip) => w.startsWith(ip))))] }));
}

function accountTargets(s: Signal): string[] {
  if (!/^(persist\.account-created|priv\.admin-grant|persist\.credential-added)$/.test(s.ruleId)) return [];
  const m = /:\s*([^\s→←(]+)/.exec(s.title) ?? /for ([^\s(]+)/.exec(s.title);
  return m ? [m[1]!.toLowerCase()] : [];
}

/* ------------------------------------------------------- the engine */

export interface BuildInput {
  parsed: ParsedLogs;
  signals: Signal[];
  /** Addresses with third-party reputation, for enrichment notes. */
  reputation?: { ip: string; score: number; reports: number; sharedHosting: boolean }[];
}

export function buildInvestigations(input: BuildInput): Investigation[] {
  const { parsed } = input;
  const byRef = new Map(parsed.events.map((e) => [e.ref, e]));
  const shared = sharedAddresses(parsed.events);
  const logEnd =
    parsed.events
      .map((e) => e.time)
      .filter((t): t is string => !!t)
      .sort()
      .at(-1) ?? null;
  const groups = groupSignals(input.signals, shared);
  return groups
    .map(({ members, links }, n) => build(`inv-${n + 1}`, members, links, parsed, byRef, shared, logEnd, input.reputation ?? []))
    .sort((a, b) => b.priority - a.priority)
    .map((inv, i) => ({ ...inv, id: `inv-${i + 1}` }));
}

const TACTIC_ORDER = (t: Tactic) => TACTICS.indexOf(t);

function build(
  id: string,
  members: Signal[],
  links: string[],
  parsed: ParsedLogs,
  byRef: Map<string, HuntEvent>,
  shared: Set<string>,
  logEnd: string | null,
  reputation: NonNullable<BuildInput["reputation"]>,
): Investigation {
  const signals = [...members].sort((a, b) => (a.first ?? "").localeCompare(b.first ?? ""));
  const users = uniq(signals.flatMap((s) => s.users));
  const ips = uniq(signals.flatMap((s) => s.ips));
  const hosts = uniq(signals.flatMap((s) => s.hosts));
  const times = signals
    .flatMap((s) => [s.first, s.last])
    .filter((t): t is string => !!t)
    .sort();
  const window = { first: times[0] ?? null, last: times.at(-1) ?? null };
  const ongoing = !!(window.last && logEnd && Date.parse(logEnd) - Date.parse(window.last) <= 3_600_000);
  const severity = signals.map((s) => s.severity).sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b])[0]!;

  // Stage 3 — timeline: the signals' events plus surrounding activity by the same identities (context).
  const signalRefs = new Map<string, string>();
  for (const s of signals) for (const r of s.refs) signalRefs.set(r, s.id);
  const entityUsers = new Set(users.filter((u) => !GENERIC_USERS.has(u.toLowerCase())).map((u) => u.toLowerCase()));
  const entityIps = new Set(ips.filter((ip) => !shared.has(ip)));
  const pad = 2 * 3_600_000;
  const lo = window.first ? Date.parse(window.first) - pad : -Infinity;
  const hi = window.last ? Date.parse(window.last) + pad : Infinity;
  const context = parsed.events.filter((e) => {
    if (signalRefs.has(e.ref) || !e.time) return false;
    const t = Date.parse(e.time);
    if (t < lo || t > hi) return false;
    return (e.user && entityUsers.has(e.user.toLowerCase())) || (e.ip && entityIps.has(e.ip) && e.category !== "web");
  });
  const timeline = [
    ...[...signalRefs]
      .map(([ref, sid]) => ({ ev: byRef.get(ref), ref, sid }))
      .filter((x) => x.ev)
      .map((x) => ({ time: x.ev!.time, ref: x.ref, label: describe(x.ev!), signal: x.sid })),
    ...context.map((e) => ({ time: e.time, ref: e.ref, label: describe(e) })),
  ]
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""))
    .slice(0, 60);
  const gaps = parsed.inventory.flatMap((f: FileInventory) => f.gaps.filter((g) => !window.first || (g.to >= window.first && g.from <= (window.last ?? g.from))).map((g) => ({ file: f.file, ...g })));

  // Attack chain: only tactics the signals evidence; attempts are kept apart from observed outcomes.
  const chainMap = new Map<Tactic, ChainStep>();
  for (const s of signals) {
    const rule = ruleById(s.ruleId);
    if (!rule) continue;
    const step = chainMap.get(rule.tactic) ?? { tactic: rule.tactic, techniques: [], signalIds: [], status: "observed" as ChainStep["status"], first: s.first };
    for (const t of rule.techniques) if (!step.techniques.some((x) => x.id === t.id)) step.techniques.push(t);
    // A step is as strong as its strongest signal: observed > attempted (tried, success not shown) > inferred (heuristic).
    const own: ChainStep["status"] =
      s.ruleId.startsWith("web.payload") || s.ruleId === "auth.brute-force" || s.ruleId === "auth.password-spray" ? "attempted" : s.confidence === "tentative" ? "inferred" : "observed";
    const rank = { observed: 2, attempted: 1, inferred: 0 } as const;
    if (!step.signalIds.length || rank[own] > rank[step.status]) step.status = own;
    step.signalIds.push(s.id);
    if ((s.first ?? "") < (step.first ?? "~")) step.first = s.first;
    chainMap.set(rule.tactic, step);
  }
  const chain = [...chainMap.values()].sort((a, b) => (a.first ?? "").localeCompare(b.first ?? "") || TACTIC_ORDER(a.tactic) - TACTIC_ORDER(b.tactic));

  const rules = new Set(signals.map((s) => s.ruleId.replace(/^web\.payload-.*/, "web.payload")));
  const has = (r: string) => rules.has(r);
  const strong = signals.filter((s) => (s.confidence === "confirmed" || s.confidence === "firm") && SEVERITY_ORDER[s.severity] <= SEVERITY_ORDER.medium);
  const tactics = new Set(chain.filter((c) => c.status !== "inferred").map((c) => c.tactic));
  const success = has("auth.success-after-failures");
  const afterAccess = signals.some((s) => /^(priv|persist|evasion|exec)\./.test(s.ruleId));
  const evasion = has("evasion.logging-disabled");
  const reconOnly = [...rules].every((r) => r === "web.scanning" || r === "web.payload" || r === "intel.abuseipdb" || r === "auth.brute-force" || r === "auth.password-spray");
  const allRejected = reconOnly && !signals.some((s) => s.severity === "high");
  const repHits = reputation.filter((r) => ips.includes(r.ip) && r.score >= 25);

  // Stage 5 — hypotheses: the malicious explanation and the benign ones, each with evidence for and against.
  const malicious: Hypothesis = {
    kind: "malicious",
    statement:
      signals.length === 1
        ? (ruleById(signals[0]!.ruleId)?.hypothesis ?? signals[0]!.title)
        : `Related malicious activity: ${uniq(signals.map((s) => ruleById(s.ruleId)?.hypothesis))
            .slice(0, 2)
            .join(" Then: ")}`,
    supports: [
      ...(tactics.size >= 2 ? [`Observed across ${tactics.size} stages: ${[...tactics].join(", ")}.`] : []),
      ...(success && afterAccess ? ["Privilege, persistence, evasion or execution activity follows a sign-in that succeeded after many failures."] : []),
      ...(evasion ? ["Logging or monitoring was changed — rarely routine."] : []),
      ...repHits.map(
        (r) => `${r.ip} has ${r.reports} third-party abuse report(s) (AbuseIPDB score ${r.score})${r.sharedHosting ? ", though it's a hosting/CDN address that many customers share" : ""}.`,
      ),
      ...strong.filter((s) => s.severity === "high").map((s) => `High-severity signal: ${s.title}.`),
    ],
    contradicts: [
      ...(allRejected ? ["Every attempt seen was rejected or failed; no sign of success."] : []),
      ...(signals.length === 1 && SEVERITY_ORDER[severity] >= SEVERITY_ORDER.low ? ["A single low-severity signal."] : []),
      ...(signals.every((s) => s.confidence === "tentative") ? ["Only tentative signals."] : []),
    ],
    verdict: "open",
  };
  malicious.verdict = malicious.supports.length >= 2 && !malicious.contradicts.length ? "supported" : malicious.contradicts.length && !malicious.supports.length ? "contradicted" : "open";
  const benign: Hypothesis[] = uniq(signals.flatMap((s) => ruleById(s.ruleId)?.benign ?? []))
    .slice(0, 4)
    .map((statement) => benignCheck(statement, signals, parsed.events, shared));

  // Stage 6 — state, confidence, urgency.
  let state: InvestigationState = "suspicious";
  if ((tactics.size >= 2 && strong.length >= 2) || (success && afterAccess) || (evasion && signals.length >= 2)) state = "likely_malicious";
  // Only weak, low-severity heuristics and nothing to tell explanations apart: the data can't resolve it.
  else if (signals.every((s) => s.confidence === "tentative") && SEVERITY_ORDER[severity] >= SEVERITY_ORDER.low && benign.every((b) => b.verdict !== "contradicted")) state = "inconclusive";
  const level: Investigation["confidence"]["level"] = state === "likely_malicious" && malicious.verdict === "supported" ? "high" : strong.length ? "medium" : "low";
  const basis =
    level === "high"
      ? `${malicious.supports.length} independent supporting observations and nothing contradicting them in the data available.`
      : level === "medium"
        ? `Directly observed signals${links.length ? ", grouped by shared identities or hosts" : ""}; benign explanations can't be ruled out from the logs alone.`
        : "Heuristic or single signals only; more evidence is needed.";
  const privileged = signals.some((s) => /^(priv|cloud\.root|evasion)\./.test(s.ruleId));
  const urgency: Investigation["urgency"] = state === "likely_malicious" && ongoing ? "immediate" : privileged || success || evasion ? "high" : reconOnly ? "low" : "normal";
  const priority =
    (4 - SEVERITY_ORDER[severity]) * 10 +
    (state === "likely_malicious" ? 25 : state === "suspicious" ? 10 : 0) +
    (urgency === "immediate" ? 20 : urgency === "high" ? 10 : 0) +
    Math.min(signals.length, 5);

  const blocked = blockedChecks(signals, parsed);
  const questions = [
    ...(success ? [`Did ${users.join(", ") || "the account owner"} sign in at ${signals.find((s) => s.ruleId === "auth.success-after-failures")?.last ?? "that time"}? Ask them directly.`] : []),
    ...(privileged ? ["Was the privilege or configuration change approved (change ticket, maintenance window)?"] : []),
    ...(gaps.length ? [`What happened during the ${gaps.length} gap(s) in the logs?`] : []),
    ...(ongoing ? ["The latest activity is at the end of the logs — is it still happening? Collect newer logs."] : []),
    ...benign.filter((b) => b.verdict === "open").map((b) => `Rule out: ${b.statement.toLowerCase()}.`),
  ].slice(0, 8);

  const title = chain.length >= 2 ? `${signals[0]!.title} → ${chain.at(-1)!.tactic.toLowerCase()}` : signals[0]!.title;
  const assessment = [
    `${STATE_LABEL[state]} (${level} confidence).`,
    signals.length > 1
      ? `${signals.length} related signals between ${window.first ?? "?"} and ${window.last ?? "?"} involving ${[users.length ? `account(s) ${users.slice(0, 4).join(", ")}` : "", hosts.length ? `host(s) ${hosts.slice(0, 3).join(", ")}` : "", ips.length ? `address(es) ${ips.slice(0, 3).join(", ")}` : ""].filter(Boolean).join("; ")}.`
      : signals[0]!.observed,
    chain.length ? `Stages evidenced: ${chain.map((c) => `${c.tactic} (${c.status})`).join(" → ")}.` : "",
    malicious.verdict === "supported"
      ? "The evidence supports a malicious explanation; confirmation still needs a person to check the open questions."
      : malicious.verdict === "contradicted"
        ? "The evidence points away from a successful attack."
        : "The data can't yet tell malicious and benign explanations apart.",
    blocked.length ? `${blocked.length} check(s) couldn't be done with the data available.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id,
    title: title.slice(0, 200),
    state,
    severity,
    confidence: { level, basis },
    urgency,
    priority,
    signals,
    entities: { users, ips, hosts },
    links,
    window,
    ongoing,
    timeline,
    gaps,
    chain,
    hypotheses: [malicious, ...benign],
    assessment,
    questions,
    blocked,
    response: responsePlan(signals, { users, ips, hosts }, evasion),
    handoffs: handoffs(signals, byRef, level),
  };
}

function describe(e: HuntEvent): string {
  const who = e.user ? `${e.user}` : e.ip ? e.ip : "unknown";
  switch (e.category) {
    case "auth":
      return `${e.outcome === "failure" ? "Failed" : e.outcome === "success" ? "Successful" : ""} sign-in ${e.user ? `as ${e.user} ` : ""}${e.ip ? `from ${e.ip}` : ""}`.trim();
    case "web":
      return `${e.ip ?? "?"} ${e.method ?? ""} ${(e.path ?? "").slice(0, 80)} → ${e.status ?? "?"}`;
    case "dns":
      return `${e.ip} looked up ${(e.query ?? "").slice(0, 80)}${e.rcode ? ` (${e.rcode})` : ""}`;
    case "process":
      return `${who} ran ${(e.command ?? e.process ?? "").slice(0, 100)}${e.parent ? ` (parent ${e.parent.split(/[\\/]/).pop()})` : ""}`;
    default:
      return `${who}: ${e.action}${e.target ? ` → ${e.target}` : ""}${e.command && e.category === "privilege" ? ` (${e.command.slice(0, 80)})` : ""}${e.outcome === "failure" ? " (failed)" : ""}`;
  }
}

function benignCheck(statement: string, signals: Signal[], events: HuntEvent[], shared: Set<string>): Hypothesis {
  const h: Hypothesis = { kind: "benign", statement, supports: [], contradicts: [], verdict: "open" };
  const s = signals.find((x) => (ruleById(x.ruleId)?.benign ?? []).includes(statement));
  if (!s) return h;
  if (/mistyped|stale saved password|password manager/i.test(statement)) {
    const fails = events.filter((e) => e.category === "auth" && e.outcome === "failure" && e.ip && s.ips.includes(e.ip));
    const names = uniq(fails.map((e) => e.user?.toLowerCase()));
    if (names.length > 1) h.contradicts.push(`Failures targeted ${names.length} different account names, not just one person's.`);
    else if (fails.length > 0 && fails.length <= 15) h.supports.push(`All ${fails.length} failures were for one account name.`);
    else if (fails.length > 15) h.contradicts.push(`${fails.length} failures is more than a person typically retries.`);
  }
  if (/office|school|shared|behind one/i.test(statement)) {
    if (s.ips.some((ip) => shared.has(ip))) h.supports.push("Several different users signed in successfully from the same address.");
    else h.contradicts.push("No other users signed in successfully from that address in these logs.");
  }
  if (/crawler|monitoring|scanner/i.test(statement)) {
    const agents = uniq(events.filter((e) => e.ip && s.ips.includes(e.ip) && e.agent).map((e) => e.agent!));
    if (agents.some((a) => /(googlebot|bingbot|duckduckbot|yandexbot|applebot|uptimerobot|pingdom|statuscake)/i.test(a)))
      h.supports.push(`User agent claims to be a known crawler or monitor (${agents[0]!.slice(0, 60)}); verify by reverse DNS, as user agents can be faked.`);
  }
  h.verdict = h.supports.length && !h.contradicts.length ? "supported" : h.contradicts.length && !h.supports.length ? "contradicted" : "open";
  return h;
}

function blockedChecks(signals: Signal[], parsed: ParsedLogs): string[] {
  const kinds = new Set(parsed.inventory.flatMap((f) => Object.keys(f.formats)));
  const out: string[] = [];
  const rules = new Set(signals.map((s) => s.ruleId));
  if ([...rules].some((r) => r.startsWith("auth.")) && !kinds.has("windows") && !kinds.has("linux_auth"))
    out.push("What the account did after signing in: no host or application audit logs for it were provided.");
  if ([...rules].some((r) => r.startsWith("exec.") || r.startsWith("dns."))) out.push("Which process made the connections or ran the payload end to end: needs EDR telemetry, which isn't connected.");
  if ([...rules].some((r) => r === "data.large-transfer" || r.startsWith("dns.tunneling"))) out.push("What data left: needs network flow, proxy or DLP logs, which aren't connected.");
  if ([...rules].some((r) => r.startsWith("web.payload"))) out.push("Whether an exploit attempt worked: request bodies and application logs aren't in access logs.");
  if ([...rules].some((r) => r === "evasion.logging-disabled")) out.push("Activity while logging was off can't be reconstructed from these logs.");
  return out;
}

/* ------------------------------------------------------------ response */

function responsePlan(signals: Signal[], ent: Investigation["entities"], evasion: boolean): ResponsePlan {
  const rules = new Set(signals.map((s) => s.ruleId));
  const any = (re: RegExp) => [...rules].some((r) => re.test(r));
  const who = ent.users.filter((u) => !GENERIC_USERS.has(u.toLowerCase())).join(", ") || "the affected accounts";
  const where = ent.hosts.join(", ") || "the affected systems";
  const addr = ent.ips.join(", ") || "the source addresses";
  const p: ResponsePlan = { priorities: [], preserve: [], scope: [], containment: [], credentials: [], investigate: [], eradication: [], validation: [], followUp: [] };
  p.preserve.push(`Export and keep the original logs for ${where} covering the investigation window (plus a day either side) before changing anything.`);
  if (evasion) {
    p.priorities.push("Turn logging and monitoring back on — everything after the change is invisible.");
    p.containment.push({ text: "Re-enable the stopped logging, trail or security service.", approval: true });
    p.preserve.push("Copy whatever logs remain to storage the affected accounts can't modify.");
  }
  if (any(/^auth\./)) {
    p.priorities.push(`Find out whether ${who} really signed in, and from where.`);
    p.scope.push(`List every sign-in for ${who} and every account targeted from ${addr} in the full log history.`);
    p.containment.push({ text: `Block or rate-limit ${addr} at the firewall, WAF or identity provider.`, approval: true });
    p.credentials.push({ text: `Reset the password and end active sessions/tokens for ${who}.`, approval: true }, { text: "Require MFA for the affected accounts.", approval: true });
    p.investigate.push(`Review what ${who} did after the sign-in (application, admin and cloud audit logs).`);
    p.validation.push(`No further sign-ins for ${who} from ${addr}; failed attempts stop or are blocked.`);
  }
  if (any(/^(priv|persist)\./)) {
    p.priorities.push("Check whether the new accounts, admin rights, keys, cron jobs or services were authorised.");
    p.preserve.push("Snapshot current group memberships, IAM policies, access keys, crontabs and service lists.");
    p.containment.push({ text: "Disable unapproved accounts and remove unapproved admin rights (after preserving evidence).", approval: true });
    p.credentials.push({ text: "Revoke unapproved access keys and API tokens; restore removed MFA.", approval: true });
    p.eradication.push({ text: "Remove unauthorised cron jobs, services and policies.", approval: true });
    p.validation.push("Re-list admin group members, keys and scheduled jobs and compare with the approved state.");
  }
  if (any(/^exec\./)) {
    p.priorities.push(`Decide whether to isolate ${where}.`);
    p.preserve.push("Capture memory and a disk image before rebooting or cleaning the host.");
    p.containment.push({ text: `Isolate ${where} from the network.`, approval: true }, { text: "Block the download URLs and addresses seen in the command lines.", approval: true });
    p.investigate.push("Decode encoded commands in an isolated environment and identify the parent document or web request.");
    p.eradication.push({ text: "Rebuild the host from a known-good image if malware ran.", approval: true });
  }
  if (any(/^cloud\./)) {
    p.containment.push({ text: "Revert the security group or bucket policy change.", approval: true });
    p.investigate.push("Review access logs (S3 server access, VPC flow logs) for the period the resource was exposed.");
    if (rules.has("cloud.root-activity")) p.credentials.push({ text: "Rotate the root password, enable MFA on root and remove any root access keys.", approval: true });
  }
  if (any(/^dns\./)) {
    p.containment.push({ text: "Block the domain at your DNS resolver or firewall.", approval: true });
    p.investigate.push("Identify the process on the client making the lookups (needs EDR or host logs).");
  }
  if (rules.has("data.large-transfer")) {
    p.investigate.push("Identify which records or files were in the largest responses; involve privacy/legal if personal data may be affected.");
    p.containment.push({ text: `Block ${addr} if the transfer wasn't legitimate.`, approval: true });
  }
  if (any(/^web\./)) {
    p.scope.push("Check whether probed paths or attacked endpoints returned real data (Sentinel can re-check the site).");
    p.containment.push({ text: `Block or rate-limit ${addr} at the WAF/CDN.`, approval: true });
  }
  p.followUp.push(
    "Keep watching the affected identities and hosts for 30 days.",
    "Turn the detections that fired into alerts in your SIEM (see Detection lab).",
    "Record what happened and what you changed (lessons learned).",
  );
  if (!p.priorities.length) p.priorities.push("Confirm whether the activity was expected.");
  return p;
}

function handoffs(signals: Signal[], byRef: Map<string, HuntEvent>, level: string): Handoff[] {
  const out: Handoff[] = [];
  const web200 = signals
    .filter((s) => s.ruleId.startsWith("web."))
    .flatMap((s) => s.refs.map((r) => byRef.get(r)).filter((e): e is HuntEvent => !!e && e.status !== undefined && e.status >= 200 && e.status < 300));
  if (web200.length)
    out.push({
      to: "sentinel",
      task: "Check whether these probed or attacked paths expose anything on the live site.",
      scope: "Read-only checks of your verified website.",
      evidence: web200.slice(0, 5).map((e) => e.ref),
      findings: uniq(web200.map((e) => e.path)).slice(0, 5),
      confidence: level,
      permissions: "Needs a verified website and your confirmation; active testing only if you choose it.",
      questions: ["Do these paths return sensitive content to anyone?"],
    });
  if (signals.some((s) => s.ruleId.startsWith("web.payload") && s.severity === "high"))
    out.push({
      to: "code_guardian",
      task: "Review the code behind endpoints that answered 2xx to attack payloads.",
      scope: "Read-only code audit.",
      evidence: signals
        .filter((s) => s.ruleId.startsWith("web.payload"))
        .flatMap((s) => s.refs)
        .slice(0, 5),
      findings: signals.filter((s) => s.ruleId.startsWith("web.payload")).map((s) => s.title),
      confidence: level,
      permissions: "Needs the code (upload or repository).",
      questions: ["Is the input on these endpoints validated and parameterised?"],
    });
  const techniques = uniq(signals.flatMap((s) => ruleById(s.ruleId)?.techniques.map((t) => `${t.id} ${t.name}`) ?? []));
  if (techniques.length)
    out.push({
      to: "research",
      task: `Find current, dated guidance on detecting and responding to: ${techniques.slice(0, 3).join("; ")}.`,
      scope: "Public sources only, with publication dates and reliability.",
      evidence: [],
      findings: signals.map((s) => s.title).slice(0, 5),
      confidence: "n/a",
      permissions: "Web research; nothing from your logs is sent except the technique names.",
      questions: ["What are the recommended detections and response steps?", "Are there recent advisories about these techniques targeting similar environments?"],
    });
  out.push({
    to: "writing",
    task: "Write a short executive summary and a technical record of this investigation.",
    scope: "From the investigation record only.",
    evidence: signals.flatMap((s) => s.refs).slice(0, 10),
    findings: signals.map((s) => s.title).slice(0, 8),
    confidence: level,
    permissions: "None beyond reading this record.",
    questions: [],
  });
  return out;
}

/* ------------------------------------------------------------ storage */

/** Size as the database measures it (UTF-8 bytes of the JSON). */
export const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** Levels of detail for stored investigations, richest first. The full evidence always stays in the findings. */
const DETAIL = [
  { timeline: 40, label: 140, signals: 10, observed: 300, refs: 5, hypotheses: 4, list: 99, handoffs: "full" },
  { timeline: 15, label: 120, signals: 8, observed: 240, refs: 3, hypotheses: 4, list: 5, handoffs: "full" },
  { timeline: 8, label: 110, signals: 6, observed: 200, refs: 2, hypotheses: 3, list: 4, handoffs: "lean" },
  { timeline: 5, label: 100, signals: 4, observed: 160, refs: 2, hypotheses: 2, list: 3, handoffs: "lean" },
  { timeline: 3, label: 90, signals: 3, observed: 120, refs: 1, hypotheses: 2, list: 2, handoffs: "none" },
] as const;
type Detail = (typeof DETAIL)[number];

const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function atDetail(i: Investigation, d: Detail): Investigation {
  const n = d.list;
  const r = i.response;
  return {
    ...i,
    assessment: cut(i.assessment, n >= 5 ? 900 : 500),
    timeline: i.timeline.slice(0, d.timeline).map((t) => ({ ...t, label: cut(t.label, d.label) })),
    signals: i.signals.slice(0, d.signals).map((s) => ({ ...s, title: cut(s.title, 160), observed: cut(s.observed, d.observed), refs: s.refs.slice(0, d.refs) })),
    chain: i.chain.map((c) => ({ ...c, techniques: c.techniques.slice(0, n >= 4 ? 4 : 2), signalIds: c.signalIds.slice(0, n) })),
    hypotheses: i.hypotheses.slice(0, d.hypotheses).map((h) => ({ ...h, supports: h.supports.slice(0, n).map((x) => cut(x, 200)), contradicts: h.contradicts.slice(0, n).map((x) => cut(x, 200)) })),
    // Response items keep their order, so "section:index" keys for recorded actions stay valid.
    response: {
      priorities: r.priorities.slice(0, n),
      preserve: r.preserve.slice(0, n),
      scope: r.scope.slice(0, n),
      containment: r.containment.slice(0, Math.max(n, 6)),
      credentials: r.credentials.slice(0, Math.max(n, 6)),
      investigate: r.investigate.slice(0, n),
      eradication: r.eradication.slice(0, Math.max(n, 6)),
      validation: r.validation.slice(0, n),
      followUp: n >= 4 ? r.followUp : [],
    },
    handoffs: d.handoffs === "none" ? [] : i.handoffs.map((h) => ({ ...h, evidence: h.evidence.slice(0, d.refs), findings: d.handoffs === "full" ? h.findings.slice(0, 5) : [] })),
    questions: i.questions.slice(0, n),
    blocked: i.blocked.slice(0, n),
    links: i.links.slice(0, n),
    gaps: i.gaps.slice(0, Math.min(n, 3)),
    decisions: i.decisions?.slice(-10).map((x) => ({ ...x, note: cut(x.note, 300) })),
    prior: i.prior?.slice(0, 3),
  };
}

/** The smallest useful form: what it is, its state, who's involved and which signals — no plan or timeline. */
function summary(i: Investigation): Investigation {
  return {
    ...i,
    title: cut(i.title, 140),
    assessment: cut(i.assessment, 200),
    confidence: { ...i.confidence, basis: cut(i.confidence.basis, 140) },
    signals: i.signals.slice(0, 4).map((s) => ({ ...s, title: cut(s.title, 100), observed: "", refs: [], users: [], ips: [], hosts: [] })),
    entities: { users: i.entities.users.slice(0, 4), ips: i.entities.ips.slice(0, 4), hosts: i.entities.hosts.slice(0, 4) },
    chain: i.chain.map((c) => ({ ...c, techniques: [], signalIds: [] })),
    timeline: [],
    gaps: [],
    hypotheses: [],
    questions: [],
    blocked: [],
    links: [],
    response: { priorities: i.response.priorities.slice(0, 1), preserve: [], scope: [], containment: [], credentials: [], investigate: [], eradication: [], validation: [], followUp: [] },
    handoffs: [],
    decisions: i.decisions?.slice(-5).map((x) => ({ ...x, note: cut(x.note, 200) })),
    prior: i.prior?.slice(0, 2),
    summaryOnly: true,
  };
}

/**
 * Shrink investigations to fit the run record (the database caps it at 20 KB), highest priority first.
 * Keeping every investigation visible matters more than detail: the top ones keep their full structure at
 * shorter detail, the rest are stored as summaries, and only then are any dropped. Says what was cut; the
 * full evidence is always in the findings.
 */
export function compactInvestigations(list: Investigation[], budget = 13_000): { investigations: Investigation[]; trimmed: string[] } {
  const total = Math.min(list.length, 12);
  // Investigations that already became summaries stay summaries.
  const detailable = list.slice(0, total).filter((i) => !i.summaryOnly).length;
  for (let detailed = detailable; detailed >= 0; detailed--) {
    for (const [level, d] of DETAIL.entries()) {
      let left = detailed;
      const out = list.slice(0, total).map((i) => (!i.summaryOnly && left-- > 0 ? atDetail(i, d) : summary(i)));
      if (jsonBytes(out) > budget) {
        if (detailed === 0) break;
        continue;
      }
      return { investigations: out, trimmed: notes(list.length, total, detailed, detailable, level > 0 && detailed > 0 ? d : null) };
    }
  }
  for (const keep of [8, 5, 3, 1]) {
    const out = list.slice(0, keep).map(summary);
    if (jsonBytes(out) <= budget) return { investigations: out, trimmed: notes(list.length, keep, 0, 0, null) };
  }
  return { investigations: [], trimmed: [`None of the ${list.length} investigations fit in the run record; their signals are in the findings list.`] };
}

function notes(all: number, kept: number, detailed: number, detailable: number, d: Detail | null): string[] {
  const out: string[] = [];
  if (all > kept) out.push(`Investigations: showing ${kept} of ${all} (highest priority first); the rest are in the findings list.`);
  if (detailed < detailable)
    out.push(
      detailed === 0
        ? "Investigations are stored as summaries (no timeline or response plan) to fit the run record; their evidence is in the findings."
        : `${detailable - detailed} lower-priority investigation(s) are stored as summaries (no timeline or response plan) to fit the run record; their evidence is in the findings.`,
    );
  if (d) out.push(`Details shortened to fit the run record: up to ${d.timeline} timeline entries and ${d.signals} signals per investigation. The full evidence is in the findings.`);
  return out;
}

/**
 * Fit a Threat Hunter run's stats under the database limit: drop the legacy timeline when there are
 * investigations, cap intelligence, inventory and QA lists, then give investigations what's left — keeping
 * headroom for the decisions people record later.
 */
export function fitHuntStats(stats: Record<string, unknown> & { investigations?: Investigation[] }, limit = 19_000, headroom = 1_500): Record<string, unknown> {
  const all = stats.investigations ?? [];
  const rest: Record<string, unknown> = { ...stats };
  delete rest.investigations;
  delete rest.investigationsTrimmed;
  if (all.length) delete rest.timeline;
  const caps: [string, number][] = [
    ["intel", 20],
    ["inventory", 10],
    ["qa", 10],
    ["timeline", 30],
    ["sharedAddresses", 10],
  ];
  const capLists = (factor: number) => {
    for (const [k, n] of caps) if (Array.isArray(stats[k]) && k in rest) rest[k] = (stats[k] as unknown[]).slice(0, Math.max(2, Math.floor(n * factor)));
  };
  capLists(1);
  for (const factor of [0.5, 0.25]) if (jsonBytes(rest) > limit * 0.45) capLists(factor);
  const budget = Math.max(2_000, limit - headroom - jsonBytes(rest) - 200);
  const compact = compactInvestigations(all, budget);
  return { ...rest, investigations: compact.investigations, investigationsTrimmed: [...((stats.investigationsTrimmed as string[] | undefined) ?? []), ...compact.trimmed] };
}
