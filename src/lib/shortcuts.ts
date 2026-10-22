/**
 * Orbis's keyboard shortcuts, in one list: the key handler, the shortcuts
 * help and the command palette's hints all read from here.
 *
 * Chosen not to clash with the browser or with text editing: ⌘/Ctrl+K,
 * ⌘/Ctrl+Shift+O and ⌘/Ctrl+B aren't browser shortcuts inside a page, and the
 * single-key ones ("/" and "?") only work when you're not typing in a field.
 * On a Mac the modifier is ⌘ (Control+K is "delete to end of line" there);
 * elsewhere it's Ctrl.
 */

export type ShortcutId = "palette" | "new-chat" | "sidebar" | "focus-composer" | "shortcuts" | "send" | "newline" | "close" | "move";

export interface Shortcut {
  id: ShortcutId;
  label: string;
  /** KeyboardEvent.key (lower case for letters). */
  key: string;
  mod?: boolean;
  shift?: boolean;
  /** Also works while typing in a text field. */
  whileTyping?: boolean;
  /** Listed for reference; handled by the component itself (e.g. Enter in the message box). */
  info?: boolean;
  group: "General" | "Chat" | "Lists and menus";
}

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", label: "Search and run commands", key: "k", mod: true, whileTyping: true, group: "General" },
  { id: "new-chat", label: "New chat", key: "o", mod: true, shift: true, whileTyping: true, group: "General" },
  { id: "sidebar", label: "Show or hide the sidebar", key: "b", mod: true, whileTyping: true, group: "General" },
  { id: "shortcuts", label: "Show keyboard shortcuts", key: "?", group: "General" },
  { id: "focus-composer", label: "Go to the message box", key: "/", group: "Chat" },
  { id: "send", label: "Send the message", key: "Enter", info: true, group: "Chat" },
  { id: "newline", label: "New line in the message", key: "Enter", shift: true, info: true, group: "Chat" },
  { id: "move", label: "Move through results and menu items", key: "↑ ↓", info: true, group: "Lists and menus" },
  { id: "close", label: "Close a dialog, menu or the palette", key: "Escape", info: true, group: "Lists and menus" },
];

export const shortcut = (id: ShortcutId) => SHORTCUTS.find((s) => s.id === id)!;

export const isMacPlatform = (platform: string) => /Mac|iPhone|iPad|iPod/.test(platform);

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

/** Whether a key press is this shortcut on this platform. */
export function matchesShortcut(e: KeyLike, s: Shortcut, mac: boolean): boolean {
  if (s.info || e.altKey) return false;
  const modDown = mac ? e.metaKey : e.ctrlKey;
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  if (otherMod || modDown !== !!s.mod) return false;
  // "?" is Shift+/ on most layouts: match the character, whatever produced it.
  if (s.key === "?") return e.key === "?" || (e.key === "/" && e.shiftKey);
  if (!!s.shift !== e.shiftKey) return false;
  return e.key.toLowerCase() === s.key;
}

/** The keys to show for a shortcut: ⌘ ⇧ O on a Mac, Ctrl Shift O elsewhere. */
export function shortcutKeys(s: Shortcut, mac: boolean): string[] {
  const keys: string[] = [];
  if (s.mod) keys.push(mac ? "⌘" : "Ctrl");
  if (s.shift) keys.push(mac ? "⇧" : "Shift");
  keys.push(s.key === "Escape" ? "Esc" : s.key.length === 1 ? s.key.toUpperCase() : s.key);
  return keys;
}

/** A text field, editor or other place where typed keys belong to the field. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file", "image"].includes((el as HTMLInputElement).type);
  if ((el as HTMLElement).isContentEditable) return true;
  // Code editors (CodeMirror, Monaco) and other widgets that take typing.
  return !!el.closest?.('[contenteditable="true"], .cm-editor, .monaco-editor, [role="textbox"], [role="combobox"]');
}

/** The shortcut a key press triggers, if any (single-key ones only outside text fields). */
export function shortcutFor(e: KeyLike, mac: boolean, typing: boolean): ShortcutId | null {
  for (const s of SHORTCUTS) if (matchesShortcut(e, s, mac) && (s.whileTyping || !typing)) return s.id;
  return null;
}
