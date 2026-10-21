# Orbis Home

The signed-in start page at **/home** (where sign-in lands). It answers three questions: what can I do with Orbis, where did I leave off, and what useful thing can I do next. Everything on it is a real Orbis capability or comes from the user's own records; nothing is invented.

## What's on it

| Part | What it shows | Where the data comes from |
|---|---|---|
| Welcome | Date, "Good morning/afternoon/evening, {first name}", one context line ("1 project needs you and 2 tasks in progress…") | Browser clock; the loaded home data |
| Prompt box | The chat composer (multiline, Enter sends, Shift+Enter new line, attachments, model selector, mode, voice). Placeholder "What would you like to explore, create, or work on today?" Sending turns the page into the conversation in place (`/home?c=…`). | Existing chat stack (`Studio`, `useStudioChat`, `/api/chat`) |
| Suggestions | Research (fills the box, Research mode, web search when available) · Brainstorm (Critic mode) · Write · Plan my day (sends a prompt built from the user's real priorities, mission tasks and calendar events) · Build something new (opens Code) | `SUGGESTIONS` in `src/lib/home.ts` |
| Pick up where you left off | A project that needs the user (agent waiting, task in progress), else the latest conversation | `/api/home` |
| Recent conversations | Five latest, with title, time and the start of the last message; link to all conversations | `conversations` + `messages` |
| My day | Today's priorities (user-written, tick/remove, carry over unfinished), mission tasks in progress, Google Calendar events when connected, "Plan my day with AI" | `profiles.preferences.home.focus`, `project_tasks`, `calendar_events` connector tool |
| My projects | Code projects and missions, ones needing attention first; new code project / website / mission | `code_projects`, `code_agent_runs`, `projects` |
| Quick tools | Write, Research, Brainstorm, Summarise (opens the file picker), Analyse data (file picker), Code, Compare models (Council), Plan a goal (Missions) | `QUICK_TOOLS` |
| Discover | Three picks a day from curated capabilities, tools and ideas; dismiss any; "Explore everything" → /discover | `DISCOVER`, `dailyPicks` |

**Customize** hides or shows each section and restores dismissed suggestions; each section's ⋯ menu also hides it. Signed in, choices are saved to the account (`profiles.preferences.home`, no migration needed); guests keep them in the browser.

## Pages and navigation

- Sidebar: logo → Home; New chat; Search chats; Home, Chat, Code, Projects, Agents; Tools: Discover, Missions, Council, Arena, Connectors; Saved prompts; Settings; recent chats with an "All conversations" link; profile menu (theme). Collapsible on desktop, a drawer on phones. The command palette lists the same entries.
- **/projects** — all code projects and missions, filter and search, create actions (sign-in required).
- **/discover** — every curated item by group; prompt items open on the home, filled in (`/home?try=<id>`; a link never sends a message by itself).
- **/history** — every conversation, grouped by date, with search across all chats by title.
- `/projects/:id` (old research-project links) redirects to `/missions/:id` (same records). The old dashboard-era /discover and /projects pages were removed.

## APIs

- `GET /api/home` — conversations (with previews), projects, tasks, preferences and calendar state. Each part loads independently; a failing part is reported in `errors` and the rest still shows. Guests get an empty home.
- `PATCH /api/home` — `{hidden?, dismissed?, focus?}`; only the given fields change; other profile preferences are kept.
- `GET /api/home/day?timeMin&timeMax` — Google Calendar events for the user's local day (at most two days), only when connected; a calendar failure is an error, never an empty day.

## Missing dependencies (stated in the UI, not faked)

- **Calendar events** need Google Calendar set up on the site (Google OAuth client for connectors) and connected by the user. Until then My day says so and links to Connectors.
- **Reminders** — Orbis has no reminders service. My day offers user-written priorities instead and doesn't show reminders.
- **News / external updates** — none; Discover only lists Orbis's own capabilities.
- **Attachments** — the composer reads text files (.txt, .md, .csv, .json, .tsv, .log); PDFs and Word files aren't read yet, and the copy says so.

## Tests

`tests/home.test.ts` (helpers, loader with a failing part, GET/PATCH /api/home, calendar day route, every suggestion's link target exists), `tests/navigation.test.ts` (Home/Projects/Discover entries, logo, All conversations link). Browser checks: desktop and phone, guest and signed in — suggestions, Shift+Enter, priorities, dismiss, hide/restore and persistence across reload, Discover → home, logo, no sideways scrolling, axe (WCAG 2.2 AA serious/critical) on every new page in dark and light.
