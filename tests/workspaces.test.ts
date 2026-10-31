import { describe, expect, it } from "vitest";
import { analyzeUrl, passwordStrength, seoChecks } from "@/lib/workspaces/analyze";
import { CATALOGS, findTool, findWorkspaceTemplate, isWorkspaceKey, WORKSPACES, type WorkspaceKey } from "@/lib/workspaces/catalog";
import { findPrompt } from "@/lib/workspaces/prompts";
import { builtinAgents, workspaceAgents } from "@/lib/agents/builtins";
import { CYBER_AGENT_IDS, WEB_AGENT_IDS } from "@/lib/agents/types";

// The panels the tool-runner handles without a prompt (special client components).
const SPECIAL: Record<WorkspaceKey, Set<string>> = {
  cyber: new Set(["password-check"]),
  web: new Set(["builder", "generate", "landing", "store", "blog", "redesign"]),
};

describe("passwordStrength", () => {
  it("scores an empty password as very weak", () => {
    const r = passwordStrength("");
    expect(r.score).toBe(0);
    expect(r.entropyBits).toBe(0);
  });

  it("caps common passwords regardless of length", () => {
    const r = passwordStrength("password");
    expect(r.score).toBe(0);
    expect(r.suggestions.some((s) => /common/i.test(s))).toBe(true);
  });

  it("rewards a long mixed passphrase", () => {
    const r = passwordStrength("Tr0ub4dour&3xplore-Mountain!");
    expect(r.score).toBe(4);
    expect(r.entropyBits).toBeGreaterThan(80);
  });

  it("penalises repeated characters", () => {
    expect(passwordStrength("aaaaaaaaaaaa").score).toBeLessThanOrEqual(1);
  });
});

describe("analyzeUrl", () => {
  it("rejects an invalid URL", () => {
    const r = analyzeUrl("not a url");
    expect(r.ok).toBe(false);
    expect(r.host).toBeNull();
  });

  it("flags a raw-IP, embedded-credential, non-HTTPS link as high risk", () => {
    const r = analyzeUrl("http://user:pass@203.0.113.9/login");
    expect(r.ok).toBe(true);
    expect(r.risk).toBeGreaterThanOrEqual(60);
    expect(r.signals.some((s) => s.level === "danger")).toBe(true);
  });

  it("treats a plain HTTPS domain as low risk", () => {
    const r = analyzeUrl("https://example.com/about");
    expect(r.host).toBe("example.com");
    expect(r.risk).toBeLessThan(20);
  });

  it("caps risk at 100", () => {
    const r = analyzeUrl("http://user:pass@xn--80ak6aa92e.com/verify/secure/account/login/update.exe");
    expect(r.risk).toBeLessThanOrEqual(100);
  });
});

describe("seoChecks", () => {
  it("fails a bare document", () => {
    const { checks, score } = seoChecks("<html><body><p>hi</p></body></html>");
    expect(score).toBeLessThan(50);
    expect(checks.find((c) => c.id === "title")?.status).toBe("fail");
    expect(checks.find((c) => c.id === "h1")?.status).toBe("fail");
  });

  it("passes a well-formed page", () => {
    const html = `<html><head><title>A clear descriptive page title</title>
      <meta name="description" content="${"x".repeat(80)}">
      <meta name="viewport" content="width=device-width">
      <meta property="og:title" content="X"></head>
      <body><h1>One heading</h1><img src="a.png" alt="a"></body></html>`;
    const { score, checks } = seoChecks(html);
    expect(score).toBe(100);
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("warns on multiple H1s and missing alt text", () => {
    const { checks } = seoChecks("<h1>a</h1><h1>b</h1><img src=x>");
    expect(checks.find((c) => c.id === "h1")?.status).toBe("warn");
    expect(checks.find((c) => c.id === "alt")?.status).toBe("warn");
  });
});

describe("catalog wiring", () => {
  const keys: WorkspaceKey[] = ["cyber", "web"];

  it("exposes exactly the two workspaces", () => {
    expect(Object.keys(WORKSPACES).sort()).toEqual(["cyber", "web"]);
    expect(isWorkspaceKey("cyber")).toBe(true);
    expect(isWorkspaceKey("nope")).toBe(false);
  });

  for (const ws of keys) {
    it(`every ${ws} panel tool resolves to a handler or a prompt`, () => {
      for (const t of CATALOGS[ws].tools) {
        if (t.kind === "link") {
          expect(t.href, `${t.id} link needs href`).toBeTruthy();
          continue;
        }
        const handled = SPECIAL[ws].has(t.id) || !!findPrompt(ws, t.id);
        expect(handled, `${ws}/${t.id} has no panel handler or prompt`).toBe(true);
      }
    });

    it(`every ${ws} AI panel tool has a prompt (unless a special component)`, () => {
      for (const t of CATALOGS[ws].tools) {
        if (t.kind === "panel" && t.ai && !SPECIAL[ws].has(t.id)) {
          expect(findPrompt(ws, t.id), `${ws}/${t.id} marked ai but has no prompt`).toBeTruthy();
        }
      }
    });

    it(`every ${ws} saved-item kind passes the slug pattern used by the app and the DB`, () => {
      // workspace_items.kind must match ^[a-z][a-z0-9-]{1,48}$ (items.ts KIND_RE + the DB check).
      const SLUG = /^[a-z][a-z0-9-]{1,48}$/;
      for (const t of CATALOGS[ws].tools) expect(SLUG.test(t.id), `tool kind ${t.id}`).toBe(true);
      // Template results are stored with a "template-" prefix (not a colon, which the slug rejects).
      for (const t of CATALOGS[ws].templates) expect(SLUG.test(`template-${t.id}`), `template kind template-${t.id}`).toBe(true);
    });

    it(`every ${ws} tool and template id is unique and findable`, () => {
      const toolIds = CATALOGS[ws].tools.map((t) => t.id);
      expect(new Set(toolIds).size).toBe(toolIds.length);
      const tplIds = CATALOGS[ws].templates.map((t) => t.id);
      expect(new Set(tplIds).size).toBe(tplIds.length);
      for (const id of toolIds) expect(findTool(ws, id)).toBeTruthy();
      for (const id of tplIds) expect(findWorkspaceTemplate(ws, id)).toBeTruthy();
    });
  }
});

describe("workspace agents", () => {
  it("each workspace has 10 agents, all tagged to it", () => {
    const cyber = workspaceAgents("cyber");
    const web = workspaceAgents("web");
    expect(cyber).toHaveLength(10);
    expect(web).toHaveLength(10);
    expect(cyber.map((a) => a.id).sort()).toEqual([...CYBER_AGENT_IDS].sort());
    expect(web.map((a) => a.id).sort()).toEqual([...WEB_AGENT_IDS].sort());
    expect(cyber.every((a) => a.workspace === "cyber")).toBe(true);
    expect(web.every((a) => a.workspace === "web")).toBe(true);
  });

  it("keeps workspace agents out of the general /agents roster", () => {
    const ids = new Set(builtinAgents().map((a) => a.id));
    for (const id of [...CYBER_AGENT_IDS, ...WEB_AGENT_IDS]) expect(ids.has(id)).toBe(false);
    expect(builtinAgents().length).toBeGreaterThan(0);
  });

  it("gives every workspace agent a name and instructions", () => {
    for (const a of [...workspaceAgents("cyber"), ...workspaceAgents("web")]) {
      expect(a.name?.length ?? 0).toBeGreaterThan(0);
      expect(a.instructions?.length ?? 0).toBeGreaterThan(40);
    }
  });
});
