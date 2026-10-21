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

const { NAV_ENTRIES, navFor, sectionFor } = await import("@/components/studio/nav");
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
  it("has each destination, label and icon once", () => {
    for (const key of ["id", "href", "label"] as const) expect(new Set(NAV_ENTRIES.map((e) => e[key])).size).toBe(NAV_ENTRIES.length);
    expect(NAV_ENTRIES.filter((e) => e.label === "Chat")).toHaveLength(1);
    expect(NAV_ENTRIES.filter((e) => e.label === "Code")).toHaveLength(1);
    expect(NAV_ENTRIES.find((e) => e.id === "chat")!.href).toBe("/chat");
    expect(NAV_ENTRIES.find((e) => e.id === "code")!.href).toBe("/code");
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

  it.each(variants)("renders exactly one Chat and one Code entry (%s)", (_, over) => {
    if (over.section === "code") pathname = "/code";
    const html = render(over);
    pathname = "/chat";
    expect(links(html, "/chat")).toBe(1);
    expect(links(html, "/code")).toBe(1);
    const nav = navHtml(html);
    expect((nav.match(/>Chat</g) ?? []).length).toBe(1);
    expect((nav.match(/>Code</g) ?? []).length).toBe(1);
    // The old Chat | Code switch is gone.
    expect(html).not.toContain('aria-label="Mode"');
  });

  it("marks the current destination with aria-current", () => {
    const chat = render({ section: "chat" });
    expect(chat).toMatch(/href="\/chat"[^>]*aria-current="page"/);
    expect(chat).not.toMatch(/href="\/code"[^>]*aria-current="page"/);
    const code = render({ section: "code" });
    expect(code).toMatch(/href="\/code"[^>]*aria-current="page"/);
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
