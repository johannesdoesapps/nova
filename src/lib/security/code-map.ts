import { isScannable, type SourceFile } from "./code-rules";
import { fingerprint, type Confidence, type FindingDraft, type Severity } from "./types";

/**
 * Static application mapping for Code Guardian: which frameworks and runtimes are used, which routes and
 * handlers exist, what each handler visibly does (checks a signed-in user, validates input, writes to the
 * database, calls out to other services, receives webhooks), the trust boundaries between them, and
 * configuration files that commonly hide weaknesses (database access rules, CI workflows, containers,
 * storage policies).
 *
 * Everything is read from the files given — nothing is executed. A route "without a visible sign-in check"
 * means none of the recognised patterns appear in its handler; middleware, a wrapper or database rules may
 * still protect it, so those findings are "Needs verification" until someone confirms them.
 */

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ANY";

export interface RouteInfo {
  method: Method;
  path: string;
  file: string;
  line: number;
  framework: string;
  signals: {
    auth: boolean;
    validation: boolean;
    rateLimit: boolean;
    dbWrite: boolean;
    dbRead: boolean;
    privilegedDb: boolean;
    outboundFetch: boolean;
    upload: boolean;
    webhook: boolean;
    signatureCheck: boolean;
    ownerFilter: boolean;
  };
  /** Where a check was found when it isn't in the handler itself: a helper it calls, or the database's row rules. */
  via?: { auth?: string; owner?: string };
}

export interface CodeMap {
  frameworks: string[];
  runtimes: string[];
  securityLibraries: string[];
  routes: RouteInfo[];
  /** Next.js "use server" files: callable from the browser like routes. */
  serverActions: string[];
  middleware: string[];
  configFiles: string[];
  boundaries: { from: string; to: string; via: string }[];
  backgroundJobs: string[];
  sensitiveRoutes: string[];
  /** Tables created in the SQL files given, and how many have row level security enabled (null: no SQL). */
  rls: { tables: number; withRls: number } | null;
  /** File kinds this mapper doesn't understand, so their routes aren't in the inventory. */
  unmapped: string[];
}

const AUTH =
  /\b(requireUser|requireAuth|requireAdmin|requireSession|getUser|getSession|getServerSession|currentUser|withAuth|isAuthenticated|ensureAuthenticated|authenticate|authorize|verifyToken|verifyJwt|jwt\.verify|jwtVerify|login_required|get_current_user|current_user|IsAuthenticated|permission_classes|auth\(\)|getAuth|clerkClient|withApiAuthRequired|assertAdmin|isAdmin)\b/;
const VALIDATION = /\b(z\.object|safeParse|\.parse\(|parseJsonBody|Joi\.|yup\.|validate\(|validator\.|BaseModel|Schema\(|serializer|class-validator|express-validator|checkSchema)\b/;
const RATE = /rate.?limit|limiter|throttle|slowDown|Ratelimit/i;
const DB_WRITE = /\.(insert|update|upsert|delete|destroy|create|createMany|updateMany|deleteMany|save)\(|\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b|\.rpc\(/i;
const DB_READ = /\.(select|findMany|findFirst|findUnique|findOne|find|query|execute)\(|\bSELECT\b.+\bFROM\b|\.from\(\s*["'`]/i;
const PRIVILEGED = /service_?role|SERVICE_ROLE|createAdminClient|adminClient|supabaseAdmin|getServiceClient|serviceClient/;
const OUTBOUND = /\b(fetch|axios(?:\.\w+)?|got|request|urlopen|requests\.(?:get|post))\s*\(\s*(?!["'`]https?:)/;
const UPLOAD = /formData\(\)|multer|busboy|formidable|request\.files|UploadFile|multipart/i;
const SIGNATURE = /constructEvent|verifySignature|verify_signature|verifyWebhook|timingSafeEqual|compare_digest|createHmac|hmac\.new|svix|x-hub-signature|stripe-signature|webhook[_-]?secret/i;
const OWNER =
  /\.eq\(\s*["'`](user_id|owner_id|owner|account_id|tenant_id|org_id)["'`]|user_?id\s*[:=]\s*(user|auth|session|req\.user)|where[^;\n]*user_?id|owner_?id|request\.user|req\.user\.id|current_user\.id/i;
// Only names that come from the request: a URL from server configuration (env, constants) isn't a lead.
const REQUEST_URL =
  /(fetch|axios(?:\.\w+)?|got|requests\.(?:get|post)|urlopen)\(\s*(?:new URL\()?\s*(?:(?:body|params|query|input|payload|data)\.\w+|req\.(?:query|body|params)\.\w+|request\.(?:args|form|json)\b|searchParams\.get\([^)]*\))/;
const MASS_ASSIGN =
  /\.(insert|update|upsert|create|save)\(\s*(await\s+req(?:uest)?\.json\(\)|req\.body|request\.json|request\.data|body|data|payload|input)\s*[,)]|\.\.\.\s*(req\.body|body|payload|input)\b(?![.\w])/;
const PUBLIC_PATH =
  /(^|\/)(login|log-in|signin|sign-in|signup|sign-up|register|logout|auth|callback|oauth|webhooks?|health|healthz|status|ping|og|sitemap|robots|manifest|public|contact|subscribe|newsletter|feedback|share|cron)(\/|$|\.)/i;
// Paths that usually return one user's or account's data.
const ACCOUNT_DATA = /(^|\/)(me|user|users|account|accounts|profile|profiles|orders?|invoices?|billing|customers?|members?|payments?|subscriptions?|export|admin)(\/|$)/i;
const SENSITIVE_PATH = /(admin|billing|checkout|payment|subscription|stripe|password|reset|token|secret|key|export|delete|account|team|invite|role|permission|settings)/i;

const linesOf = (s: string) => s.split("\n");
const lineAt = (s: string, index: number) => s.slice(0, index).split("\n").length;

function nextPath(file: string): string | null {
  const m = /(?:^|\/)(?:src\/)?app\/(.*?)\/?route\.(?:ts|tsx|js|jsx|mjs)$/.exec(file);
  if (m)
    return (
      "/" +
      m[1]!
        .split("/")
        .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"))
        .map(seg)
        .join("/")
    );
  const p = /(?:^|\/)(?:src\/)?pages\/(api\/.*?)\.(?:ts|tsx|js|jsx|mjs)$/.exec(file);
  if (p)
    return (
      "/" +
      p[1]!
        .replace(/\/index$/, "")
        .split("/")
        .map(seg)
        .join("/")
    );
  return null;
}
const seg = (s: string) => s.replace(/^\[\[?\.\.\.(\w+)\]?\]$/, ":$1*").replace(/^\[(\w+)\]$/, ":$1");

/** Exported helpers that check the signed-in user or filter by owner, so a handler calling them gets credit (one level deep). */
type Helpers = Map<string, { auth: boolean; owner: boolean; file: string }>;

function helperIndex(files: SourceFile[]): Helpers {
  const out: Helpers = new Map();
  for (const f of files) {
    if (!/\.(jsx?|tsx?|mjs|cjs)$/.test(f.path) || nextPath(f.path)) continue;
    const decls = [...f.content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*[(<]|export\s+const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g)];
    decls.forEach((m, i) => {
      const body = f.content.slice(m.index!, Math.min(decls[i + 1]?.index ?? f.content.length, m.index! + 6000));
      const auth = AUTH.test(body);
      const owner = OWNER.test(body);
      if (auth || owner) out.set(m[1] ?? m[2]!, { auth, owner, file: f.path });
    });
  }
  return out;
}

function calledHelper(code: string, helpers: Helpers, want: "auth" | "owner"): string | undefined {
  for (const m of code.matchAll(/\b([A-Za-z_]\w*)\s*[(<]/g)) {
    const h = helpers.get(m[1]!);
    if (h?.[want]) return `${m[1]}() in ${h.file}`;
  }
  return undefined;
}

function signalsFor(code: string, path: string): RouteInfo["signals"] {
  // Path only: a comment mentioning webhooks doesn't make a route one.
  const webhook = /webhook|\/hooks?(\/|$)/i.test(path);
  return {
    auth: AUTH.test(code),
    validation: VALIDATION.test(code),
    rateLimit: RATE.test(code),
    dbWrite: DB_WRITE.test(code),
    dbRead: DB_READ.test(code),
    privilegedDb: PRIVILEGED.test(code),
    outboundFetch: OUTBOUND.test(code),
    upload: UPLOAD.test(code),
    webhook,
    signatureCheck: SIGNATURE.test(code),
    ownerFilter: OWNER.test(code),
  };
}

/** The handler's source: a whole Next.js route file, or the lines following an Express/Flask route declaration. */
function handlerAfter(content: string, index: number, maxLines = 60) {
  return content.slice(index).split("\n").slice(0, maxLines).join("\n");
}

export function mapCode(files: SourceFile[]): CodeMap {
  const helpers = helperIndex(files);
  const routes: RouteInfo[] = [];
  const serverActions: string[] = [];
  const middleware: string[] = [];
  const configFiles: string[] = [];
  const backgroundJobs: string[] = [];
  const frameworks = new Set<string>();
  const runtimes = new Set<string>();
  const libs = new Set<string>();
  const boundaries = new Map<string, { from: string; to: string; via: string }>();
  const unmapped = new Set<string>();
  const add = (from: string, to: string, via: string) => boundaries.set(`${from}>${to}`, { from, to, via });

  for (const f of files) {
    const path = f.path;
    const c = f.content;
    if (/(^|\/)package\.json$/.test(path) && !/node_modules/.test(path)) {
      try {
        const pkg = JSON.parse(c) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: Record<string, string> };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const has = (n: string) => n in deps;
        const ver = (n: string) => `${n} ${deps[n]}`;
        for (const n of ["next", "express", "fastify", "koa", "@nestjs/core", "nuxt", "@remix-run/node", "@sveltejs/kit", "hono", "react", "vue"]) if (has(n)) frameworks.add(ver(n));
        for (const n of [
          "@supabase/supabase-js",
          "@supabase/ssr",
          "next-auth",
          "@auth/core",
          "@clerk/nextjs",
          "passport",
          "jsonwebtoken",
          "jose",
          "bcrypt",
          "bcryptjs",
          "argon2",
          "helmet",
          "cors",
          "csurf",
          "express-rate-limit",
          "@upstash/ratelimit",
          "stripe",
          "prisma",
          "@prisma/client",
          "drizzle-orm",
          "mongoose",
          "pg",
          "mysql2",
          "zod",
          "joi",
          "dompurify",
          "sanitize-html",
        ])
          if (has(n)) libs.add(ver(n));
        if (pkg.engines?.node) runtimes.add(`Node.js ${pkg.engines.node}`);
        if (has("stripe")) add("Server", "Stripe", "stripe package");
        if (has("@supabase/supabase-js")) add("Server", "Supabase (database, auth)", "@supabase/supabase-js");
        if (has("@prisma/client") || has("prisma") || has("drizzle-orm") || has("pg") || has("mysql2") || has("mongoose")) add("Server", "Database", "ORM / driver");
        if (has("openai") || has("@anthropic-ai/sdk") || has("@google/genai")) add("Server", "AI providers", "SDK");
        if (has("resend") || has("nodemailer") || has("@sendgrid/mail")) add("Server", "Email provider", "SDK");
      } catch {
        /* not JSON */
      }
      continue;
    }
    if (/(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile)$/.test(path)) {
      for (const n of ["django", "flask", "fastapi", "starlette", "sqlalchemy", "pyjwt", "authlib", "passlib", "celery", "boto3", "requests"])
        if (new RegExp(`^\\s*${n}\\b`, "im").test(c)) (/(django|flask|fastapi|starlette)/.test(n) ? frameworks : libs).add(n);
      const py = /python_requires\s*=\s*["']([^"']+)/.exec(c) ?? /requires-python\s*=\s*["']([^"']+)/.exec(c);
      if (py) runtimes.add(`Python ${py[1]}`);
      if (/celery/i.test(c)) backgroundJobs.push(`Celery workers (${path})`);
      continue;
    }
    if (/(^|\/)\.nvmrc$/.test(path)) runtimes.add(`Node.js ${c.trim().slice(0, 20)}`);
    if (
      /(^|\/)Dockerfile[^/]*$|docker-compose\.ya?ml$|(^|\/)vercel\.json$|netlify\.toml$|\.tf$|(^|\/)\.github\/workflows\/.*\.ya?ml$|(^|\/)(k8s|kubernetes|helm)\/.*\.ya?ml$|firebase\.json$|firestore\.rules$|storage\.rules$|(^|\/)supabase\/migrations\/.*\.sql$|next\.config\.[mc]?[jt]s$|(^|\/)middleware\.[jt]s$/.test(
        path,
      )
    )
      configFiles.push(path);
    if (/(^|\/)Dockerfile[^/]*$/.test(path)) for (const m of c.matchAll(/^\s*FROM\s+(\S+)/gim)) runtimes.add(`Container ${m[1]}`);
    if (/(^|\/)vercel\.json$/.test(path) && /"crons"/.test(c)) backgroundJobs.push(`Vercel cron jobs (${path})`);
    if (!isScannable(path)) continue;
    if (/\.(jsx?|tsx?|mjs|cjs)$/.test(path)) {
      if (/(^|\/)(src\/)?middleware\.[jt]s$/.test(path)) middleware.push(path);
      if (/^\s*["']use server["']/m.test(c.slice(0, 400))) serverActions.push(path);
      const np = nextPath(path);
      if (np) {
        frameworks.add("Next.js routes");
        const methods = [...c.matchAll(/export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => ({ method: m[1] as Method, index: m.index! }));
        const list = methods.length ? methods : /pages\/api\//.test(path) ? [{ method: "ANY" as Method, index: 0 }] : [];
        for (const m of list) routes.push({ method: m.method, path: np, file: path, line: lineAt(c, m.index), framework: "Next.js", signals: signalsFor(c, np) });
        continue;
      }
      for (const m of c.matchAll(/\b(app|router|server|api|fastify)\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]/g)) {
        frameworks.add("Express-style routes");
        const handler = handlerAfter(c, m.index!);
        routes.push({
          method: m[2] === "all" ? "ANY" : (m[2]!.toUpperCase() as Method),
          path: m[3]!,
          file: path,
          line: lineAt(c, m.index!),
          framework: "Express-style",
          signals: signalsFor(handler + fileAuthPreamble(c, m[0]), m[3]!),
        });
      }
      if (/\bfetch\(/.test(c) && /["'`]\/api\//.test(c) && /(^|\/)(components|app|pages|src)\//.test(path)) add("Browser", "Your API routes", "fetch('/api/…')");
      continue;
    }
    if (/\.py$/.test(path)) {
      for (const m of c.matchAll(/@(\w+)\.(route|get|post|put|patch|delete)\(\s*["']([^"']+)["']([^)\n]*)\)/g)) {
        const methods = m[2] === "route" ? ((/methods\s*=\s*\[([^\]]*)\]/.exec(m[4]!)?.[1] ?? "'GET'").match(/[A-Z]+/g) ?? ["GET"]) : [m[2]!.toUpperCase()];
        const handler = handlerAfter(c, Math.max(0, c.lastIndexOf("\n", m.index! - 1)), 50);
        frameworks.add(m[2] === "route" ? "Flask" : "FastAPI");
        for (const method of methods)
          routes.push({ method: method as Method, path: m[3]!, file: path, line: lineAt(c, m.index!), framework: m[2] === "route" ? "Flask" : "FastAPI", signals: signalsFor(handler, m[3]!) });
      }
      if (/(^|\/)urls\.py$/.test(path))
        for (const m of c.matchAll(/\b(?:re_)?path\(\s*r?["']([^"']*)["']\s*,\s*([\w.]+)/g)) {
          frameworks.add("Django");
          routes.push({
            method: "ANY",
            path: `/${m[1]}`,
            file: path,
            line: lineAt(c, m.index!),
            framework: "Django",
            signals: { ...signalsFor("", m[1]!), auth: /login_required|LoginRequired/.test(c) },
          });
        }
      continue;
    }
    if (/\.(rb|go|java|cs|php)$/.test(path)) unmapped.add(path.split(".").pop()!);
  }
  // Row level security in the SQL given: tables created vs. tables with RLS enabled.
  const sql = files
    .filter((f) => /\.sql$/.test(f.path))
    .map((f) => f.content)
    .join("\n");
  const created = [...new Set([...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?(\w+)"?/gi)].map((m) => m[1]!.toLowerCase()))];
  const withRls = created.filter((t) => new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:"?public"?\\.)?"?${t}"?\\s+enable\\s+row\\s+level\\s+security`, "i").test(sql)).length;
  const rls = created.length ? { tables: created.length, withRls } : null;
  const rlsEverywhere = !!rls && rls.withRls === rls.tables;

  // Trace one level: checks inside helpers the handler calls, and row rules for user-scoped database access.
  for (const r of routes) {
    const content = files.find((f) => f.path === r.file)?.content ?? "";
    const code =
      r.framework === "Next.js"
        ? content
        : content
            .split("\n")
            .slice(r.line - 1, r.line + 59)
            .join("\n");
    const authVia = r.signals.auth ? undefined : calledHelper(code, helpers, "auth");
    if (authVia) {
      r.signals.auth = true;
      r.via = { ...r.via, auth: authVia };
    }
    if (r.signals.ownerFilter) continue;
    const ownerVia = calledHelper(code, helpers, "owner") ?? (rlsEverywhere && !r.signals.privilegedDb ? `row level security (enabled on all ${rls!.tables} tables in the SQL given)` : undefined);
    if (ownerVia) {
      r.signals.ownerFilter = true;
      r.via = { ...r.via, owner: ownerVia };
    }
  }

  if (routes.length) add("Browser", "Your API routes", "HTTP requests");
  if (routes.some((r) => r.signals.webhook)) add("Third-party services", "Your webhook routes", "Signed HTTP callbacks");
  if (routes.some((r) => r.signals.outboundFetch)) add("Your API routes", "External URLs", "Server-side fetch");
  if (routes.some((r) => r.signals.privilegedDb)) add("Your API routes", "Database (privileged client)", "Service-role / admin client bypassing row rules");

  const sensitiveRoutes = [...new Set(routes.filter((r) => SENSITIVE_PATH.test(r.path)).map((r) => `${r.method} ${r.path}`))];
  return {
    frameworks: [...frameworks],
    runtimes: [...runtimes],
    securityLibraries: [...libs],
    routes: routes.slice(0, 400),
    serverActions,
    middleware,
    configFiles,
    boundaries: [...boundaries.values()],
    backgroundJobs,
    sensitiveRoutes,
    rls,
    unmapped: [...unmapped].map((e) => `.${e} files (routes in this language aren't mapped yet; code rules still ran)`),
  };
}

/** Express routers often apply auth once with router.use(...) near the top of the file. */
function fileAuthPreamble(content: string, decl: string) {
  const before = content.slice(0, content.indexOf(decl));
  return /\.use\(\s*[^)]*\b(auth|authenticate|requireAuth|requireUser|ensureAuthenticated|passport\.authenticate|verifyToken)\b/i.test(before) ? "requireAuth" : "";
}

/* ------------------------------------------------------------------ findings */

interface Spec {
  ruleId: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  description: string;
  rationale: string;
  remediation: string;
  references: string[];
}

const OWASP = {
  access: "https://owasp.org/Top10/A01_2021-Broken_Access_Control/",
  api1: "https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/",
  api3: "https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/",
  api4: "https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/",
  ssrf: "https://owasp.org/Top10/A10_2021-Server-Side_Request_Forgery_%28SSRF%29/",
  webhook: "https://cheatsheetseries.owasp.org/cheatsheets/Web_Service_Security_Cheat_Sheet.html",
  rls: "https://supabase.com/docs/guides/database/postgres/row-level-security",
  gha: "https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/",
  docker: "https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html",
  cors: "https://portswigger.net/web-security/cors",
  firebase: "https://firebase.google.com/docs/rules/insecure-rules",
  s3: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html",
  mfa: "https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html",
};

const STATE_CHANGING = new Set<Method>(["POST", "PUT", "PATCH", "DELETE", "ANY"]);

/** Findings from the map and configuration files. Each says exactly what was (and wasn't) seen. */
export function codeMapFindings(map: CodeMap, files: SourceFile[], asset: string): FindingDraft[] {
  const out: FindingDraft[] = [];
  const push = (s: Spec, location: string, evidence: { source: string; detail: string }[], key: string) =>
    out.push({ ...s, agent: "code_guardian", asset, location, evidence, evidenceSource: "orbis:code-map", fingerprint: fingerprint("code_guardian", s.ruleId, asset, key) });
  const mw = map.middleware.length ? ` Middleware exists (${map.middleware.join(", ")}) and may protect it — check its matcher.` : "";

  for (const r of map.routes) {
    const where = `${r.file}:${r.line}`;
    const ev = (extra: string) => [{ source: where, detail: `${r.method} ${r.path} (${r.framework}). ${extra}` }];
    const s = r.signals;
    if (STATE_CHANGING.has(r.method) && !s.auth && !s.webhook && !PUBLIC_PATH.test(r.path) && (s.dbWrite || s.privilegedDb || s.outboundFetch || s.upload)) {
      push(
        {
          ruleId: "map.route-no-auth",
          title: `${r.method} ${r.path} changes data without a visible sign-in check`,
          severity: s.privilegedDb ? "high" : "medium",
          confidence: "tentative",
          description: `The handler ${s.dbWrite ? "writes to the database" : s.upload ? "accepts uploads" : s.privilegedDb ? "uses a privileged database client" : "calls out to other services"} but none of the recognised sign-in checks appear in it.${mw}`,
          rationale: "If nothing else protects it, anyone could call it directly. Middleware, a wrapper or database rules may already protect it, so this needs confirming.",
          remediation: "Check the signed-in user at the start of the handler (and their permission for this action) on the server, even if the page that calls it is already protected.",
          references: [OWASP.access],
        },
        where,
        ev(`Signals: ${describeSignals(s, r.via)}.`),
        `${r.method} ${r.path}`,
      );
    }
    if (r.method === "GET" && !s.auth && s.dbRead && ACCOUNT_DATA.test(r.path) && !PUBLIC_PATH.test(r.path)) {
      push(
        {
          ruleId: "map.read-no-auth",
          title: `GET ${r.path} reads account data without a visible sign-in check`,
          severity: "medium",
          confidence: "tentative",
          description: `The handler reads from the database and its path suggests per-user or account data, but none of the recognised sign-in checks appear in it or in the helpers it calls.${mw}`,
          rationale: "Fine if the data is meant to be public; a data leak if it isn't. A signed-out request to the live endpoint can confirm which.",
          remediation: "Check the signed-in user on the server and return only that user's records (or make the route explicitly public and limit its fields).",
          references: [OWASP.access],
        },
        where,
        ev(`Signals: ${describeSignals(s, r.via)}.`),
        `GET ${r.path}`,
      );
    }
    if (s.webhook && STATE_CHANGING.has(r.method) && !s.signatureCheck) {
      push(
        {
          ruleId: "map.webhook-no-signature",
          title: `Webhook ${r.path} doesn't visibly verify the sender's signature`,
          severity: "high",
          confidence: "firm",
          description:
            "The webhook handler has no recognised signature check (Stripe constructEvent, HMAC comparison, Svix, GitHub signature…), so anyone who finds the URL may be able to send forged events.",
          rationale: "Forged payment or account events can grant access or credit without paying. Confirm whether verification happens elsewhere.",
          remediation: "Verify the provider's signature over the raw request body with the webhook secret before acting on the event, and reject old timestamps.",
          references: [OWASP.webhook],
        },
        where,
        ev("No signature verification pattern found in the handler."),
        `${r.path}`,
      );
    }
    if (MASS_ASSIGN.test(fileText(files, r.file)) && s.dbWrite && STATE_CHANGING.has(r.method)) {
      const line = findLine(files, r.file, MASS_ASSIGN);
      push(
        {
          ruleId: "map.mass-assignment",
          title: `${r.method} ${r.path} writes the request body straight to the database`,
          severity: "medium",
          confidence: s.validation ? "tentative" : "firm",
          description: `The request body is passed to a database write without picking allowed fields${s.validation ? " (some validation exists — check it strips unknown fields)" : ""}. A caller can set fields the form doesn't show, such as role, plan, owner or price.`,
          rationale: "Mass assignment lets users change protected properties of their own or other records.",
          remediation: "Copy only the fields a user may change into the write (an allow-list or a strict schema that drops unknown keys), and set owner/role fields on the server.",
          references: [OWASP.api3],
        },
        line ? `${r.file}:${line.n}` : where,
        line ? [{ source: `${r.file}:${line.n}`, detail: line.text }] : ev(""),
        `${r.file}`,
      );
    }
    if (/:\w+/.test(r.path) && (s.dbRead || s.dbWrite) && !s.ownerFilter) {
      push(
        {
          ruleId: "map.object-access",
          title: `${r.method} ${r.path} loads a record by id without a visible owner check`,
          severity: "medium",
          confidence: "tentative",
          description: `The route takes an id from the URL and reads or changes a record, but no filter on the owner (user_id, owner, tenant…) appears in the handler.${s.auth ? " It does check the signed-in user, so the question is whether it checks that the record belongs to them." : ""} Database row rules (for example Supabase RLS) may already enforce this.`,
          rationale: "Without an ownership check, one user may read or change another user's records by changing the id.",
          remediation: "Filter by the signed-in user's id (or tenant) as well as the record id, or rely on row-level rules — and add a test that another user's id returns not found.",
          references: [OWASP.api1],
        },
        where,
        ev(`Signals: ${describeSignals(s, r.via)}.`),
        `${r.method} ${r.path}`,
      );
    }
    if (REQUEST_URL.test(fileText(files, r.file))) {
      const line = findLine(files, r.file, REQUEST_URL);
      push(
        {
          ruleId: "map.server-fetch-input",
          title: `${r.path} fetches a URL that may come from the request`,
          severity: "high",
          confidence: "tentative",
          description: "The server fetches a URL built from request data. If it isn't restricted, a caller can make your server reach internal addresses or cloud metadata.",
          rationale: "Server-side request forgery can expose internal services and cloud credentials. The variable name suggests user input; confirm where it comes from.",
          remediation: "Allow only expected hosts, resolve the address and block private, loopback and link-local ranges at connect time, and don't follow redirects to other hosts.",
          references: [OWASP.ssrf],
        },
        line ? `${r.file}:${line.n}` : where,
        line ? [{ source: `${r.file}:${line.n}`, detail: line.text }] : ev(""),
        `${r.file}`,
      );
    }
    if (
      /(^|\/)(login|log-in|signin|sign-in|signup|sign-up|register|reset-password|password-reset|forgot|forgot-password|otp|magic-link|verify-email|resend-code)(\/|$)/i.test(r.path) &&
      STATE_CHANGING.has(r.method) &&
      !s.rateLimit
    ) {
      push(
        {
          ruleId: "map.auth-no-rate-limit",
          title: `${r.path} has no visible rate limit`,
          severity: "low",
          confidence: "tentative",
          description: "A sign-in, sign-up, reset or code-verification route has no recognised rate limiting in its handler. Your platform or auth provider may limit it already.",
          rationale: "Without limits, attackers can guess passwords or codes and send floods of emails.",
          remediation: "Limit attempts per account and per IP (with backoff), and confirm what your auth provider already enforces.",
          references: [OWASP.api4, OWASP.mfa],
        },
        where,
        ev("No rate-limit pattern found."),
        `${r.path}`,
      );
    }
  }

  for (const f of files) {
    const c = f.content;
    if (/(^|\/)supabase\/migrations\/.*\.sql$|(^|\/)(schema|migrations?)\/.*\.sql$/.test(f.path)) {
      const all = files
        .filter((x) => /\.sql$/.test(x.path))
        .map((x) => x.content)
        .join("\n");
      for (const m of c.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?(\w+)"?/gi)) {
        const table = m[1]!;
        const rls = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:"?public"?\\.)?"?${table}"?\\s+enable\\s+row\\s+level\\s+security`, "i");
        if (!rls.test(all)) {
          const n = lineAt(c, m.index!);
          push(
            {
              ruleId: "config.rls-disabled",
              title: `Table "${table}" is created without row level security`,
              severity: "high",
              confidence: "firm",
              description: `No "enable row level security" for ${table} was found in any SQL file given. In Supabase, tables in the public schema without RLS can be read and changed by anyone holding the public (anon) key — which every visitor's browser has.`,
              rationale: "Exposes the whole table through the auto-generated API unless RLS is enabled elsewhere (for example in the dashboard).",
              remediation: `alter table public.${table} enable row level security; then add policies that only allow each user their own rows.`,
              references: [OWASP.rls],
            },
            `${f.path}:${n}`,
            [{ source: `${f.path}:${n}`, detail: m[0].slice(0, 200) }],
            `${table}`,
          );
        }
      }
      for (const m of c.matchAll(/create\s+policy\s+"?([^"\n]+?)"?\s+on\s+([\w."]+)[^;]*?for\s+(insert|update|delete|all)[^;]*?(?:using|with\s+check)\s*\(\s*true\s*\)/gis)) {
        const n = lineAt(c, m.index!);
        push(
          {
            ruleId: "config.policy-allows-all",
            title: `Policy "${m[1]}" lets anyone ${m[3]!.toLowerCase()} rows in ${m[2]}`,
            severity: "medium",
            confidence: "firm",
            description: "A row level security policy for a write operation uses (true), so it doesn't limit whose rows can be changed.",
            rationale: "Any user the policy applies to can change every row.",
            remediation: "Compare the row's owner column with auth.uid() in the policy (for example using (user_id = (select auth.uid()))).",
            references: [OWASP.rls],
          },
          `${f.path}:${n}`,
          [{ source: `${f.path}:${n}`, detail: m[0].replace(/\s+/g, " ").slice(0, 240) }],
          `${f.path}:${m[1]}`,
        );
      }
    }
    if (/(^|\/)\.github\/workflows\/.*\.ya?ml$/.test(f.path) && /pull_request_target/.test(c) && /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/.test(c)) {
      const n = lineAt(c, c.search(/pull_request_target/));
      push(
        {
          ruleId: "config.ci-untrusted-checkout",
          title: "CI workflow runs pull-request code with repository secrets",
          severity: "high",
          confidence: "firm",
          description: "The workflow uses pull_request_target and checks out the pull request's head. Code from anyone's pull request then runs with your repository's secrets and write token.",
          rationale: "A pull request from a fork can steal secrets or push to your repository.",
          remediation: "Use pull_request for untrusted code, or don't check out the head ref in pull_request_target workflows; keep secrets out of jobs that build untrusted code.",
          references: [OWASP.gha],
        },
        `${f.path}:${n}`,
        [{ source: `${f.path}:${n}`, detail: "on: pull_request_target + checkout of github.event.pull_request.head" }],
        f.path,
      );
    }
    if (/(^|\/)Dockerfile[^/]*$/.test(f.path)) {
      if (!/^\s*USER\s+(?!root\b)\S+/im.test(c))
        push(
          {
            ruleId: "config.container-root",
            title: `Container in ${f.path} runs as root`,
            severity: "low",
            confidence: "firm",
            description: "The Dockerfile never switches to a non-root USER, so the application runs as root inside the container.",
            rationale: "Any code-execution bug gets root inside the container, making escapes and tampering easier.",
            remediation: "Create an unprivileged user and add USER <name> before the CMD/ENTRYPOINT.",
            references: [OWASP.docker],
          },
          f.path,
          [{ source: f.path, detail: "No USER instruction for a non-root user." }],
          f.path,
        );
      const latest = /^\s*FROM\s+([^\s:@]+)(?::latest)?\s*$/im.exec(c);
      if (latest && !/:/.test(latest[0].split(/\s+/)[1] ?? "") && !/scratch/i.test(latest[1]!))
        push(
          {
            ruleId: "config.container-unpinned",
            title: `Base image in ${f.path} isn't pinned to a version`,
            severity: "info",
            confidence: "firm",
            description: "The base image has no tag (or :latest), so builds can silently pick up a different image.",
            rationale: "Unreviewed upstream changes reach production; not a vulnerability on its own.",
            remediation: "Pin the base image to a version tag (and ideally a digest), and update it deliberately.",
            references: [OWASP.docker],
          },
          f.path,
          [{ source: f.path, detail: latest[0].trim() }],
          f.path,
        );
    }
    if (/\.(jsx?|tsx?|mjs|cjs)$/.test(f.path) && !/(^|\/)(tests?|__tests__)\//.test(f.path)) {
      const m = /cors\(\s*\{[^}]*origin\s*:\s*(true|["'`]\*["'`])[^}]*credentials\s*:\s*true/s.exec(c) ?? /cors\(\s*\{[^}]*credentials\s*:\s*true[^}]*origin\s*:\s*(true|["'`]\*["'`])/s.exec(c);
      if (m) {
        const n = lineAt(c, m.index);
        push(
          {
            ruleId: "config.cors-credentials-any",
            title: "CORS allows any origin together with credentials",
            severity: "medium",
            confidence: "firm",
            description: "The CORS configuration reflects any origin (origin: true or *) and allows credentials, so other websites may read signed-in users' responses.",
            rationale: "Cross-site reading of authenticated data, depending on cookie SameSite settings.",
            remediation: "Allow only a list of your own origins when credentials are enabled.",
            references: [OWASP.cors],
          },
          `${f.path}:${n}`,
          [{ source: `${f.path}:${n}`, detail: m[0].replace(/\s+/g, " ").slice(0, 200) }],
          f.path,
        );
      }
    }
    if (/(^|\/)(firestore|storage|database)\.rules$/.test(f.path) && /allow\s+(read|write|read,\s*write)\s*(:\s*if\s+true)?\s*;/.test(c)) {
      const m = /allow\s+(read|write|read,\s*write)\s*(:\s*if\s+true)?\s*;/.exec(c)!;
      const n = lineAt(c, m.index);
      push(
        {
          ruleId: "config.firebase-open-rules",
          title: `${f.path} allows access without conditions`,
          severity: "high",
          confidence: "firm",
          description: "A security rule grants access without checking the user (if true or no condition).",
          rationale: "Anyone with your public Firebase config can read or change the data it covers.",
          remediation: "Require request.auth != null and match the document's owner to request.auth.uid.",
          references: [OWASP.firebase],
        },
        `${f.path}:${n}`,
        [{ source: `${f.path}:${n}`, detail: m[0] }],
        f.path,
      );
    }
    if (/\.tf$/.test(f.path)) {
      const m = /acl\s*=\s*"public-read(-write)?"/.exec(c) ?? /block_public_(acls|policy)\s*=\s*false/.exec(c);
      if (m) {
        const n = lineAt(c, m.index);
        push(
          {
            ruleId: "config.storage-public",
            title: `Storage bucket in ${f.path} may be public`,
            severity: "medium",
            confidence: "tentative",
            description: "A bucket is configured with a public ACL or with public-access blocking turned off.",
            rationale: "Fine for intentionally public assets; a data leak for anything else.",
            remediation: "Keep public access blocked and serve public assets through a CDN or signed URLs.",
            references: [OWASP.s3],
          },
          `${f.path}:${n}`,
          [{ source: `${f.path}:${n}`, detail: m[0] }],
          f.path,
        );
      }
    }
    if (/(^|\/)\.env(\.(local|production|development|prod))?$/.test(f.path))
      push(
        {
          ruleId: "config.env-committed",
          title: `${f.path} is included in the code`,
          severity: "medium",
          confidence: "confirmed",
          description: "An environment file is part of the code you supplied. These usually hold secrets and shouldn't be in version control.",
          rationale: "Anyone with read access to the repository gets the secrets; they stay in git history after deletion.",
          remediation: "Add .env files to .gitignore, remove them from the repository, and rotate any real secrets they contained.",
          references: ["https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html"],
        },
        f.path,
        [{ source: f.path, detail: `${linesOf(c).filter((l) => /^\s*[A-Z][A-Z0-9_]*\s*=/.test(l)).length} variables (values not shown)` }],
        f.path,
      );
  }
  // Several routes in one file can point at the same line; keep one finding per fingerprint.
  return [...new Map(out.map((f) => [f.fingerprint, f])).values()];
}

const fileText = (files: SourceFile[], path: string) => files.find((f) => f.path === path)?.content ?? "";
function findLine(files: SourceFile[], path: string, re: RegExp): { n: number; text: string } | null {
  const lines = linesOf(fileText(files, path));
  const i = lines.findIndex((l) => re.test(l));
  return i < 0 ? null : { n: i + 1, text: lines[i]!.trim().slice(0, 240) };
}

export function describeSignals(s: RouteInfo["signals"], via?: RouteInfo["via"]): string {
  const on = (Object.entries(s) as [keyof RouteInfo["signals"], boolean][])
    .filter(([, v]) => v)
    .map(([k]) => (k === "auth" && via?.auth ? `${SIGNAL_LABEL[k]} (via ${via.auth})` : k === "ownerFilter" && via?.owner ? `${SIGNAL_LABEL[k]} (via ${via.owner})` : SIGNAL_LABEL[k]));
  return on.length ? on.join(", ") : "none recognised";
}

export const SIGNAL_LABEL: Record<keyof RouteInfo["signals"], string> = {
  auth: "sign-in check",
  validation: "input validation",
  rateLimit: "rate limit",
  dbWrite: "database write",
  dbRead: "database read",
  privilegedDb: "privileged database client",
  outboundFetch: "outbound request",
  upload: "file upload",
  webhook: "webhook",
  signatureCheck: "signature check",
  ownerFilter: "owner filter",
};

/** A copy of the map small enough to keep with the run. */
export function compactMap(m: CodeMap) {
  const routes = m.routes.slice(0, 80).map((r) => ({ method: r.method, path: r.path, file: `${r.file}:${r.line}`, framework: r.framework, signals: describeSignals(r.signals, r.via) }));
  return {
    frameworks: m.frameworks.slice(0, 15),
    runtimes: m.runtimes.slice(0, 10),
    securityLibraries: m.securityLibraries.slice(0, 25),
    routes,
    routeCount: m.routes.length,
    serverActions: m.serverActions.slice(0, 20),
    middleware: m.middleware,
    configFiles: m.configFiles.slice(0, 30),
    boundaries: m.boundaries,
    backgroundJobs: m.backgroundJobs,
    rls: m.rls,
    sensitiveRoutes: m.sensitiveRoutes.slice(0, 30),
    unmapped: m.unmapped,
    trimmed: m.routes.length > 80 ? [`Routes: showing 80 of ${m.routes.length}`] : [],
  };
}
export type CompactCodeMap = ReturnType<typeof compactMap>;
