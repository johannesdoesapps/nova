import { describe, expect, it } from "vitest";
import { classifyCommand } from "@/lib/code/agent/policy";
import { TOOL_DEFS } from "@/lib/code/agent/tool-specs";
import { PREVIEW_PATH } from "@/lib/code/projects";
import { htmlToText, stripComments, stripElements } from "@/lib/connectors/http";
import { readablePage } from "@/lib/links/parse";
import { findSecrets, redactAll } from "@/lib/secrets";
import { interleave } from "@/lib/security/schedules";

/** Regression tests for the defects fixed in the 26 October 2026 audit (docs/audits/orbis-deep-audit.md). */

describe("ORB-003: the browser check's page path can't carry shell syntax", () => {
  it("accepts ordinary page paths and refuses substitutions, quotes and spaces", () => {
    for (const p of ["/", "/about.html", "/blog/post-1?x=1&y=2", "/a/b#top", "/%E2%9C%93"]) expect(PREVIEW_PATH.test(p), p).toBe(true);
    for (const p of ["/$(id)", "/`id`", "/${IFS}", "/a'b", '/a"b', "/a b", "/a;rm", "/a|b", "/a\\b", "about"]) expect(PREVIEW_PATH.test(p), p).toBe(false);
  });

  it("is enforced by the tool's own input schema", () => {
    const schema = TOOL_DEFS.check_preview.schema;
    expect(schema.safeParse({ path: "/$(rm${IFS}-rf${IFS}src)" }).success).toBe(false);
    expect(schema.safeParse({ path: "/pricing" }).success).toBe(true);
  });
});

describe("ORB-004: commands that hide another command or write files directly need approval", () => {
  it("doesn't run env-wrapped commands, nested shells or inline scripts on its own", () => {
    for (const c of ["env bash -c 'rm -rf src'", "env node -e 1", "env FOO=1 sh -c x", "sh -c 'x'", "npm test && bash -c x", "node -e 'require(1)'", "python3 -c 'print(1)'"]) {
      expect(classifyCommand(c), c).toMatchObject({ kind: "ask" });
    }
    expect(classifyCommand("env")).toMatchObject({ kind: "allow" });
  });

  it("asks before redirects and output flags write into the project", () => {
    for (const c of ["echo x > .github/workflows/ci.yml", "cat a >> src/app.ts", "git diff --output=src/app.ts", "git log --output x"]) {
      expect(classifyCommand(c), c).toMatchObject({ kind: "ask" });
    }
    for (const c of ["ls -la", "git diff", "git log --grep push", "npm test"]) expect(classifyCommand(c), c).toMatchObject({ kind: "allow" });
  });

  it("still blocks split rm flags and git push behind options", () => {
    for (const c of ["rm -r -f .", "rm -f -r /", "rm -r -v -f ~", "git -C . push", "git --git-dir=.git push origin main"]) expect(classifyCommand(c), c).toMatchObject({ kind: "block" });
    expect(classifyCommand("git commit -m 'push fix'")).not.toMatchObject({ kind: "block" });
  });
});

describe("ORB-005: credentials inside longer variable names are redacted", () => {
  it("catches DB_PASSWORD=, JWT_SECRET=, OPENAI_API_KEY=, SESSION_SECRET:", () => {
    for (const t of ["DB_PASSWORD=hunter2222", "JWT_SECRET=abcdefgh123", "OPENAI_API_KEY=xyz1234567", "SESSION_SECRET: abcdefghi", "STRIPE_SECRET_KEY=whatever123"]) {
      expect(redactAll(t), t).not.toMatch(/hunter|abcdefgh|xyz123|whatever/);
      expect(findSecrets(t), t).toContain("password or key value");
    }
  });

  it("leaves ordinary prose alone", () => {
    for (const t of ["secretary: someone", "Passwords must be at least 12 characters", "my api key is great"]) expect(findSecrets(t), t).toEqual([]);
  });
});

describe("ORB-009: reading hostile HTML takes linear time", () => {
  it("handles 2 MB of unclosed tags, comments and attributes quickly", () => {
    for (const unit of ["<main>x", "<nav>x", "<script>x", "<!--x", "<title>x", "<article>x<nav>", "<x", "<meta name=a "]) {
      const body = unit.repeat(Math.ceil(2_000_000 / unit.length));
      const t = performance.now();
      readablePage(body, "text/html");
      htmlToText(body);
      expect(performance.now() - t, unit).toBeLessThan(1500);
    }
  });

  it("still reads normal pages the same way", () => {
    const p = readablePage(
      '<html><head><title>Hi &amp; bye</title><meta name="description" content="A page about things"></head><body><nav>menu</nav><main><h1>Head</h1><p>' +
        "word ".repeat(200) +
        "</p><!-- c --><form>f</form></main><footer>foot</footer></body></html>",
      "text/html",
    );
    expect(p.title).toBe("Hi & bye");
    expect(p.text.startsWith("A page about things\n\nHead")).toBe(true);
    expect(p.text).not.toMatch(/menu|foot| f /);
    expect(stripElements("a<nav class=x>b</nav>c<nav>d", ["nav"])).toBe("a c<nav>d");
    expect(stripComments("a<!-- b -->c<!-- d")).toBe("a c ");
  });
});

describe("ORB-012: scheduled audits are taken one person at a time", () => {
  it("interleaves the due lists", () => {
    expect(interleave([["a1", "a2", "a3", "a4"], ["b1"], ["c1", "c2"]])).toEqual(["a1", "b1", "c1", "a2", "c2", "a3", "a4"]);
    expect(interleave<string>([])).toEqual([]);
  });
});

describe("ORB-022: a backslash in a page path redirects instead of failing", () => {
  it("redirects pages and 404s API paths", async () => {
    const { backslashRedirect } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const r = backslashRedirect(new NextRequest("https://tryorbis.app/pricing%5C?plan=pro"));
    expect(r?.status).toBe(308);
    expect(r?.headers.get("location")).toBe("https://tryorbis.app/pricing?plan=pro");
    expect(backslashRedirect(new NextRequest("https://tryorbis.app/api/models%5C"))?.status).toBe(404);
    expect(backslashRedirect(new NextRequest("https://tryorbis.app/pricing"))).toBeNull();
  });
});

describe("ORB-006/007/008: Slack messages are posted once and the card shows where", () => {
  it("doesn't retry chat.postMessage after a network failure, but retries reads", async () => {
    const { slackApi } = await import("@/lib/connectors/providers/slack");
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url).split("/").pop()!);
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(slackApi("chat.postMessage", { token: "t", signal: undefined }, { channel: "C1234567", text: "hi" }, f)).rejects.toThrow();
    expect(calls.filter((c) => c === "chat.postMessage")).toHaveLength(1);
    await expect(slackApi("search.messages", { token: "t", signal: undefined }, { query: "x" }, f)).rejects.toThrow();
    expect(calls.filter((c) => c === "search.messages").length).toBeGreaterThan(1);
  }, 10_000);

  it("shows the channel id, and labels the name as unchecked", async () => {
    const { slack } = await import("@/lib/connectors/providers/slack");
    const post = slack.actions!.find((a) => a.name === "slack_post_message")!;
    expect(post.fields!.map((f) => f.key)).toContain("channel");
    const d = post.describe!({ channel: "D0ATTACKER", channelName: "team-updates", text: "x" } as never);
    expect(d).toContain("D0ATTACKER");
  });

  it("a confirmed proposal can't run twice", async () => {
    const { actionInProgressOrDone, ACTION_RUNNING_MS } = await import("@/lib/connectors/router");
    const now = Date.parse("2026-10-26T10:00:00Z");
    expect(actionInProgressOrDone({ status: "done" }, now)).toBe(true);
    expect(actionInProgressOrDone({ status: "proposed", startedAt: new Date(now - 1000).toISOString() }, now)).toBe(true);
    expect(actionInProgressOrDone({ status: "proposed", startedAt: new Date(now - ACTION_RUNNING_MS - 1).toISOString() }, now)).toBe(false);
    expect(actionInProgressOrDone({ status: "failed" }, now)).toBe(false);
    expect(actionInProgressOrDone({ status: "proposed" }, now)).toBe(false);
  });
});

describe("ORB-011: website ownership needs the exact token Orbis issued", () => {
  it("matches the token on its own line or as the whole record, never inside other text", async () => {
    const { publishesToken, TOKEN_FORMAT } = await import("@/lib/security/authz");
    const tok = "orbis-verify-0123456789abcdef0123456789abcdef";
    expect(TOKEN_FORMAT.test(tok)).toBe(true);
    expect(publishesToken(`${tok}\n`, tok)).toBe(true);
    expect(publishesToken(`"${tok}"`, tok)).toBe(true);
    expect(publishesToken(`other\n  ${tok}  \nmore`, tok)).toBe(true);
    expect(publishesToken(`prefix ${tok} suffix`, tok)).toBe(false);
    // A rewritten token that some existing record happens to contain proves nothing.
    expect(publishesToken("v=spf1 include:_spf.google.com ~all", "v=spf1 include:_spf.google.com")).toBe(false);
    expect(publishesToken("<!DOCTYPE html><html>", "<!DOCTYPE html><html")).toBe(false);
  });
});
