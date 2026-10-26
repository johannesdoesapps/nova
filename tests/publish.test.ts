import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { keptPrivate, localReferences, planSite, publicUrl, siteFingerprint, siteKey, siteProjectName } from "@/lib/publish/site";
import { checkReachable, publishConfig, VercelHost } from "@/lib/publish/vercel";
import { OPERATIONS } from "@/lib/bastion/policy";

const ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const html = (body: string) => `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;

describe("planning a site for publishing", () => {
  it("publishes a plain site from its index.html", () => {
    const p = planSite([
      { path: "index.html", content: html('<a href="about.html">About</a><img src="img/logo.png"><a href="https://example.com">x</a><a href="#top">top</a>') },
      { path: "about.html", content: html("") },
      { path: "style.css", content: "body{background:url('img/bg.jpg')}" },
      { path: "img/logo.png", content: "png" },
      { path: "img/bg.jpg", content: "jpg" },
    ]);
    expect(p.kind).toBe("static");
    expect(p.entry).toBe("index.html");
    expect(p.framework).toBeNull();
    expect(p.problems).toEqual([]);
    expect(p.files.map((f) => f.path)).toHaveLength(5);
  });

  it("refuses a site without a home page, and says which page to rename", () => {
    const p = planSite([{ path: "home.html", content: html("") }]);
    expect(p.problems[0]).toMatchObject({ level: "error" });
    expect(p.problems[0].message).toMatch(/index\.html.*home\.html/);
    expect(planSite([]).problems.some((x) => x.level === "error")).toBe(true);
  });

  it("warns about links to files that aren't in the project (the site still publishes)", () => {
    const p = planSite([{ path: "index.html", content: html('<script src="./js/app.js"></script><a href="/pricing">p</a><a href="blog/">b</a>') }, { path: "blog/index.html", content: "" }, { path: "pricing.html", content: "" }]);
    const msgs = p.problems.map((x) => x.message).join("\n");
    expect(p.problems.every((x) => x.level === "warning")).toBe(true);
    expect(msgs).toMatch(/style\.css/);
    expect(msgs).toMatch(/js\/app\.js/);
    expect(msgs).not.toMatch(/pricing|blog/); // clean URLs and folders resolve
  });

  it("resolves relative links from the page's own folder, and ignores external and templated ones", () => {
    expect(localReferences({ path: "docs/guide/a.html", content: '<img src="../img/x.png"><a href="mailto:a@b.c"></a><a href="{{url}}"></a><img src="data:image/png;base64,AA">' })).toEqual(["docs/img/x.png"]);
    expect(localReferences({ path: "a.html", content: '<img src="../../../etc/passwd">' })).toEqual([]);
  });

  it("keeps secrets, dependencies and Orbis's notes out of the published files", () => {
    for (const p of [".env", ".env.production", "config/server.key", "id_rsa", "node_modules/x/index.js", ".git/config", "orbis-effects/voice-glow.md", "credentials.json", ".env.example"]) expect(keptPrivate(p), p).not.toBeNull();
    for (const p of ["index.html", "keys.html", "env.js", "environment.md"]) expect(keptPrivate(p), p).toBeNull();
    const p = planSite([{ path: "index.html", content: html("") }, { path: "style.css", content: "" }, { path: ".env", content: "SECRET=1" }]);
    expect(p.files.map((f) => f.path)).toEqual(["index.html", "style.css"]);
    expect(p.excluded).toEqual([".env"]);
    expect(p.problems.find((x) => /private/.test(x.message))?.level).toBe("warning");
  });

  it("blocks publishing a file with a live credential in it (Google browser keys only warn)", () => {
    const leaked = planSite([{ path: "index.html", content: html("") }, { path: "style.css", content: "" }, { path: "app.js", content: 'const k = "sk_live_' + "a".repeat(24) + '";' }]);
    expect(leaked.problems.find((x) => x.level === "error")?.message).toMatch(/app\.js.*Stripe live key/);
    const maps = planSite([{ path: "index.html", content: html("") }, { path: "style.css", content: "" }, { path: "map.js", content: "key=AIza" + "b".repeat(35) }]);
    expect(maps.problems.some((x) => x.level === "error")).toBe(false);
    expect(maps.problems.some((x) => /Google API key/.test(x.message))).toBe(true);
  });

  it("lets the host build projects with a build script, picking the framework from dependencies", () => {
    const pkg = (deps: Record<string, string>, scripts: Record<string, string> = { build: "x" }) => ({ path: "package.json", content: JSON.stringify({ scripts, dependencies: deps }) });
    expect(planSite([pkg({ next: "16" })])).toMatchObject({ kind: "build", framework: "nextjs", buildCommand: null, entry: "package.json" });
    expect(planSite([pkg({ vite: "6", react: "19" })])).toMatchObject({ framework: "vite" });
    expect(planSite([pkg({ eleventy: "3" })])).toMatchObject({ kind: "build", framework: null, buildCommand: "npm run build" });
    // A package.json without a build script is just a static site with tooling.
    expect(planSite([pkg({}, { start: "serve" }), { path: "index.html", content: "" }])).toMatchObject({ kind: "static", entry: "index.html" });
    expect(planSite([{ path: "package.json", content: "{oops" }]).problems[0].message).toMatch(/isn't valid JSON/);
  });

  it("enforces the size limits", () => {
    const many = Array.from({ length: 301 }, (_, i) => ({ path: `p${i}.html`, content: "" }));
    expect(planSite([{ path: "index.html", content: "" }, ...many]).problems.some((x) => /at most 300/.test(x.message))).toBe(true);
    expect(planSite([{ path: "index.html", content: "x".repeat(9 * 1024 * 1024) }]).problems.some((x) => /MB/.test(x.message))).toBe(true);
  });
});

describe("site identity", () => {
  it("names the site after the project with a key from its id, so renaming keeps the address", () => {
    expect(siteKey(ID)).toBe("3fa85f645717");
    expect(siteProjectName("My Portfolio — Café!", ID)).toBe("my-portfolio-cafe-3fa85f645717");
    expect(siteProjectName("!!!", ID)).toBe("site-3fa85f645717");
    expect(siteProjectName("x".repeat(80), ID).length).toBeLessThanOrEqual(53);
    expect(siteProjectName("a".repeat(39) + "-b", ID)).not.toMatch(/--/);
  });

  it("shares the project's own production domain, not a one-off deployment URL", () => {
    expect(publicUrl(["shop-3fa85f645717-team.vercel.app", "shop-3fa85f645717.vercel.app", "custom.example.com"], "shop-abc123.vercel.app", "shop-3fa85f645717")).toBe("https://shop-3fa85f645717.vercel.app");
    expect(publicUrl(["shop-3fa85f645717-acme.vercel.app"], "shop-x.vercel.app", "shop-3fa85f645717")).toBe("https://shop-3fa85f645717-acme.vercel.app");
    expect(publicUrl([], "shop-x.vercel.app", "shop")).toBe("https://shop-x.vercel.app");
  });

  it("fingerprints exactly what's published (order-independent, content-sensitive)", async () => {
    const a = await siteFingerprint([{ path: "a", content: "1" }, { path: "b", content: "2" }]);
    expect(await siteFingerprint([{ path: "b", content: "2" }, { path: "a", content: "1" }])).toBe(a);
    expect(await siteFingerprint([{ path: "a", content: "1" }, { path: "b", content: "3" }])).not.toBe(a);
    expect(await siteFingerprint([{ path: "a", content: "1b" }, { path: "", content: "2" }])).not.toBe(a);
  });

  it("is a high-risk Bastion operation", () => {
    expect(OPERATIONS["site.publish"]).toMatchObject({ risk: "high", capability: "exports" });
  });
});

describe("the hosting client", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("is off without a token, and won't send the token anywhere but Vercel (or a loopback test host)", () => {
    delete process.env.ORBIS_PUBLISH_VERCEL_TOKEN;
    expect(publishConfig()).toBeNull();
    process.env.ORBIS_PUBLISH_VERCEL_TOKEN = "tok";
    expect(publishConfig()).toEqual({ token: "tok", teamId: null, api: "https://api.vercel.com" });
    process.env.ORBIS_PUBLISH_VERCEL_API = "https://evil.example";
    expect(publishConfig()).toBeNull();
    process.env.ORBIS_PUBLISH_VERCEL_API = "http://127.0.0.1:4100";
    process.env.ORBIS_PUBLISH_VERCEL_TEAM_ID = "team_1";
    expect(publishConfig()).toMatchObject({ api: "http://127.0.0.1:4100", teamId: "team_1" });
  });

  type Call = { method: string; url: URL; headers: Headers; body: unknown };
  function fake(handler: (c: Call) => { status?: number; json?: unknown }) {
    const calls: Call[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString() : typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const c = { method: init?.method ?? "GET", url: new URL(String(input)), headers: new Headers(init?.headers), body };
      calls.push(c);
      const r = handler(c);
      return new Response(r.status === 204 ? null : JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { f, calls };
  }
  const cfg = { token: "secret-token", teamId: "team_abc", api: "https://api.vercel.com" };

  it("uploads each file by its SHA-1, then deploys exactly those files to production", async () => {
    const { f, calls } = fake((c) => (c.url.pathname === "/v13/deployments" ? { json: { id: "dpl_1", url: "s-1.vercel.app", readyState: "QUEUED", projectId: "prj_1" } } : { json: {} }));
    const host = new VercelHost(cfg, f);
    const files = await host.upload([{ path: "index.html", content: "<h1>Hi</h1>" }, { path: "style.css", content: "h1{}" }]);
    const sha = createHash("sha1").update("<h1>Hi</h1>").digest("hex");
    expect(files[0]).toEqual({ file: "index.html", sha, size: 11 });
    const up = calls.filter((c) => c.url.pathname === "/v2/files");
    expect(up).toHaveLength(2);
    expect(up[0].headers.get("x-vercel-digest")).toBe(sha);
    expect(up[0].headers.get("authorization")).toBe("Bearer secret-token");
    expect(up[0].url.searchParams.get("teamId")).toBe("team_abc");
    const d = await host.deploy({ id: "prj_1", name: "s-1" }, files, { orbisProject: ID, orbisFingerprint: "f" }, null, null);
    const call = calls.at(-1)!;
    expect(call.url.searchParams.get("skipAutoDetectionConfirmation")).toBe("1");
    expect(call.body).toMatchObject({ name: "s-1", project: "prj_1", target: "production", files, meta: { orbisProject: ID }, projectSettings: { framework: null } });
    expect(d).toMatchObject({ id: "dpl_1", readyState: "QUEUED", projectId: "prj_1" });
  });

  it("creates new sites public (no Vercel login in front of them) and finds them again by key", async () => {
    const { f, calls } = fake((c) =>
      c.method === "POST" ? { json: { id: "prj_9", name: "shop-3fa85f645717" } } : { json: { projects: [{ id: "prj_x", name: "other-3fa85f645717x" }, { id: "prj_9", name: "shop-3fa85f645717" }] } },
    );
    const host = new VercelHost(cfg, f);
    await host.createProject("shop-3fa85f645717", null, null);
    expect(calls[0].body).toMatchObject({ name: "shop-3fa85f645717", ssoProtection: null });
    expect(await host.findProject("3fa85f645717")).toEqual({ id: "prj_9", name: "shop-3fa85f645717" });
    expect(calls[1].url.searchParams.get("search")).toBe("3fa85f645717");
  });

  it("turns refusals into plain messages without leaking the token, and retries server errors", async () => {
    let n = 0;
    const flaky = fake(() => (++n < 2 ? { status: 502, json: { error: { message: "bad gateway" } } } : { json: { id: "dpl_2", readyState: "READY" } }));
    expect(await new VercelHost(cfg, flaky.f).deployment("dpl_2")).toMatchObject({ readyState: "READY" });
    expect(n).toBe(2);
    const denied = fake(() => ({ status: 403, json: { error: { code: "forbidden", message: "Not authorized: token secret-token has no access to this team" } } }));
    const err = await new VercelHost(cfg, denied.f).findProject("k").catch((e) => e);
    expect(err.code).toBe("not_configured");
    // Vercel's reason is shown (so the admin can tell a bad token from a wrong team), the token never is.
    expect(String(err.message)).toContain("Vercel: forbidden: Not authorized");
    expect(String(err.message)).not.toContain("secret-token");
    const limited = fake(() => ({ status: 429, json: { error: { message: "Too many deployments" } } }));
    expect((await new VercelHost(cfg, limited.f).findProject("k").catch((e) => e)).code).toBe("provider_unavailable");
    const missing = fake(() => ({ status: 404 }));
    expect(await new VercelHost(cfg, missing.f).deployment("dpl_x")).toBeNull();
  });

  it("checks the live address from outside, waiting out a brief 404 while the domain settles", async () => {
    let n = 0;
    const f = (async () => new Response("<html>", { status: ++n < 2 ? 404 : 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    expect(await checkReachable("https://x.vercel.app/", f)).toMatchObject({ ok: true, status: 200 });
    const down = (async () => new Response("no", { status: 500 })) as typeof fetch;
    expect(await checkReachable("https://x.vercel.app/", down)).toMatchObject({ ok: false, status: 500 });
  });
});
