import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { keptPrivate, localReferences, planSite, publicUrl, siteFingerprint, siteKey, siteProjectName } from "@/lib/publish/site";
import { siteHost } from "@/lib/publish/sites";
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
    expect(publishConfig()).toEqual({ token: "tok", teamId: null, api: "https://api.vercel.com", sharedProject: null });
    process.env.ORBIS_PUBLISH_VERCEL_PROJECT = "orbis-sites";
    expect(publishConfig()?.sharedProject).toBe("orbis-sites");
    process.env.ORBIS_PUBLISH_VERCEL_PROJECT = "../v2/aliases";
    expect(publishConfig()).toBeNull();
    delete process.env.ORBIS_PUBLISH_VERCEL_PROJECT;
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
  const cfg = { token: "secret-token", teamId: "team_abc", api: "https://api.vercel.com", sharedProject: null };

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

  it("never follows the site's redirects (they could point inside a network); a redirect counts as answering", async () => {
    const seen: RequestInit[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response(null, { status: 307, headers: { location: "http://10.0.0.5:8080/admin" } });
    }) as unknown as typeof fetch;
    expect(await checkReachable("https://x.vercel.app/", f)).toMatchObject({ ok: true, status: 307 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe("manual");
  });

  describe("shared mode (every site is a deployment in one existing project)", () => {
    type D = { id: string; projectId: string; readyState: string; createdAt: number; meta: Record<string, string>; url: string };
    function sharedApi(envs = 0) {
      const st = { deployments: [] as D[], aliases: new Map<string, string>(), patched: [] as unknown[], deleted: [] as string[], n: 0 };
      const api = fake((c) => {
        const p = c.url.pathname;
        if (p === "/v9/projects/orbis-sites" && c.method === "GET") return { json: { id: "prj_s", name: "orbis-sites" } };
        if (p === "/v9/projects/prj_s/env" && c.method === "GET") return { json: { envs: Array.from({ length: envs }, (_, i) => ({ key: `K${i}` })) } };
        if (p.startsWith("/v9/projects/") && c.method === "GET") return { status: 404 };
        if (p === "/v9/projects/prj_s" && c.method === "PATCH") return st.patched.push(c.body), { json: {} };
        if (p === "/v13/deployments" && c.method === "POST") {
          const b = c.body as { project: string; meta: Record<string, string> };
          const d = { id: `dpl_${++st.n}`, projectId: b.project, readyState: "QUEUED", createdAt: st.n * 1000, meta: b.meta, url: `orbis-sites-${st.n}.vercel.app` };
          st.deployments.push(d);
          return { json: d };
        }
        if (p === "/v6/deployments") {
          const want = c.url.searchParams.get("meta-orbisProject");
          // Like Vercel's list, without projectId on each item.
          return { json: { deployments: st.deployments.filter((d) => d.meta.orbisProject === want).reverse().map((d) => ({ ...d, projectId: undefined, uid: d.id })) } };
        }
        const dm = p.match(/^\/v13\/deployments\/(\w+)$/);
        if (dm && c.method === "GET") return st.deployments.find((d) => d.id === dm[1]) ? { json: st.deployments.find((d) => d.id === dm[1]) } : { status: 404 };
        if (dm && c.method === "DELETE") return st.deleted.push(dm[1]), { status: 204 };
        const am = p.match(/^\/v4\/aliases\/(.+)$/);
        if (am) return st.aliases.has(am[1]) ? { json: { alias: am[1], deploymentId: st.aliases.get(am[1]), projectId: "prj_s" } } : { status: 404 };
        const aa = p.match(/^\/v2\/deployments\/(\w+)\/aliases$/);
        if (aa) {
          const alias = (c.body as { alias: string }).alias;
          if (alias.startsWith("taken-")) return { status: 409, json: { error: { code: "alias_in_use", message: "The alias is already in use" } } };
          return st.aliases.set(alias, aa[1]), { json: { alias, uid: "als_1" } };
        }
        if (p.startsWith("/v2/aliases/") && c.method === "DELETE") return st.aliases.delete(decodeURIComponent(p.slice(12))), { status: 204 };
        return { status: 404 };
      });
      const shared = { ...cfg, sharedProject: "orbis-sites" };
      const site = (id = ID) => siteHost(new VercelHost(shared, api.f), shared, id);
      return { st, api, site };
    }
    const plan = planSite([{ path: "index.html", content: "<h1>Hi</h1>" }]);
    const up = [{ file: "index.html", sha: "a".repeat(40), size: 11 }];

    it("refuses a shared project that has environment variables (every site's build could read them)", async () => {
      const { st, api, site } = sharedApi(2);
      await expect(site().publish("Shop", plan, up, "fp1")).rejects.toMatchObject({ code: "not_configured" });
      expect(st.deployments).toHaveLength(0);
      expect(st.patched).toEqual([]);
      expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    });

    it("never creates a project: deploys into the shared one with every build setting given, and asks for it to stay public", async () => {
      const { st, api, site } = sharedApi();
      const d = await site().publish("Shop", plan, up, "fp1");
      expect(api.calls.some((c) => c.method === "POST" && c.url.pathname.includes("/projects"))).toBe(false);
      expect(st.patched).toEqual([{ ssoProtection: null }]);
      const body = api.calls.find((c) => c.url.pathname === "/v13/deployments")!.body as Record<string, unknown>;
      expect(body).toMatchObject({ project: "prj_s", name: "orbis-sites", meta: { orbisProject: ID, orbisFingerprint: "fp1", orbisAlias: "shop-3fa85f645717.vercel.app" } });
      expect(body.target).toBeUndefined();
      expect(body.projectSettings).toEqual({ framework: null, buildCommand: null, installCommand: null, outputDirectory: null, devCommand: null });
      expect(d.id).toBe("dpl_1");
    });

    it("points the address at a built deployment, and only reports this project's deployments", async () => {
      const { st, site } = sharedApi();
      const d = await site().publish("Shop", plan, up, "fp1");
      const other = await site("11111111-2222-3333-4444-555555555555").publish("Other", plan, up, "fp9");
      expect(await site().deployment(other.id)).toBeNull();
      st.deployments[0].readyState = "READY";
      const mine = (await site().deployment(d.id))!;
      expect(await site().address(mine)).toEqual({ url: "https://shop-3fa85f645717.vercel.app", assigned: true });
      expect(st.aliases.get("shop-3fa85f645717.vercel.app")).toBe(d.id);
      // A deployment claiming an address that isn't this project's is refused.
      st.deployments.push({ ...st.deployments[0], id: "dpl_evil", meta: { orbisProject: ID, orbisAlias: "tryorbis.vercel.app" } });
      expect(await site().deployment("dpl_evil")).toBeNull();
      const status = await site().status();
      expect(status.live).toMatchObject({ url: "https://shop-3fa85f645717.vercel.app", deployment: { id: d.id } });
    });

    it("keeps the address after a rename, never moves it back to an older version, and shows a publish in progress", async () => {
      const { st, site } = sharedApi();
      const v1 = await site().publish("Shop", plan, up, "fp1");
      st.deployments[0].readyState = "READY";
      const v2 = await site().publish("Renamed shop", plan, up, "fp2");
      expect(v2.meta.orbisAlias).toBe("shop-3fa85f645717.vercel.app");
      st.deployments[1].readyState = "READY";
      await site().address((await site().deployment(v2.id))!);
      await site().address((await site().deployment(v1.id))!);
      expect(st.aliases.get("shop-3fa85f645717.vercel.app")).toBe(v2.id);
      const v3 = await site().publish("Renamed shop", plan, up, "fp3");
      const s = await site().status();
      expect(s.live?.deployment.id).toBe(v2.id);
      expect(s.pending?.id).toBe(v3.id);
    });

    it("takes the site down by removing its address and deployments", async () => {
      const { st, site } = sharedApi();
      expect(await site().remove()).toBe(false);
      const d = await site().publish("Shop", plan, up, "fp1");
      st.deployments[0].readyState = "READY";
      await site().address((await site().deployment(d.id))!);
      expect(await site().remove()).toBe(true);
      expect(st.aliases.size).toBe(0);
      expect(st.deleted).toEqual([d.id]);
    });

    it("explains a missing shared project and an address someone else owns", async () => {
      const { api } = sharedApi();
      const wrong = { ...cfg, sharedProject: "no-such-project" };
      const err = await siteHost(new VercelHost(wrong, api.f), wrong, ID).status().catch((e) => e);
      expect(err.code).toBe("not_configured");
      expect(String(err.message)).toContain('"no-such-project"');
      const { st, site } = sharedApi();
      const d = await site().publish("Taken", plan, up, "fp1");
      st.deployments[0].readyState = "READY";
      const e2 = await site().address((await site().deployment(d.id))!).catch((e) => e);
      expect(e2.code).toBe("conflict");
      expect(String(e2.message)).toContain("taken-3fa85f645717.vercel.app");
    });
  });
});
