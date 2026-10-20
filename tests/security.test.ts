/**
 * Security agents: scanner logic with fake network responses, rule accuracy,
 * dependency parsing, log detections, AI-output validation and SSRF guards.
 */
import { describe, expect, it, vi } from "vitest";
import { runCodeRules } from "@/lib/security/code-rules";
import { correlate } from "@/lib/security/correlate";
import { checkDependencies, parseManifests } from "@/lib/security/deps";
import { huntThreats, parseIndicators, parseLogs } from "@/lib/security/logs";
import { isPublicAddress, normalizeHost } from "@/lib/security/net-pure";
import { parseAiReview, parseFixes } from "@/lib/security/prompts";
import { findingsToMarkdown } from "@/lib/security/report";
import { reputationFindings } from "@/lib/security/reputation";
import { SECURITY_AGENTS } from "@/lib/security/agents";
import { fingerprint, maskSecret } from "@/lib/security/types";

describe("target validation (SSRF guards)", () => {
  it("accepts public domains and normalises them", () => {
    expect(normalizeHost("https://Example.com/path?q=1")).toBe("example.com");
    expect(normalizeHost("shop.example.co.uk")).toBe("shop.example.co.uk");
  });
  it.each(["localhost", "http://127.0.0.1", "10.0.0.1", "[::1]", "printer.local", "http://user:pw@example.com", "example.com:8080", "ftp://example.com", "metadata.internal"])("rejects %s", (h) => {
    expect(() => normalizeHost(h)).toThrow();
  });
  it("classifies private, reserved and metadata addresses as non-public", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"]) expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "76.76.21.21"]) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

type Fake = { status: number; headers?: Record<string, string | string[]>; body?: string };
const fakeRequest = (routes: Record<string, Fake>) =>
  vi.fn(async (url: string) => {
    const r = routes[url];
    if (!r) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return { url, status: r.status, headers: r.headers ?? {}, body: r.body ?? "", truncated: false };
  });

describe("Orbis Sentinel checks", () => {
  it("reports missing headers, weak cookies and reflected CORS from real responses only", async () => {
    const { runSentinel } = await import("@/lib/security/sentinel");
    const req = fakeRequest({
      "https://example.com/": {
        status: 200,
        headers: {
          "content-type": "text/html",
          server: "nginx/1.18.0",
          "set-cookie": ["session_id=abcdef123456; Path=/", "theme=dark; Secure; SameSite=Lax"],
          "access-control-allow-origin": "https://orbis-cors-check.invalid",
          "access-control-allow-credentials": "true",
        },
        body: '<script src="http://cdn.example.net/x.js"></script>',
      },
      "http://example.com/": { status: 200, body: "hi" },
      "https://example.com/.well-known/security.txt": { status: 404 },
    });
    const r = await runSentinel("example.com", "passive", { request: req as never });
    const ids = r.findings.map((f) => f.ruleId).sort();
    expect(ids).toEqual(
      ["content.mixed-scripts", "cookies.flags", "cors.reflected-origin", "disclosure.version-headers", "headers.clickjacking", "headers.csp-missing", "headers.hsts-missing", "headers.nosniff-missing", "headers.referrer-policy-missing", "policy.security-txt-missing", "transport.no-https-redirect"].sort(),
    );
    const cookie = r.findings.find((f) => f.ruleId === "cookies.flags")!;
    expect(cookie.title).toContain("session_id");
    expect(cookie.evidence[0]!.detail).not.toContain("abcdef123456");
    expect(r.findings.find((f) => f.ruleId === "cors.reflected-origin")!.severity).toBe("high");
    // Passive scope never requests sensitive paths.
    expect(req.mock.calls.map((c) => c[0])).not.toContain("https://example.com/.env");
    expect(r.checked).not.toContain("exposure.");
  });

  it("finds nothing to complain about on a well-configured site", async () => {
    const { runSentinel } = await import("@/lib/security/sentinel");
    const req = fakeRequest({
      "https://good.example/": {
        status: 200,
        headers: {
          "content-type": "text/html",
          "strict-transport-security": "max-age=63072000; includeSubDomains",
          "content-security-policy": "default-src 'self'; script-src 'self' 'nonce-abc'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "strict-origin-when-cross-origin",
          "set-cookie": "sid=x; Secure; HttpOnly; SameSite=Lax",
        },
      },
      "http://good.example/": { status: 308, headers: { location: "https://good.example/" } },
      "https://good.example/.well-known/security.txt": { status: 200, body: "Contact: mailto:security@good.example" },
    });
    const r = await runSentinel("good.example", "passive", { request: req as never });
    expect(r.findings).toEqual([]);
  });

  it("confirms exposed files by content in active scope and ignores soft-404 HTML pages", async () => {
    const { runSentinel } = await import("@/lib/security/sentinel");
    const req = fakeRequest({
      "https://leaky.example/": { status: 200, headers: { "content-type": "text/html", "strict-transport-security": "max-age=63072000", "content-security-policy": "default-src 'self'; frame-ancestors 'self'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } },
      "https://leaky.example/.env": { status: 200, headers: { "content-type": "text/plain" }, body: "DATABASE_URL=postgres://u:secretpw@db/x\nSTRIPE_KEY=sk_live_abc" },
      "https://leaky.example/.git/HEAD": { status: 200, headers: { "content-type": "text/html" }, body: "<html>Not found</html>" },
      "https://leaky.example/.git/config": { status: 200, headers: { "content-type": "text/html" }, body: "<html>[core]</html>" },
    });
    const r = await runSentinel("leaky.example", "active", { request: req as never, delayMs: 0 });
    const env = r.findings.find((f) => f.ruleId === "exposure.env-file")!;
    expect(env.severity).toBe("critical");
    expect(env.evidence[0]!.detail).toContain("DATABASE_URL");
    expect(env.evidence[0]!.detail).not.toContain("secretpw");
    expect(r.findings.some((f) => f.ruleId.startsWith("exposure.git"))).toBe(false);
    expect(r.checked).toContain("exposure.");
  });
});

describe("Orbis Code Guardian rules", () => {
  const files = [
    { path: "src/api/user.ts", content: "const q = await db.query(`SELECT * FROM users WHERE id = ${req.query.id}`);\nres.redirect(req.query.next);\n// eval(x) in a comment is ignored\nconst out = eval(input);" },
    { path: "src/config.ts", content: 'export const key = "AKIAIOSFODNN7EXAMPLA";\nconst password = "hunter2hunter2";\nconst apiKey = "your_api_key_here";' },
    { path: "app.py", content: "cursor.execute(f\"SELECT * FROM t WHERE a = {a}\")\nsubprocess.run(cmd, shell=True)\ndata = yaml.load(s)\nrequests.get(u, verify=False)" },
    { path: ".env.example", content: "OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { path: "node_modules/x/index.js", content: "eval(a)" },
  ];
  const { findings, filesScanned } = runCodeRules(files, "demo");
  const ids = findings.map((f) => f.ruleId);

  it("detects injection, secrets and unsafe calls", () => {
    for (const id of ["code.sql-injection", "code.open-redirect", "code.eval", "secret.aws-access-key", "secret.hardcoded-credential", "py.sql-format", "py.shell-true", "py.unsafe-deserialize", "code.tls-disabled"]) expect(ids, id).toContain(id);
  });
  it("skips comments, placeholders, example files and vendored code", () => {
    expect(findings.filter((f) => f.ruleId === "code.eval")).toHaveLength(1);
    expect(findings.filter((f) => f.ruleId === "secret.hardcoded-credential")).toHaveLength(1);
    expect(ids).not.toContain("secret.openai-key");
    expect(filesScanned).toBe(4); // .env.example is read, but secret rules skip example files
  });
  it("masks secrets in evidence and gives locations", () => {
    const aws = findings.find((f) => f.ruleId === "secret.aws-access-key")!;
    expect(aws.evidence[0]!.detail).not.toContain("AKIAIOSFODNN7EXAMPLA");
    expect(aws.location).toBe("src/config.ts:1");
  });
  it("detects a Supabase service-role JWT but not the public anon key", () => {
    const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role, iss: "supabase" })).toString("base64url")}.c2lnbmF0dXJlc2lnbmF0dXJl`;
    const r = runCodeRules([{ path: "a.ts", content: `const a = "${jwt("anon")}";\nconst b = "${jwt("service_role")}";` }], "x");
    expect(r.findings.filter((f) => f.ruleId === "secret.supabase-service-role").map((f) => f.location)).toEqual(["a.ts:2"]);
  });
  it("produces stable fingerprints so re-scans update findings", () => {
    const again = runCodeRules(files, "demo").findings.map((f) => f.fingerprint);
    expect(again).toEqual(findings.map((f) => f.fingerprint));
    expect(fingerprint("a", "b")).not.toBe(fingerprint("a", "c"));
    expect(maskSecret("sk_live_abcdefghij")).not.toContain("abcdefghij");
  });
});

describe("dependency checks (OSV)", () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lodash": { version: "4.17.20" }, "node_modules/vitest": { version: "1.0.0", dev: true }, "node_modules/a/node_modules/minimist": { version: "1.2.5" } } });
  it("parses lockfiles, requirements and falls back to package.json ranges with a note", () => {
    const r = parseManifests([
      { path: "package-lock.json", content: lock },
      { path: "package.json", content: '{"dependencies":{"lodash":"^4.17.20"}}' },
      { path: "svc/requirements.txt", content: "Django==3.2.0\nrequests>=2" },
      { path: "web/package.json", content: '{"dependencies":{"express":"^4.17.1","left-pad":"latest"}}' },
    ]);
    const names = r.packages.map((p) => `${p.ecosystem}:${p.name}@${p.version}${p.approximate ? "~" : ""}${p.dev ? "(dev)" : ""}`).sort();
    expect(names).toEqual(["PyPI:Django@3.2.0", "npm:express@4.17.1~", "npm:lodash@4.17.20", "npm:minimist@1.2.5", "npm:vitest@1.0.0(dev)"]);
    expect(r.notes.join(" ")).toMatch(/web\/package.json has no lockfile/);
  });
  it("turns OSV results into findings with fixed versions and lowers dev-only severity", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/querybatch")) return Response.json({ results: [{ vulns: [{ id: "GHSA-1" }, { id: "CVE-2021-1" }] }, { vulns: [{ id: "GHSA-2" }] }] });
      if (url.endsWith("GHSA-1")) return Response.json({ id: "GHSA-1", summary: "Prototype pollution", aliases: ["CVE-2021-1"], database_specific: { severity: "HIGH" }, affected: [{ package: { name: "lodash" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }] });
      if (url.endsWith("GHSA-2")) return Response.json({ id: "GHSA-2", summary: "Bad thing", database_specific: { severity: "HIGH" } });
      return new Response("", { status: 404 });
    });
    const pkgs = parseManifests([{ path: "package-lock.json", content: lock }]).packages.filter((p) => p.name !== "minimist");
    const r = await checkDependencies(pkgs, "demo", { fetchImpl: fetchImpl as never });
    expect(r.findings).toHaveLength(2); // the CVE alias of GHSA-1 is merged
    const lodash = r.findings.find((f) => f.title.startsWith("lodash"))!;
    expect(lodash).toMatchObject({ severity: "high", confidence: "confirmed" });
    expect(lodash.remediation).toContain("4.17.21");
    expect(r.findings.find((f) => f.title.startsWith("vitest"))!.severity).toBe("medium");
  });
});

describe("Orbis Threat Hunter", () => {
  const ssh = [
    ...Array.from({ length: 12 }, (_, i) => `Oct 18 03:1${i % 10}:0${i % 10} web sshd[99${i}]: Failed password for ${["root", "admin", "deploy", "ubuntu", "git", "oracle"][i % 6]} from 203.0.113.9 port 4${i} ssh2`),
    "Oct 18 03:30:00 web sshd[1200]: Accepted password for deploy from 203.0.113.9 port 5000 ssh2",
    "Oct 18 04:00:00 web sshd[1300]: Failed password for alice from 198.51.100.4 port 1 ssh2",
  ].join("\n");
  const web = [
    `198.51.100.7 - - [18/Oct/2026:10:00:00 +0000] "GET /search?q=1%27%20OR%201=1-- HTTP/1.1" 200 512 "-" "sqlmap/1.7"`,
    `198.51.100.7 - - [18/Oct/2026:10:00:01 +0000] "GET /.env HTTP/1.1" 404 0 "-" "sqlmap/1.7"`,
    `198.51.100.7 - - [18/Oct/2026:10:00:02 +0000] "GET /wp-login.php HTTP/1.1" 404 0 "-" "sqlmap/1.7"`,
    `198.51.100.7 - - [18/Oct/2026:10:00:03 +0000] "GET /.git/HEAD HTTP/1.1" 200 23 "-" "sqlmap/1.7"`,
    `192.0.2.1 - - [18/Oct/2026:10:05:00 +0000] "GET / HTTP/1.1" 200 1000 "-" "Mozilla/5.0"`,
    `not a log line`,
  ].join("\n");
  const parsed = parseLogs([{ name: "auth.log", content: ssh }, { name: "access.log", content: web }], 2026);
  const hunt = huntThreats(parsed.events, "server");

  it("parses SSH and web logs and counts what it couldn't read", () => {
    expect(parsed.formats).toMatchObject({ ssh: 14, web: 5 });
    expect(parsed.unparsed).toBe(1);
  });
  it("flags success after repeated failures as firm, not confirmed compromise", () => {
    const f = hunt.findings.find((x) => x.ruleId === "auth.success-after-failures")!;
    expect(f).toMatchObject({ severity: "high", confidence: "firm", location: "203.0.113.9" });
    expect(f.description).toMatch(/Observed:.*Hypothesis:/s);
    expect(hunt.findings.some((x) => x.ruleId === "auth.password-spray" && x.location === "203.0.113.9")).toBe(true);
    expect(hunt.findings.some((x) => x.location === "198.51.100.4")).toBe(false); // one failure is not an incident
  });
  it("detects payloads and scanning, and notes successful responses without claiming success", () => {
    const sqli = hunt.findings.find((x) => x.ruleId === "web.payload-sqli")!;
    expect(sqli).toMatchObject({ severity: "high", confidence: "tentative" });
    expect(sqli.description).toMatch(/does not prove success/);
    const scan = hunt.findings.find((x) => x.ruleId === "web.scanning")!;
    expect(scan.description).toContain("/.git/HEAD");
    expect(hunt.timeline.length).toBeGreaterThan(2);
    expect(hunt.indicators).toEqual(expect.arrayContaining(["203.0.113.9", "198.51.100.7"]));
  });
  it("validates pasted indicators, including defanged ones", () => {
    expect(parseIndicators("8.8.8.8, evil[.]example hxxps://bad.example/x 999.1.1.1 nonsense")).toEqual({ ips: ["8.8.8.8"], domains: ["evil.example"], urls: ["https://bad.example/x"], invalid: ["999.1.1.1", "nonsense"] });
  });
  it("only reports reputation hits with real reports", () => {
    const fs = reputationFindings([{ ip: "1.2.3.4", score: 90, reports: 40, country: "XX", isp: null, lastReportedAt: null }, { ip: "5.6.7.8", score: 0, reports: 0, country: null, isp: null, lastReportedAt: null }], "x");
    expect(fs.map((f) => f.location)).toEqual(["1.2.3.4"]);
  });
});

describe("AI output validation", () => {
  const files = [{ path: "src/a.ts", content: "export function get(req) {\n  return db.raw('select * from t where id=' + req.params.id);\n}" }];
  it("keeps AI findings only when the quoted code exists, and caps critical at high", () => {
    const text = JSON.stringify({
      findings: [
        { title: "SQL injection", severity: "critical", file: "src/a.ts", quote: "return db.raw('select * from t where id=' + req.params.id);", description: "d", remediation: "r" },
        { title: "Invented", severity: "high", file: "src/a.ts", quote: "exec(userInput) // not in the file", description: "d", remediation: "r" },
        { title: "Wrong file", severity: "high", file: "src/b.ts", quote: "anything goes here", description: "d", remediation: "r" },
      ],
    });
    const r = parseAiReview(`Here you go: ${text}`, files, "demo");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ severity: "high", confidence: "tentative", location: "src/a.ts:2", evidenceSource: "ai-review" });
    expect(r.rejected).toBe(2);
    expect(parseAiReview("no json", files, "x").error).toBeTruthy();
  });
  it("accepts only diff-shaped patches", () => {
    expect(parseFixes('{"fixes":[{"n":1,"patch":"--- a/x\\n+++ b/x\\n@@ -1 +1 @@","test":"t"},{"n":2,"patch":"rm -rf /","test":""}]}').map((f) => f.n)).toEqual([1]);
  });
});

describe("coordination and reports", () => {
  it("links a code weakness to matching attack attempts and an exposed file to scanner hits", () => {
    const r = correlate([
      { id: "c1", agent: "code_guardian", rule_id: "code.sql-injection", title: "SQLi", location: "a.ts:1", evidence: [] },
      { id: "h1", agent: "threat_hunter", rule_id: "web.payload-sqli", title: "SQLi attempts", location: "1.2.3.4", evidence: [] },
      { id: "s1", agent: "sentinel", rule_id: "exposure.git-head", title: "git", location: "https://x.example/.git/HEAD", evidence: [] },
      { id: "h2", agent: "threat_hunter", rule_id: "web.scanning", title: "scan", location: "1.2.3.4", evidence: [{ source: "l:1", detail: '"GET /.git/HEAD HTTP/1.1" 200' }] },
      { id: "h3", agent: "threat_hunter", rule_id: "web.payload-xss", title: "xss", location: "1.2.3.4", evidence: [] },
    ]);
    expect(r.pairs).toEqual([["c1", "h1"], ["s1", "h2"]]);
  });
  it("exports Markdown with severity tallies but no invented score", () => {
    const md = findingsToMarkdown(
      [{ id: "1", agent: "sentinel", title: "T", description: "D", severity: "high", confidence: "confirmed", rationale: "R", asset: "x", location: null, evidence: [{ source: "s", detail: "d" }], evidence_source: "orbis:headers", remediation: "Fix", refs: [], status: "open", verification: "not_verified", verification_note: null, related: [], duplicate_of: null, user_note: null, patch: null, first_seen: "2026-10-19", last_seen: "2026-10-19" }],
      new Date("2026-10-19T00:00:00Z"),
    );
    expect(md).toContain("| high | 1 |");
    expect(md).not.toMatch(/score:/i);
  });
  it("defines three active agents and two planned ones that can't be launched", () => {
    expect(SECURITY_AGENTS.filter((a) => a.status === "active").map((a) => a.id)).toEqual(["sentinel", "threat_hunter", "code_guardian"]);
    expect(SECURITY_AGENTS.filter((a) => a.status === "planned").every((a) => a.action === null && a.tools.length === 0)).toBe(true);
  });
});

describe("GitHub snapshot reader", () => {
  it("unpacks only supported text files and skips vendored and binary files", async () => {
    const { untar } = await import("@/lib/security/github");
    const entry = (name: string, content: string | Buffer) => {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const h = Buffer.alloc(512);
      h.write(name, 0);
      h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
      h.write("0", 156);
      return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
    };
    const tar = Buffer.concat([
      entry("repo-abc/src/a.ts", "const x = eval(y);"),
      entry("repo-abc/node_modules/x/i.js", "eval(z)"),
      entry("repo-abc/logo.png", Buffer.from([0, 1, 2])),
      entry("repo-abc/package-lock.json", "{}"),
      Buffer.alloc(1024),
    ]);
    const r = untar(tar);
    expect(r.files.map((f) => f.path)).toEqual(["src/a.ts", "package-lock.json"]);
  });
});

describe("request validation", () => {
  it("requires explicit authorisation for scans and limits upload sizes", async () => {
    const { guardianRequest, hunterRequest, sentinelRequest } = await import("@/lib/security/schema");
    const id = "00000000-0000-4000-8000-000000000000";
    expect(sentinelRequest.safeParse({ targetId: id }).success).toBe(false);
    expect(sentinelRequest.safeParse({ targetId: id, authorized: false }).success).toBe(false);
    expect(sentinelRequest.safeParse({ targetId: id, authorized: true }).data?.scope).toBe("passive");
    expect(guardianRequest.safeParse({ source: { type: "upload", files: [{ path: "../../etc/passwd", content: "x" }] } }).success).toBe(false);
    expect(guardianRequest.safeParse({ source: { type: "upload", files: [{ path: "a.ts", content: "x".repeat(900_000) }, { path: "b.ts", content: "x".repeat(900_000) }, { path: "c.ts", content: "x".repeat(900_000) }, { path: "d.ts", content: "x".repeat(900_000) }] } }).success).toBe(false);
    expect(hunterRequest.safeParse({}).success).toBe(false);
    expect(hunterRequest.safeParse({ indicators: "8.8.8.8" }).success).toBe(true);
  });
});
