/**
 * Sentinel's deep-audit building blocks: site mapping (surface.ts), code mapping (code-map.ts), finding
 * classification, details and investigation records (details.ts), attack paths (attack-paths.ts), and the
 * audit modes, gate, coverage and posture (audit.ts). All pure: no network, no database.
 */
import { describe, expect, it, vi } from "vitest";
import { buildSurface, canonical, compactSurface, endpointsIn, parsePage, sourceMapRef } from "@/lib/security/surface";
import { codeMapFindings, compactMap, mapCode } from "@/lib/security/code-map";
import { classify, findingDetails, investigation, type FindingLike } from "@/lib/security/details";
import { attackPaths, routeMatches } from "@/lib/security/attack-paths";
import { correlate } from "@/lib/security/correlate";
import { coverage, crawlBudget, DEFAULT_GATE, evaluateGate, posture } from "@/lib/security/audit";

const HTML = `<!doctype html><html><head><title>Acme</title>
<script src="/_next/static/chunks/main-abc.js"></script>
<script src="https://cdn.example.net/widget.js"></script>
<script src="https://cdn.example.net/pinned.js" integrity="sha384-abc" crossorigin="anonymous"></script>
<link rel="canonical" href="https://acme.test/">
</head><body>
<a href="/pricing">Pricing</a> <a href="/login?next=/dashboard">Sign in</a> <a href="https://twitter.com/acme">X</a>
<a href="mailto:hi@acme.test">Mail</a> <a href="#top">Top</a>
<form action="/api/login" method="post"><input name="email" type="email"><input name="password" type="password"><input type="hidden" name="csrf_token" value="x"><button>Go</button></form>
<form action="http://acme.test/subscribe" method="POST"><input name="email"></form>
<form action="/upload" method="post" enctype="multipart/form-data"><input type="file" name="doc"></form>
<script>fetch("/api/projects/" + id); const u = \`/api/users/\${uid}/settings\`;</script>
</body></html>`;

describe("site mapping", () => {
  const page = parsePage("https://acme.test/", 200, HTML, "acme.test");

  it("finds links, forms with their fields, scripts, endpoints, redirect parameters and technology", () => {
    expect(page.title).toBe("Acme");
    expect(page.links).toEqual(expect.arrayContaining(["https://acme.test/pricing", "https://acme.test/login?next=/dashboard", "https://twitter.com/acme"]));
    expect(page.links.some((l) => l.startsWith("mailto:"))).toBe(false);
    const login = page.forms.find((f) => f.action.endsWith("/api/login"))!;
    expect(login).toMatchObject({ method: "POST", hasPassword: true, hasCsrfField: true, hasFile: false });
    expect(page.forms.find((f) => f.action.startsWith("http://"))!.hasCsrfField).toBe(false);
    expect(page.forms.find((f) => f.action.endsWith("/upload"))!.hasFile).toBe(true);
    expect(page.scripts).toEqual(
      expect.arrayContaining([
        { src: "https://acme.test/_next/static/chunks/main-abc.js", firstParty: true, integrity: false },
        { src: "https://cdn.example.net/widget.js", firstParty: false, integrity: false },
        { src: "https://cdn.example.net/pinned.js", firstParty: false, integrity: true },
      ]),
    );
    expect(page.endpoints).toEqual(expect.arrayContaining(["/api/login", "/api/projects", "/api/users/:param/settings"]));
    expect(page.redirectParams).toEqual(["next"]);
    expect(page.tech).toContain("Next.js");
  });

  it("builds an inventory with external hosts and pages not fetched, and keeps a compact copy within budget", () => {
    const s = buildSurface("acme.test", [page], {
      queued: ["https://acme.test/pricing"],
      sourceMaps: ["https://acme.test/main.js.map"],
      scriptEndpoints: [{ path: "/api/billing", seenIn: "https://acme.test/main.js" }],
    });
    expect(s.externalHosts).toEqual(["cdn.example.net", "twitter.com"]);
    expect(s.endpoints.map((e) => e.path)).toContain("/api/billing");
    expect(s.notFetched).toEqual(["https://acme.test/pricing"]);
    const big = { ...s, endpoints: Array.from({ length: 900 }, (_, i) => ({ path: `/api/thing-${i}/with/a/long/path`, seenIn: "https://acme.test/" })) };
    const c = compactSurface(big);
    expect(JSON.stringify(c).length).toBeLessThanOrEqual(11_000);
    expect(c.trimmed.join(" ")).toMatch(/Endpoints: showing \d+ of 900/);
  });

  it("normalises endpoints and URLs, and finds source maps", () => {
    expect(endpointsIn(`a("/api/items/{id}") b('/graphql') c("/static/x.js")`)).toEqual(["/api/items/:param", "/graphql"]);
    expect(canonical(new URL("https://acme.test/a?utm_source=x&b=2&a=1#frag"))).toBe("https://acme.test/a?a=1&b=2");
    expect(sourceMapRef("console.log(1)\n//# sourceMappingURL=main.js.map", "https://acme.test/static/main.js")).toBe("https://acme.test/static/main.js.map");
    expect(sourceMapRef("x\n//# sourceMappingURL=data:application/json;base64,e30=", "https://acme.test/a.js")).toBeNull();
  });
});

const file = (path: string, content: string) => ({ path, content });

describe("code mapping", () => {
  const files = [
    file("package.json", JSON.stringify({ dependencies: { next: "16.0.0", "@supabase/supabase-js": "2.0.0", stripe: "17.0.0", zod: "4.0.0" }, engines: { node: ">=20" } })),
    file("src/app/api/notes/route.ts", `export async function POST(req: Request) {\n  const db = createClient();\n  await db.from("notes").insert(await req.json());\n}`),
    file(
      "src/app/api/safe/route.ts",
      `export async function POST(req: Request) {\n  const auth = await requireUser();\n  const body = schema.parse(await req.json());\n  await auth.db.from("notes").insert({ text: body.text, user_id: auth.user.id });\n}`,
    ),
    file("src/app/api/notes/[id]/route.ts", `export async function GET(_r: Request, ctx) {\n  const auth = await requireUser();\n  return db.from("notes").select("*").eq("id", ctx.params.id);\n}`),
    file(
      "src/app/api/own/[id]/route.ts",
      `export async function GET(_r: Request, ctx) {\n  const auth = await requireUser();\n  return db.from("notes").select("*").eq("id", ctx.params.id).eq("user_id", auth.user.id);\n}`,
    ),
    file("src/app/api/stripe/webhook/route.ts", `export async function POST(req: Request) {\n  const event = await req.json();\n  await admin.from("subscriptions").update({ status: "active" });\n}`),
    file("src/app/api/github/webhook/route.ts", `export async function POST(req: Request) {\n  if (!timingSafeEqual(a, b)) return new Response(null, { status: 401 });\n}`),
    file("src/app/api/preview/route.ts", `export async function POST(req: Request) {\n  const body = await req.json();\n  const res = await fetch(body.url);\n}`),
    file("src/app/(auth)/api/login/route.ts", `export async function POST(req: Request) {\n  await signIn(await req.json());\n}`),
    file("server/routes.js", `const router = express.Router();\nrouter.use(requireAuth);\nrouter.post("/items", async (req, res) => { await db.insert(req.body); });`),
    file("app.py", `@app.route("/admin/users", methods=["POST", "DELETE"])\ndef users():\n    db.session.delete(user)\n`),
    file(
      "supabase/migrations/001.sql",
      `create table public.notes (id uuid);\nalter table public.notes enable row level security;\ncreate table public.secrets (id uuid);\ncreate policy "edit all" on public.notes for update to authenticated using (true);`,
    ),
    file(".github/workflows/ci.yml", `on: pull_request_target\njobs:\n  t:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}`),
    file("Dockerfile", `FROM node\nCOPY . .\nCMD ["node", "server.js"]`),
    file(".env", `DATABASE_URL=postgres://x\nAPI_KEY=abc`),
    file("lib/main.go", "package main"),
  ];
  const map = mapCode(files);
  const findings = codeMapFindings(map, files, "acme");
  const rules = (id: string) => findings.filter((f) => f.ruleId === id);

  it("inventories frameworks, runtimes, routes, boundaries and what it couldn't map", () => {
    expect(map.frameworks).toEqual(expect.arrayContaining(["next 16.0.0", "Next.js routes", "Express-style routes", "Flask"]));
    expect(map.runtimes).toEqual(expect.arrayContaining(["Node.js >=20", "Container node"]));
    expect(map.securityLibraries).toEqual(expect.arrayContaining(["zod 4.0.0", "stripe 17.0.0"]));
    const paths = map.routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(expect.arrayContaining(["POST /api/notes", "GET /api/notes/:id", "POST /api/login", "POST /items", "POST /admin/users", "DELETE /admin/users"]));
    expect(map.boundaries.map((b) => b.to)).toEqual(expect.arrayContaining(["Stripe", "Supabase (database, auth)", "External URLs", "Your webhook routes"]));
    expect(map.sensitiveRoutes).toEqual(expect.arrayContaining(["POST /admin/users"]));
    expect(map.unmapped.join(" ")).toMatch(/\.go files/);
    expect(compactMap(map).routeCount).toBe(map.routes.length);
  });

  it("flags state-changing routes without a visible sign-in check, but not protected or public ones", () => {
    const noAuth = rules("map.route-no-auth").map((f) => f.title);
    expect(noAuth.some((t) => t.startsWith("POST /api/notes "))).toBe(true);
    expect(noAuth.some((t) => t.includes("/api/safe"))).toBe(false);
    expect(noAuth.some((t) => t.includes("/api/login"))).toBe(false);
    expect(noAuth.some((t) => t.includes("/items"))).toBe(false);
    expect(rules("map.route-no-auth").every((f) => f.confidence === "tentative")).toBe(true);
  });

  it("flags id routes without an owner filter, unsigned webhooks, mass assignment and request-controlled fetches", () => {
    expect(rules("map.object-access").map((f) => f.title)).toEqual(["GET /api/notes/:id loads a record by id without a visible owner check"]);
    expect(rules("map.webhook-no-signature").map((f) => f.location)).toEqual(["src/app/api/stripe/webhook/route.ts:1"]);
    expect(rules("map.mass-assignment").map((f) => f.location)).toEqual(expect.arrayContaining(["src/app/api/notes/route.ts:3"]));
    expect(rules("map.server-fetch-input")[0]!.location).toBe("src/app/api/preview/route.ts:3");
    expect(rules("map.auth-no-rate-limit").length).toBe(1);
  });

  it("checks database rules, CI, containers and committed env files", () => {
    expect(rules("config.rls-disabled").map((f) => f.title)).toEqual(['Table "secrets" is created without row level security']);
    expect(rules("config.policy-allows-all")[0]!.title).toMatch(/edit all/);
    expect(rules("config.ci-untrusted-checkout")).toHaveLength(1);
    expect(rules("config.container-root")).toHaveLength(1);
    expect(rules("config.container-unpinned")).toHaveLength(1);
    expect(rules("config.env-committed")[0]!.evidence[0]!.detail).toBe("2 variables (values not shown)");
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(findings.length);
  });
});

describe("code mapping traces helpers and avoids common false positives", () => {
  const helpers = [
    file(
      "src/lib/server.ts",
      `export async function codeContext(bucket = "x") {\n  const auth = await requireUser();\n  return auth;\n}\nexport async function getNote(auth, id) {\n  return auth.db.from("notes").select("*").eq("id", id).eq("user_id", auth.user.id);\n}`,
    ),
  ];
  it("credits a sign-in or owner check made inside a helper the handler calls, and names it", () => {
    const files = [
      ...helpers,
      file(
        "src/app/api/notes/[id]/route.ts",
        `export async function DELETE(_r: Request, ctx) {\n  const auth = await codeContext();\n  const note = await getNote(auth, ctx.params.id);\n  await auth.db.from("notes").delete().eq("id", note.id);\n}`,
      ),
    ];
    const map = mapCode(files);
    expect(map.routes[0]!.via).toEqual({ auth: "codeContext() in src/lib/server.ts", owner: "getNote() in src/lib/server.ts" });
    expect(codeMapFindings(map, files, "a")).toEqual([]);
    expect(compactMap(map).routes[0]!.signals).toMatch(/sign-in check \(via codeContext\(\) in src\/lib\/server\.ts\)/);
  });

  it("treats row level security on every table as the owner check, unless the route uses a privileged client", () => {
    const sql = file("supabase/migrations/1.sql", "create table public.notes (id uuid);\nalter table public.notes enable row level security;");
    const route = (extra = "") =>
      file(
        "src/app/api/notes/[id]/route.ts",
        `export async function GET(_r: Request, ctx) {\n  const auth = await requireUser();\n  ${extra}return auth.db.from("notes").select("*").eq("id", ctx.params.id);\n}`,
      );
    expect(codeMapFindings(mapCode([sql, route()]), [sql, route()], "a").map((f) => f.ruleId)).toEqual([]);
    const admin = [sql, route("const db = createAdminClient(); ")];
    expect(codeMapFindings(mapCode(admin), admin, "a").map((f) => f.ruleId)).toEqual(["map.object-access"]);
  });

  it("doesn't call a route a webhook because a comment mentions one, or flag fetches of configured URLs", () => {
    const files = [
      file(
        "src/app/api/billing/sync/route.ts",
        `/** Apply the session now instead of waiting for the webhook. */\nexport async function POST(req: Request) {\n  const { user } = await requireUser();\n  await db.from("subs").update({ user_id: user.id });\n}`,
      ),
      file("src/app/api/admin/test/route.ts", `export async function POST(req: Request) {\n  await requireAdmin();\n  const target = { url: env.baseUrl };\n  const res = await fetch(target.url);\n}`),
      file("src/app/api/code/agent/[runId]/verify/route.ts", `export async function POST(req: Request) {\n  await requireUser();\n}`),
    ];
    expect(codeMapFindings(mapCode(files), files, "a")).toEqual([]);
  });
});

const F = (over: Partial<FindingLike> & { id: string; rule_id: string }): FindingLike & { id: string } => ({
  agent: "sentinel",
  title: over.rule_id,
  description: "d",
  severity: "medium",
  confidence: "confirmed",
  asset: "acme.test",
  location: null,
  evidence: [{ source: "s", detail: "x" }],
  evidence_source: "orbis:headers",
  remediation: "fix it",
  status: "open",
  verification: "not_verified",
  related: [],
  ...over,
});

describe("classification, details and investigation records", () => {
  it("separates confirmed, likely, needs-verification, informational and false positives", () => {
    expect(classify(F({ id: "1", rule_id: "headers.hsts-missing" }))).toBe("confirmed");
    expect(classify(F({ id: "2", rule_id: "x", confidence: "firm" }))).toBe("likely");
    expect(classify(F({ id: "3", rule_id: "x", confidence: "tentative" }))).toBe("needs_verification");
    expect(classify(F({ id: "4", rule_id: "x", severity: "info" }))).toBe("informational");
    expect(classify(F({ id: "5", rule_id: "x", status: "false_positive" }))).toBe("false_positive");
  });

  it("raises a tentative lead to likely only with independent evidence from another source", () => {
    const code = F({ id: "c", rule_id: "map.route-no-auth", agent: "code_guardian", evidence_source: "orbis:code-map", confidence: "tentative", related: ["l"] });
    const liveF = F({ id: "l", rule_id: "surface.api-personal-data", evidence_source: "orbis:surface", confidence: "tentative", related: ["c"] });
    expect(classify(code, [liveF])).toBe("likely");
    expect(classify({ ...code, related: [] }, [liveF])).toBe("needs_verification");
    const steps = investigation(code, [liveF]);
    expect(steps.map((s) => s.id)).toEqual(["detect", "hypothesize", "trace", "test", "corroborate", "impact", "root_cause", "remediate", "retest"]);
    expect(steps.find((s) => s.id === "test")!.state).toBe("not_done");
    expect(steps.find((s) => s.id === "corroborate")!.state).toBe("done");
    expect(steps.find((s) => s.id === "retest")!.detail).toBe("Not re-checked yet.");
  });

  it("live findings count as tested; re-checks are reported as they happened", () => {
    const f = F({ id: "1", rule_id: "headers.hsts-missing", location: "https://acme.test/", verification: "not_detected", verification_note: "Not detected by the re-scan on 2026-10-24." });
    const steps = investigation(f);
    expect(steps.find((s) => s.id === "test")!.state).toBe("done");
    expect(steps.find((s) => s.id === "retest")).toMatchObject({ state: "done", detail: "Not detected by the re-scan on 2026-10-24." });
  });

  it("gives reproduction, expected vs observed, impact, privileges, root cause and verification", () => {
    const d = findingDetails(F({ id: "1", rule_id: "map.object-access", location: "src/a.ts:3", evidence: [{ source: "src/a.ts:3", detail: "GET /api/x/:id" }] }));
    expect(d.reproduce.join(" ")).toMatch(/synthetic user/);
    expect(d.expected).toMatch(/404/);
    expect(d.observed).toBe("src/a.ts:3: GET /api/x/:id");
    expect(d.privileges).toBe("A regular account.");
    expect(d.verify.join(" ")).toMatch(/two-user test/);
    expect(d.cvss).toMatch(/^CVSS:3\.1\//);
    expect(findingDetails(F({ id: "2", rule_id: "headers.csp-missing" })).cvss).toBeNull();
    expect(findingDetails(F({ id: "3", rule_id: "unknown.rule" })).rootCause).toBe("Not determined.");
  });
});

describe("attack paths", () => {
  it("links an XSS sink, a weak CSP and a script-readable session cookie, and labels it theoretical", () => {
    const fs = [
      F({ id: "a", rule_id: "code.inner-html", agent: "code_guardian", confidence: "tentative", evidence_source: "orbis:code-rules" }),
      F({ id: "b", rule_id: "headers.csp-missing" }),
      F({ id: "c", rule_id: "cookies.flags", title: 'Cookie "sid" is missing HttpOnly' }),
    ];
    const p = attackPaths(fs).find((x) => x.id === "xss-session")!;
    expect(p.status).toBe("theoretical");
    expect(p.severity).toBe("high");
    expect(p.findingIds.sort()).toEqual(["a", "b", "c"]);
    expect(p.steps.at(-1)!.kind).toBe("impact");
  });

  it("marks a chain whose every step is confirmed as steps_confirmed (never as a demonstrated compromise)", () => {
    const fs = [
      F({ id: "g", rule_id: "exposure.git-head", severity: "high" }),
      F({ id: "s", rule_id: "secret.aws-access-key", agent: "code_guardian", severity: "critical", confidence: "confirmed", evidence_source: "orbis:code-rules" }),
    ];
    const p = attackPaths(fs).find((x) => x.id === "git-secrets")!;
    expect(p.status).toBe("steps_confirmed");
  });

  it("needs both the code lead and the live signed-out response to link an open API route", () => {
    const code = F({
      id: "c",
      rule_id: "map.route-no-auth",
      agent: "code_guardian",
      confidence: "tentative",
      evidence: [{ source: "src/app/api/items/[id]/route.ts:1", detail: "GET /api/items/:id (Next.js). Signals: database read." }],
    });
    const liveF = F({ id: "l", rule_id: "surface.api-personal-data", location: "https://acme.test/api/items/42", confidence: "tentative" });
    expect(attackPaths([code, liveF]).some((p) => p.id === "api-open-c")).toBe(true);
    expect(attackPaths([code]).some((p) => p.id.startsWith("api-open"))).toBe(false);
    expect(attackPaths([code, { ...liveF, location: "https://acme.test/api/other/1" }]).some((p) => p.id.startsWith("api-open"))).toBe(false);
  });

  it("never treats a signed-out GET as evidence about a POST handler", () => {
    const post = F({
      id: "p",
      rule_id: "map.route-no-auth",
      agent: "code_guardian",
      confidence: "tentative",
      evidence: [{ source: "src/app/api/orders/route.ts:4", detail: "POST /api/orders (Next.js). Signals: database write." }],
    });
    const liveF = F({ id: "l", rule_id: "surface.api-personal-data", location: "https://acme.test/api/orders", confidence: "tentative" });
    expect(attackPaths([post, liveF]).some((p) => p.id.startsWith("api-open"))).toBe(false);
    expect(correlate([post, liveF] as never).pairs).toEqual([]);
    const get = { ...post, id: "g", rule_id: "map.read-no-auth", evidence: [{ source: "src/app/api/orders/route.ts:1", detail: "GET /api/orders (Next.js). Signals: database read." }] };
    expect(correlate([get, liveF] as never).pairs).toEqual([["g", "l"]]);
  });

  it("ignores fixed and false-positive findings", () => {
    expect(attackPaths([F({ id: "x", rule_id: "config.rls-disabled", status: "fixed" })])).toEqual([]);
    expect(attackPaths([F({ id: "x", rule_id: "config.rls-disabled", status: "false_positive" })])).toEqual([]);
    expect(attackPaths([F({ id: "x", rule_id: "config.rls-disabled", agent: "code_guardian", confidence: "firm" })])[0]!.title).toMatch(/row level|unprotected tables/);
  });

  it("matches route patterns against concrete paths", () => {
    expect(routeMatches("/api/items/:id", "/api/items/42")).toBe(true);
    expect(routeMatches("/api/items/:id", "/api/items/42/edit")).toBe(false);
    expect(routeMatches("/api/files/:path*", "/api/files/a/b")).toBe(true);
  });
});

describe("audit modes, gate, coverage and posture", () => {
  it("budgets fetching per mode, and only checks endpoints with active testing", () => {
    expect(crawlBudget("quick", "standard", true)).toMatchObject({ pages: 1, endpointChecks: 0 });
    expect(crawlBudget("deep", "standard", false)).toMatchObject({ pages: 25, scripts: 12, endpointChecks: 0 });
    expect(crawlBudget("deep", "extended", true)).toMatchObject({ pages: 40, endpointChecks: 24 });
  });

  it("passes, fails or is incomplete — and recorded decisions don't block", () => {
    const steps = [{ label: "Sentinel", status: "completed" }];
    const high = F({ id: "h", rule_id: "exposure.git-head", severity: "high" });
    expect(evaluateGate([high], DEFAULT_GATE, steps).outcome).toBe("failed");
    expect(evaluateGate([{ ...high, status: "accepted_risk" }], DEFAULT_GATE, steps).outcome).toBe("passed");
    const lead = F({ id: "t", rule_id: "map.route-no-auth", severity: "high", confidence: "tentative" });
    expect(evaluateGate([lead], DEFAULT_GATE, steps).outcome).toBe("passed");
    expect(evaluateGate([lead], { ...DEFAULT_GATE, blockUnverified: true }, steps).outcome).toBe("failed");
    const r = evaluateGate([], DEFAULT_GATE, [...steps, { label: "Code Guardian", status: "failed" }]);
    expect(r.outcome).toBe("incomplete");
    expect(r.reasons).toEqual(["Code Guardian failed."]);
  });

  it("says what was and wasn't assessed", () => {
    const c = coverage({
      website: true,
      active: false,
      pagesFetched: 5,
      pagesNotFetched: 3,
      endpointsChecked: 0,
      code: false,
      routesMapped: 0,
      unmapped: [],
      deps: "not_run",
      aiReview: false,
      logs: false,
    });
    const authz = c.find((a) => a.id === "authz")!;
    expect(authz.state).toBe("not_assessed");
    expect(authz.notChecked).toContain("No code was in scope");
    const fe = c.find((a) => a.id === "frontend")!;
    expect(fe.state).toBe("partial");
    expect(fe.notChecked).toContain("3 same-site page(s) found but not fetched within the budget");
    expect(c.find((a) => a.id === "authn")!.notChecked.join(" ")).toMatch(/test accounts/);
    expect(c.some((a) => a.id === "monitoring")).toBe(false);
  });

  it("counts open findings by severity and classification, with no score", () => {
    const p = posture([F({ id: "1", rule_id: "a", severity: "high" }), F({ id: "2", rule_id: "b", confidence: "tentative" }), F({ id: "3", rule_id: "c", status: "fixed" })]);
    expect(p.open).toMatchObject({ high: 1, medium: 1 });
    expect(p.confirmedOrLikely).toBe(2);
    expect(p.unverified).toBe(1);
    expect(Object.keys(p)).not.toContain("score");
  });
});

describe("read-only site mapping (crawler)", () => {
  type Fake = { status: number; headers?: Record<string, string | string[]>; body?: string };
  const html = (body: string, extra: Record<string, string | string[]> = {}) => ({ status: 200, headers: { "content-type": "text/html", ...extra }, body });
  // A Supabase service-role JWT assembled at runtime (not a real key).
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const serviceRole = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role", iss: "supabase" })}.${"s".repeat(43)}`;
  const site = (): Record<string, Fake> => ({
    "https://shop.test/": html(
      `<a href="/about">About</a><a href="/account/delete">Delete account</a><a href="/logout">Log out</a><a href="/private/x">Hidden</a><a href="https://other.test/">Other</a>
       <a href="/login?next=/cart">Sign in</a>
       <script src="/static/app.js"></script><script src="https://cdn.other.test/lib.js"></script>`,
      {
        "strict-transport-security": "max-age=63072000",
        "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    ),
    "http://shop.test/": { status: 301, headers: { location: "https://shop.test/" } },
    "https://shop.test/.well-known/security.txt": { status: 200, body: "Contact: mailto:sec@shop.test" },
    "https://shop.test/robots.txt": { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /private/\nSitemap: https://shop.test/sitemap.xml" },
    "https://shop.test/sitemap.xml": { status: 200, body: "<urlset><url><loc>https://shop.test/pricing</loc></url></urlset>" },
    "https://shop.test/about": html(`<form method="post" action="/api/contact"><input name="name"><input name="email"></form>`, { "set-cookie": "sid=abcdef123456; Path=/" }),
    "https://shop.test/pricing": html(`<p>Plans</p>`),
    "https://shop.test/login?next=%2Fcart": html(`<form method="post" action="/api/login"><input name="email"><input type="password" name="pw"></form>`),
    "https://shop.test/static/app.js": {
      status: 200,
      headers: { "content-type": "application/javascript" },
      body: `fetch("/api/me");fetch("/api/status");fetch("/api/orders/"+id);const k="${serviceRole}";\n//# sourceMappingURL=app.js.map`,
    },
    "https://shop.test/static/app.js.map": { status: 200, body: '{"version":3,"sources":["src/app.ts"],"mappings":"AAAA"}' },
    "https://shop.test/api/me": { status: 200, headers: { "content-type": "application/json" }, body: '{"id":1,"email":"x@y.z"}' },
    "https://shop.test/api/status": { status: 401, headers: { "content-type": "application/json" }, body: "{}" },
  });
  const fake = (routes: Record<string, Fake>) =>
    vi.fn(async (url: string, ...rest: [{ headers?: Record<string, string>; method?: string }?]) => {
      void rest;
      const r = routes[url] ?? (/orbis-sentinel-/.test(url) ? { status: 404, body: "Error: not found\n    at handler (/var/task/server.js:10:5)" } : undefined);
      if (!r) return { url, status: 404, headers: { "content-type": "text/html" }, body: "Not found", truncated: false };
      return { url, status: r.status, headers: r.headers ?? {}, body: r.body ?? "", truncated: false };
    });

  it("maps the site within scope, skipping other hosts, action-like links and robots.txt exclusions", async () => {
    const { runSentinel } = await import("@/lib/security/sentinel");
    const req = fake(site());
    const r = await runSentinel("shop.test", "passive", { request: req as never, delayMs: 0, budget: crawlBudget("deep", "standard", false) });
    const urls = req.mock.calls.map((c) => c[0] as string);
    expect(urls.every((u) => new URL(u).hostname === "shop.test")).toBe(true);
    expect(urls.some((u) => /logout|delete|\/private\//.test(u))).toBe(false);
    expect(req.mock.calls.every((c) => !c[1]?.method || c[1].method === "GET")).toBe(true);
    expect(urls).toEqual(expect.arrayContaining(["https://shop.test/about", "https://shop.test/pricing", "https://shop.test/static/app.js"]));
    // Passive: no endpoint checks and no error-page requests.
    expect(urls.some((u) => /\/api\/|orbis-sentinel-/.test(u))).toBe(false);
    expect(r.notes.join(" ")).toMatch(/2 link\(s\) that look like actions/);
    expect(r.notes.join(" ")).toMatch(/excluded by robots\.txt/);
    expect(r.map!.surface.endpoints.map((e) => e.path)).toEqual(expect.arrayContaining(["/api/me", "/api/status", "/api/orders", "/api/contact", "/api/login"]));
    const ids = r.findings.map((f) => f.ruleId);
    expect(ids).toEqual(
      expect.arrayContaining(["surface.client-secret", "surface.source-map-public", "surface.third-party-script", "surface.redirect-param", "surface.csrf-unverified", "cookies.flags"]),
    );
    const secret = r.findings.find((f) => f.ruleId === "surface.client-secret")!;
    expect(secret).toMatchObject({ severity: "critical", evidenceSource: "orbis:surface", location: "https://shop.test/static/app.js" });
    expect(secret.evidence[0]!.detail).not.toContain(serviceRole);
    expect(new Set(r.findings.map((f) => f.fingerprint)).size).toBe(r.findings.length);
  });

  it("with active testing, checks discovered endpoints signed-out (GET only, no invented ids) and the error page", async () => {
    const { runSentinel } = await import("@/lib/security/sentinel");
    const req = fake(site());
    const r = await runSentinel("shop.test", "active", { request: req as never, delayMs: 0, budget: crawlBudget("deep", "standard", true) });
    const urls = req.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual(expect.arrayContaining(["https://shop.test/api/me", "https://shop.test/api/status"]));
    expect(urls.some((u) => /\/api\/orders\//.test(u))).toBe(false);
    expect(r.map!.endpointResults.find((e) => e.path === "/api/status")!.outcome).toBe("refused");
    const personal = r.findings.find((f) => f.ruleId === "surface.api-personal-data")!;
    expect(personal.location).toBe("https://shop.test/api/me");
    expect(personal.evidence[0]!.detail).not.toContain("x@y.z");
    expect(r.findings.find((f) => f.ruleId === "surface.error-disclosure")!.title).toMatch(/JavaScript stack trace/);
    expect(r.map!.covered).toEqual(expect.arrayContaining(["https://shop.test/api/me", "https://shop.test/about"]));
  });

  it("stops at the page budget and says how much wasn't fetched", async () => {
    const { runSentinel } = await import("@/lib/security/sentinel");
    const r = await runSentinel("shop.test", "passive", { request: fake(site()) as never, delayMs: 0, budget: { pages: 1, scripts: 0, endpointChecks: 0, seconds: 30 } });
    expect(r.map!.pagesFetched).toBe(1);
    expect(r.notes.join(" ")).toMatch(/Stopped after 1 pages .* not fetched/);
    expect(r.map!.surface.notFetched.length).toBeGreaterThan(0);
  });

  it("without a budget behaves exactly as before (no mapping)", async () => {
    const { runSentinel } = await import("@/lib/security/sentinel");
    const req = fake(site());
    const r = await runSentinel("shop.test", "passive", { request: req as never, delayMs: 0 });
    expect(r.map).toBeUndefined();
    expect(req.mock.calls.length).toBe(3);
  });
});

describe("audit analysis", () => {
  const cfg = { mode: "release_gate" as const, timeBudget: "standard" as const, active: true, gate: DEFAULT_GATE };
  const child = (agent: string, status: string, stats: Record<string, unknown> = {}, tools: { tool: string; status: "ok" | "skipped" | "failed"; detail: string }[] = []) => ({
    id: `run-${agent}`,
    agent,
    status,
    error: status === "failed" ? "boom" : null,
    tools,
    stats,
  });

  it("fails the gate on a blocking finding, and is incomplete when a planned step didn't finish", async () => {
    const { analyseAudit } = await import("@/lib/security/audit-report");
    const findings = [{ ...F({ id: "x", rule_id: "exposure.env-file", severity: "critical" }), run_id: "run-sentinel" }];
    const done = analyseAudit({ cfg, plan: ["sentinel"], children: [child("sentinel", "completed", { pagesFetched: 4, created: 1 })], findings, notRechecked: 0, previous: null });
    expect(done.gate!.outcome).toBe("failed");
    expect(done.paths.map((p) => p.id)).toContain("public-secret");
    expect(done.comparison.created).toBe(1);
    const broken = analyseAudit({
      cfg,
      plan: ["sentinel", "code_guardian"],
      children: [child("sentinel", "completed"), child("code_guardian", "failed")],
      findings: [],
      notRechecked: 0,
      previous: null,
    });
    expect(broken.gate).toMatchObject({ outcome: "incomplete", reasons: ["Code (Code Guardian) failed."] });
    const missing = analyseAudit({ cfg, plan: ["sentinel", "code_guardian"], children: [child("sentinel", "completed")], findings: [], notRechecked: 0, previous: null });
    expect(missing.gate!.reasons).toEqual(["Code (Code Guardian) didn't run."]);
  });

  it("derives coverage from what the steps actually did, and only gates in release-gate mode", async () => {
    const { analyseAudit } = await import("@/lib/security/audit-report");
    const a = analyseAudit({
      cfg: { ...cfg, mode: "deep", active: false },
      plan: ["code_guardian"],
      children: [
        child("code_guardian", "completed", { routes: 12, codeMap: { unmapped: [".go files (routes in this language aren't mapped yet; code rules still ran)"] } }, [
          { tool: "OSV dependency check", status: "failed", detail: "offline" },
        ]),
      ],
      findings: [],
      notRechecked: 3,
      previous: { runId: "p", at: "2026-10-01", stats: { posture: { open: { critical: 1, high: 0, medium: 0, low: 0, info: 0 } } } },
    });
    expect(a.gate).toBeNull();
    const cfgArea = a.coverage.find((c) => c.id === "config")!;
    expect(cfgArea.notChecked).toContain("Known-vulnerable dependencies (OSV)");
    expect(a.coverage.find((c) => c.id === "frontend")!.state).toBe("not_assessed");
    expect(a.coverage.find((c) => c.id === "authz")!.notChecked.join(" ")).toMatch(/\.go files/);
    expect(a.comparison.previous!.open.critical).toBe(1);
    expect(a.notRechecked).toBe(3);
  });

  it("writes report input only from the analysis, and keeps stored records within the size limit", async () => {
    const { analyseAudit, auditSections, compactAnalysis, fitStats } = await import("@/lib/security/audit-report");
    const findings = [F({ id: "a", rule_id: "code.inner-html", agent: "code_guardian", confidence: "tentative" }), F({ id: "b", rule_id: "headers.csp-missing" })];
    const a = analyseAudit({ cfg, plan: ["sentinel"], children: [child("sentinel", "completed")], findings, notRechecked: 0, previous: null });
    const text = auditSections(a, findings, [child("sentinel", "completed")], ["sentinel"]);
    expect(text).toMatch(/^Mode: Pre-release security gate\.\nGate result: PASSED\./);
    expect(text).toMatch(/Needs verification\] code\.inner-html/);
    expect(text).toMatch(/\[medium; theoretical\]/);
    expect(text).toMatch(/Authentication & identity: partial/);
    expect(JSON.stringify(compactAnalysis(a)).length).toBeLessThan(19_000);
    const huge = fitStats({ codeMap: { routes: Array.from({ length: 500 }, (_, i) => ({ path: `/api/route-${i}`, signals: "database write, sign-in check, input validation" })) } });
    expect(JSON.stringify(huge).length).toBeLessThanOrEqual(19_000);
    expect((huge.codeMap as { trimmed: string[] }).trimmed.join(" ")).toMatch(/routes: showing \d+ of 500/);
  });
});
