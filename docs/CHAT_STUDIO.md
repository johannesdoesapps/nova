# Chat Studio (`/chat`)

See also [AGENTS.md](AGENTS.md) for the Agents workspace, which shares this frame.

The chat is a full-screen workspace with its own layout (`src/app/(studio)`), separate from the dashboard shell. It shares the app's session data through `AppProvider`.

## Design language

- **Material:** glass is used only for the sidebar, the composer, menus and dialogs. The reading column stays on a plain background.
- **Themes:** light mode uses warm paper (`#f5f2ec`). Dark mode uses deep charcoal (`#17171b`), never pure black.
- **Accent:** one muted violet, used for the send button, focus halo, citations and selection.
- **Type:** Geist for the interface. Instrument Serif appears only in the welcome headline. Replies are set at 16 px with a 1.75 line height, in a column at most 768 px wide.
- **Tokens:** all values live in `src/components/studio/studio.css` as `--s-*` variables and are exposed to Tailwind as `s-*` colours (`bg-s-glass`, `text-s-ink-2` and so on).
- **Motion:** entrances take 0.2–0.35 s. There is no continuous decorative motion. Every animation turns off under `prefers-reduced-motion`.

## Components (`src/components/studio`)

| File | Role |
| --- | --- |
| `frame.tsx` | Persistent shell shared by Chat and Agents: sidebar, dialogs, theme, shortcuts, toasts; `useStudio()` context and `StudioHeader` |
| `studio.tsx` | The general chat page |
| `thread.tsx` | `ConversationPane`: message list, scroll-follow, floating composer, loading and error states (shared with agents) |
| `use-chat.ts` | Chat state: send, stream, stop, retry, open/new, URL sync. `basePath` and `transport` let agents reuse it |
| `chat-client.ts` | Integration layer, the only code that calls the AI backend |
| `history.ts` | `HistoryStore`, with a server implementation (signed in) and a localStorage implementation (guest); date grouping |
| `composer.tsx` | Auto-growing glass composer: attachments (button, drag-drop, paste), mode, model, web search, voice input |
| `message.tsx` | User and assistant messages, thinking and streaming states, sources, errors, actions |
| `sidebar.tsx` | Collapsible rail on desktop and a drawer on mobile: search, navigation, grouped history, rename/delete, profile menu |
| `dialogs.tsx` | Settings, saved prompts, delete confirmation, save to project |
| `ui.tsx` | Primitives: `Menu` (portal, keyboard navigation), `Dialog` (native `<dialog>`), `Switch`, `Segmented`, `IconButton` |
| `prefs.ts` | Per-device preferences: theme (light/dark/auto), settings, saved prompts, feedback |

## Connecting an AI provider

The browser only calls `POST /api/chat`, which streams NDJSON events (`meta`, `sources`, `notice`, `delta`, `done`, `error`). Provider keys are read on the server in `src/lib/ai` and never reach client code.

- **To use a real model:** set `OPENAI_API_KEY` or `HUGGINGFACE_API_KEY` in `.env.local`.
- **To add a different provider:** implement `AIProvider` in `src/lib/ai/providers/` and register it in `src/lib/ai/index.ts`. The studio needs no changes.

Without a key, the labelled demo provider streams a template reply. It is marked "Simulated" in the UI and contains no analysis.

## Where data lives

| Data | Signed in | Guest |
| --- | --- | --- |
| Conversations | Supabase (`/api/conversations`) | This browser (`localStorage`, newest 40) |
| Saved prompts, feedback, settings, last model, sidebar state | This browser | This browser |

## Conversation tools

- **Edit a question:** use the pencil under any message you sent. The new text replaces that message and everything after it. The model sees only the turns before it. Signed in, the old messages are deleted only after the new reply is saved.
- **Regenerate:** only the latest reply can be regenerated.
- **Archive:** archive a chat from its menu in the sidebar. Archived chats are hidden from the list but kept. Find them under **Settings → Chat history → Archived chats**, where they can be restored or deleted. This needs an account.
- **Reply settings** (Settings):
  - **Length** (Short, Normal, Detailed) and **style** (Precise, Balanced, Creative) are added to the model's instructions.
  - Short also lowers the reply's output limit, within the plan's limit.
  - Temperature isn't offered because current reasoning models don't accept it.

## Honest limits

- **Images:** the "Add images" control is disabled and explains why. The connected models accept text only.
- **Voice input:** appears only where the browser supports the Web Speech API.
- **Feedback:** thumbs up/down is stored on the device. It is not sent to a server or used for training.

## Keyboard

| Shortcut | Action |
| --- | --- |
| Enter | Send (configurable in Settings) |
| Shift+Enter | New line |
| Ctrl/⌘+K | Search chats |
| Ctrl/⌘+Shift+O | New chat |
| Ctrl/⌘+B | Toggle sidebar |
| Esc | Close menus and dialogs |
