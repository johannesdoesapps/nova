import type { Investigation } from "./investigate";

/**
 * Quality check for investigation reports (written by an AI model): flags attribution the evidence doesn't
 * support, certainty beyond the investigations' states, and claims about data Orbis never saw. Deterministic
 * and conservative — it reports issues for a person to look at; it never rewrites the report.
 */

export interface QaIssue {
  kind: "attribution" | "overconfidence" | "unseen_source" | "monitoring_claim";
  quote: string;
  why: string;
}

const ACTORS =
  /\b(APT ?\d{1,3}|UNC\d{3,5}|FIN\d{1,2}|TA\d{3,4}|Lazarus|Kimsuky|Andariel|Fancy Bear|Cozy Bear|Sandworm|Turla|Equation Group|Volt Typhoon|Salt Typhoon|Charming Kitten|MuddyWater|OilRig|Scattered Spider|LAPSUS\$?|Conti|LockBit|BlackCat|ALPHV|Cl0p|REvil|Ryuk|Akira|Black Basta|Emotet|TrickBot|Qakbot|Cobalt Strike)\b/gi;
const STATE_ACTOR = /\b(nation[- ]state|state[- ]sponsored|state[- ]backed|government[- ]backed)\b/gi;
const CERTAIN =
  /\b(confirmed (?:breach|compromise|attack|malicious)|definitely|certainly|proves?|was compromised|has been compromised|is compromised|attackers? (?:stole|exfiltrated)|data (?:was|has been) (?:stolen|exfiltrated))\b/gi;
const UNSEEN = /\b(EDR|endpoint telemetry|SIEM|firewall logs?|NetFlow|network flow|proxy logs?|email security|mailbox) (shows?|showed|confirms?|confirmed|indicates?|revealed)\b/gi;
// A claim that Orbis is watching, not advice to monitor ("we recommend continuously monitoring" is fine).
const MONITOR = /\b(we are|we're|orbis is|i am|i'm|we will be|orbis will be)( (?:continuously|actively|now))? (monitoring|watching)\b/gi;

export function qaCheck(report: string, investigations: Pick<Investigation, "state" | "signals">[], evidenceText = ""): QaIssue[] {
  const issues: QaIssue[] = [];
  const evidence = evidenceText.toLowerCase();
  for (const m of report.matchAll(ACTORS)) {
    if (!evidence.includes(m[0].toLowerCase()))
      issues.push({
        kind: "attribution",
        quote: snippet(report, m.index!),
        why: `Names "${m[0]}", which doesn't appear in any evidence. Attribution needs intelligence that links this activity to the group.`,
      });
  }
  for (const m of report.matchAll(STATE_ACTOR)) issues.push({ kind: "attribution", quote: snippet(report, m.index!), why: "Claims state involvement; nothing in uploaded logs can establish that." });
  const confirmed = investigations.some((i) => i.state === "confirmed_malicious");
  if (!confirmed)
    for (const m of report.matchAll(CERTAIN))
      issues.push({ kind: "overconfidence", quote: snippet(report, m.index!), why: "No investigation is confirmed malicious; the report should say what's supported and what's still open." });
  for (const m of report.matchAll(UNSEEN)) issues.push({ kind: "unseen_source", quote: snippet(report, m.index!), why: `Refers to ${m[1]} data, which Orbis didn't have for this investigation.` });
  for (const m of report.matchAll(MONITOR))
    issues.push({ kind: "monitoring_claim", quote: snippet(report, m.index!), why: "Orbis analyses what you upload; it doesn't monitor anything continuously." });
  return dedupe(issues).slice(0, 20);
}

function snippet(text: string, at: number) {
  const start = Math.max(0, text.lastIndexOf("\n", at) + 1, at - 80);
  const end = Math.min(text.length, at + 100);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

const dedupe = (xs: QaIssue[]) => [...new Map(xs.map((x) => [`${x.kind}:${x.quote}`, x])).values()];
