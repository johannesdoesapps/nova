/**
 * Keyboard shortcuts: platform modifiers, no clashes with typing, the keys
 * shown for each, and the command palette's ranking.
 */
import { describe, expect, it } from "vitest";
import { isTypingTarget, matchesShortcut, shortcut, shortcutFor, shortcutKeys, SHORTCUTS } from "@/lib/shortcuts";
import { rankCommands } from "@/components/studio/command-menu";

const key = (k: string, o: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) => ({ key: k, ctrlKey: !!o.ctrl, metaKey: !!o.meta, shiftKey: !!o.shift, altKey: !!o.alt });

describe("matching", () => {
  it("uses ⌘ on a Mac and Ctrl elsewhere, never the other one", () => {
    expect(shortcutFor(key("k", { meta: true }), true, false)).toBe("palette");
    expect(shortcutFor(key("k", { ctrl: true }), true, false)).toBeNull(); // Control+K deletes to the end of the line on a Mac
    expect(shortcutFor(key("k", { ctrl: true }), false, false)).toBe("palette");
    expect(shortcutFor(key("k", { meta: true }), false, false)).toBeNull();
    expect(shortcutFor(key("K", { ctrl: true }), false, false)).toBe("palette");
  });

  it("needs exactly the modifiers it lists", () => {
    expect(shortcutFor(key("O", { ctrl: true, shift: true }), false, false)).toBe("new-chat");
    expect(shortcutFor(key("o", { ctrl: true }), false, false)).toBeNull(); // Ctrl+O stays the browser's "open file"
    expect(shortcutFor(key("k", { ctrl: true, shift: true }), false, false)).toBeNull();
    expect(shortcutFor(key("k", { ctrl: true, alt: true }), false, false)).toBeNull();
    expect(shortcutFor(key("b", { ctrl: true }), false, false)).toBe("sidebar");
  });

  it("only uses single keys when you're not typing", () => {
    expect(shortcutFor(key("/"), false, false)).toBe("focus-composer");
    expect(shortcutFor(key("/"), false, true)).toBeNull();
    expect(shortcutFor(key("?", { shift: true }), false, false)).toBe("shortcuts");
    expect(shortcutFor(key("?", { shift: true }), false, true)).toBeNull();
    expect(shortcutFor(key("/", { ctrl: true }), false, false)).toBeNull();
    // The palette and new chat work from inside the message box.
    expect(shortcutFor(key("k", { ctrl: true }), false, true)).toBe("palette");
  });

  it("never triggers the reference-only entries", () => {
    for (const s of SHORTCUTS.filter((x) => x.info)) expect(matchesShortcut(key(s.key, { shift: !!s.shift }), s, false)).toBe(false);
    expect(shortcutFor(key("Enter"), false, false)).toBeNull();
    expect(shortcutFor(key("Escape"), false, false)).toBeNull();
  });

  it("has no two shortcuts on the same keys", () => {
    const combos = SHORTCUTS.filter((s) => !s.info).map((s) => `${s.mod}-${s.shift}-${s.key}`);
    expect(new Set(combos).size).toBe(combos.length);
  });
});

describe("showing keys", () => {
  it("uses the platform's symbols", () => {
    expect(shortcutKeys(shortcut("new-chat"), true)).toEqual(["⌘", "⇧", "O"]);
    expect(shortcutKeys(shortcut("new-chat"), false)).toEqual(["Ctrl", "Shift", "O"]);
    expect(shortcutKeys(shortcut("focus-composer"), false)).toEqual(["/"]);
    expect(shortcutKeys(shortcut("close"), false)).toEqual(["Esc"]);
  });
});

describe("typing targets", () => {
  const el = (tag: string, props: Record<string, unknown> = {}) => ({ tagName: tag, isContentEditable: false, closest: () => null, ...props }) as unknown as Element;
  it("treats text fields and editors as typing, buttons and checkboxes not", () => {
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("INPUT", { type: "text" }))).toBe(true);
    expect(isTypingTarget(el("INPUT", { type: "search" }))).toBe(true);
    expect(isTypingTarget(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTypingTarget(el("SELECT"))).toBe(true);
    expect(isTypingTarget(el("DIV", { isContentEditable: true }))).toBe(true);
    expect(isTypingTarget(el("DIV", { closest: () => ({}) }))).toBe(true); // inside a code editor
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("palette ranking", () => {
  const list = [
    { label: "New chat", group: "Actions", keywords: "start conversation" },
    { label: "Templates", group: "Go to", hint: "Ready-made workflows" },
    { label: "Research a topic", group: "Templates", keywords: "template workflow" },
    { label: "Weekly plan", group: "Conversations", keywords: "chat …review the quarterly pricing…" },
  ];
  it("finds templates, pages and chats by message excerpt", () => {
    expect(rankCommands(list, "templ")[0]!.label).toBe("Templates");
    expect(rankCommands(list, "quarterly pricing").map((c) => c.label)).toEqual(["Weekly plan"]);
    expect(rankCommands(list, "new")[0]!.label).toBe("New chat");
    expect(rankCommands(list, "nothing like this")).toEqual([]);
  });
});
