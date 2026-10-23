/**
 * Navigation: one Chat entry and one Code entry, from one shared list, in
 * every sidebar variant (expanded, collapsed rail, phone drawer — the same
 * component — for visitors, members and administrators), and paths map to
 * the right active entry. The sidebar is rendered to HTML with Next's router
 * mocked.
 */
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let pathname = "/chat";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }), usePathname: () => pathname }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => createElement("a", { href, ...rest }, children as never) }));

const { MODES, NAV_ENTRIES, modeFor, navFor, sectionFor, sidebarFor } = await import("@/components/studio/nav");
const { ModeSwitch, rememberPlace } = await import("@/components/studio/mode-switch");
const { Sidebar } = await import("@/components/studio/sidebar");

type Props = Parameters<typeof Sidebar>[0];
const user = (isAdmin: boolean) => ({ id: "u1", email: "a@example.com", displayName: "A", isAdmin }) as unknown as Props["user"];

function render(over: Partial<Props> = {}): string {
  const props: Props = {
    collapsed: false,
    onToggleCollapsed: () => {},
    mobileOpen: false,
    onCloseMobile: () => {},
    section: "chat",
    conversations: [],
    listError: null,
    activeId: null,
    onNewChat: () => {},
    onRename: async () => {},
    onRequestDelete: () => {},
    onOpenPrompts: () => {},
    onOpenSettings: () => {},
    user: user(false),
    accountsEnabled: true,
    historyKind: "server",
    theme: { pref: "system", setTheme: () => {} },
    searchRef: createRef<HTMLInputElement>(),
    ...over,
  };
  return renderToStaticMarkup(createElement(Sidebar, props));
}

const links = (html: string, href: string) => (html.match(new RegExp(`href="${href.replace(/[?]/g, "\\?")}"`, "g")) ?? []).length;
const navHtml = (html: string) => html.slice(html.indexOf('aria-label="Main"'), html.indexOf("</nav>"));

describe("the shared navigation list", () => {
  it("has each destination, label and icon once, with Chat and Code as the two modes", () => {
    for (const key of ["id", "href", "label"] as const) expect(new Set(NAV_ENTRIES.map((e) => e[key])).size).toBe(NAV_ENTRIES.length);
    expect(NAV_ENTRIES.filter((e) => e.label === "Chat")).toHaveLength(1);
    expect(NAV_ENTRIES.filter((e) => e.label === "Code")).toHaveLength(1);
    expect(NAV_ENTRIES.find((e) => e.id === "chat")!.href).toBe("/chat");
    expect(NAV_ENTRIES.find((e) => e.id === "code")!.href).toBe("/code");
    expect(MODES.map((m) => m.id)).toEqual(["chat", "code"]);
    expect(sidebarFor(true).map((e) => e.id)).not.toEqual(expect.arrayContaining(["chat"]));
    expect(sidebarFor(true).some((e) => e.id === "chat" || e.id === "code")).toBe(false);
    // The command palette still lists both.
    expect(navFor(false).map((e) => e.id)).toEqual(expect.arrayContaining(["chat", "code"]));
  });

  it("knows which mode each page is in", () => {
    expect(modeFor("/chat")).toBe("chat");
    expect(modeFor("/home")).toBe("chat");
    expect(modeFor("/history")).toBe("chat");
    expect(modeFor("/code")).toBe("code");
    expect(modeFor("/code/0f8e2b1c-1111-4111-8111-111111111111")).toBe("code");
    expect(modeFor("/missions")).toBeNull();
    expect(modeFor("/council")).toBeNull();
    expect(modeFor("/projects")).toBeNull();
  });

  it("shows admin pages to administrators only", () => {
    expect(navFor(false).map((e) => e.id)).not.toContain("admin");
    expect(navFor(true).map((e) => e.id)).toEqual(expect.arrayContaining(["admin", "workforce"]));
  });

  it("marks the right entry active for each path", () => {
    expect(sectionFor("/chat")).toBe("chat");
    expect(sectionFor("/code")).toBe("code");
    expect(sectionFor("/code/0f8e2b1c-1111-4111-8111-111111111111")).toBe("code");
    expect(sectionFor("/agents/security/runs/x")).toBe("agents");
    expect(sectionFor("/missions/42")).toBe("missions");
    // "/council" mustn't match "/code", and unknown pages fall back to Chat.
    expect(sectionFor("/council")).toBe("council");
    expect(sectionFor("/settings")).toBe("chat");
    expect(sectionFor("/codex")).toBe("chat");
    expect(sectionFor("/home")).toBe("home");
    expect(sectionFor("/projects")).toBe("projects");
    expect(sectionFor("/discover")).toBe("discover");
    // The full conversation list belongs with Chat.
    expect(sectionFor("/history")).toBe("chat");
  });

  it("starts with Home and lists Projects and Discover once", () => {
    expect(NAV_ENTRIES[0]).toMatchObject({ id: "home", href: "/home", group: "main" });
    for (const label of ["Home", "Projects", "Discover"]) expect(NAV_ENTRIES.filter((e) => e.label === label)).toHaveLength(1);
  });
});

describe("the sidebar", () => {
  const variants: [string, Partial<Props>][] = [
    ["expanded, in Chat", {}],
    ["expanded, in Code", { section: "code" }],
    ["collapsed rail", { collapsed: true }],
    ["phone drawer open", { mobileOpen: true }],
    ["administrator", { user: user(true) }],
    ["visitor", { user: null, historyKind: "local" }],
  ];

  it.each(variants)("has no Chat or Code entry: they're in the top bar's switch (%s)", (_, over) => {
    if (over.section === "code") pathname = "/code";
    const html = render(over);
    pathname = "/chat";
    expect(links(html, "/chat")).toBe(0);
    expect(links(html, "/code")).toBe(0);
    const nav = navHtml(html);
    expect(nav).not.toMatch(/>Chat</);
    expect(nav).not.toMatch(/>Code</);
    expect(nav).toContain(">Home<");
    // The old Chat | Code switch inside the sidebar is gone too.
    expect(html).not.toContain('aria-label="Mode"');
  });

  it("marks the current destination with aria-current", () => {
    const projects = render({ section: "projects" });
    expect(projects).toMatch(/href="\/projects"[^>]*aria-current="page"/);
    expect(projects).not.toMatch(/href="\/home"[^>]*aria-current="page"/);
  });

  it("is about chats in Chat and about projects in Code", () => {
    const chat = render({ section: "chat" });
    expect(chat).toContain("New chat");
    expect(chat).toContain('aria-label="Search chats"');
    const code = render({ section: "code" });
    expect(code).toContain("New project");
    expect(code).not.toContain("New chat");
    expect(code).not.toContain('aria-label="Search chats"');
  });

  it("labels its loading placeholders as status regions (an aria-label needs a role)", () => {
    expect(render({ conversations: null })).toMatch(/role="status" aria-label="Loading chats"/);
  });

  it("takes the logo home and links to every conversation", () => {
    const html = render({ conversations: [{ id: "c1", title: "Trip", mode: "research", updated_at: new Date().toISOString() }] });
    expect(html).toMatch(/href="\/home"[^>]*aria-label="Orbis — home"/);
    expect(links(html, "/home")).toBe(2);
    expect(html).toContain('href="/history"');
    // Guests' chats are only in this browser: no server-wide list.
    expect(render({ user: null, historyKind: "local", conversations: [{ id: "c1", title: "Trip", mode: "research", updated_at: new Date().toISOString() }] })).not.toContain('href="/history"');
  });

  it("shows the admin group only to administrators", () => {
    expect(render({ user: user(true) })).toContain('href="/admin"');
    expect(render({ user: user(false) })).not.toContain('href="/admin"');
  });
});

describe("the command palette's search", () => {
  it("puts a matching name before a match in a description", async () => {
    const { rankCommands } = await import("@/components/studio/command-palette");
    const nav = NAV_ENTRIES.map((e) => ({ label: e.label, group: "Go to", hint: e.hint }));
    const list = [{ label: "New mission", group: "Actions", keywords: "plan goal" }, ...nav, { label: "Launch newsletter", group: "Missions", keywords: "mission project" }];
    expect(rankCommands(list, "missions")[0]!.label).toBe("Missions");
    expect(rankCommands(list, "proj")[0]!.label).toBe("Projects");
    expect(rankCommands(list, "chat")[0]!.label).toBe("Chat");
    // Groups stay together.
    const groups = rankCommands(list, "mission").map((c) => c.group);
    expect(groups).toEqual([...groups].sort((a, b) => groups.indexOf(a) - groups.indexOf(b)));
    expect(rankCommands(list, "zzz")).toEqual([]);
  });
});

describe("the Chat / Code switch", () => {
  const html = (path: string) => {
    pathname = path;
    const out = renderToStaticMarkup(createElement(ModeSwitch));
    pathname = "/chat";
    return out;
  };

  it("has two labelled links and marks the current mode", () => {
    const chat = html("/chat");
    expect(chat).toContain('aria-label="Mode"');
    expect(chat).toMatch(/href="\/chat"[^>]*aria-label="Chat"[^>]*aria-current="page"[^>]*title="Chat"/);
    expect(chat).toMatch(/href="\/code"[^>]*aria-label="Code"/);
    expect(chat).not.toMatch(/aria-label="Code"[^>]*aria-current/);
    expect(html("/code/abc")).toMatch(/aria-label="Code"[^>]*aria-current="page"/);
    const other = html("/missions");
    expect(other).not.toContain("aria-current");
  });

  it("remembers the open conversation and project so switching back returns there", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    rememberPlace("/chat", new URLSearchParams("c=abc"));
    rememberPlace("/code/p1", new URLSearchParams());
    expect(store.get("orbis:last-chat")).toBe("/chat?c=abc");
    expect(store.get("orbis:last-code")).toBe("/code/p1");
    // A conversation continued on the home reopens in Chat; the home itself isn't a place to return to.
    rememberPlace("/home", new URLSearchParams("c=xyz"));
    expect(store.get("orbis:last-chat")).toBe("/chat?c=xyz");
    rememberPlace("/home", new URLSearchParams());
    expect(store.get("orbis:last-chat")).toBe("/chat?c=xyz");
    rememberPlace("/missions", new URLSearchParams());
    expect(store.get("orbis:last-code")).toBe("/code/p1");
    vi.unstubAllGlobals();
  });
});

describe("the redesigned sidebar", () => {
  it("is Home, Agents, Projects, Templates, then Tools; Missions lives under Projects", () => {
    expect(
      sidebarFor(false)
        .filter((e) => e.group === "main")
        .map((e) => e.id),
    ).toEqual(["home", "agents", "projects", "templates"]);
    expect(
      sidebarFor(false)
        .filter((e) => e.group === "tools")
        .map((e) => e.id),
    ).toEqual(["discover", "council", "arena", "images", "verify", "connectors"]);
    expect(sidebarFor(true).some((e) => e.id === "missions")).toBe(false);
    // Still one command-palette destination.
    expect(navFor(false).filter((e) => e.id === "missions")).toHaveLength(1);
  });

  it("shows Projects as current on a mission page, and a Tools toggle", () => {
    const html = render({ section: "missions" });
    expect(html).toMatch(/href="\/projects"[^>]*aria-current="page"/);
    expect(links(html, "/missions")).toBe(0);
    expect(navHtml(html)).toMatch(/>Tools</);
    expect(navHtml(html)).not.toMatch(/>More</);
  });
});
