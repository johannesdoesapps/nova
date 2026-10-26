# Orbis Jarvis Mode

Jarvis Mode (`/jarvis`, in the sidebar) is a voice-first assistant inside Orbis. You speak or type a request, it
replies, proposes a short plan made of real tools, asks for your approval where your settings require it,
carries the plan out, and then reports what actually happened. With the **Orbis Desktop Agent** running, it
can also act on your computer, limited to folders you allow.

This document covers the first milestone: what exists, how it fits together, how to set it up, what was
tested, and what is still to come.

## 1. What Orbis was before this milestone

- **Stack:** a Next.js 16 web app (App Router, React 19, TypeScript, Tailwind v4) on Vercel, with Supabase for
  sign-in and data.
- **AI provider layer:** `src/lib/ai`, with native tool calling and image input for Claude and GPT models.
- **Usage metering:** `enforceLimits` and `recordRunLater`.
- **Existing tools Jarvis reuses:**
  - Deep Research (`/api/research`)
  - Code, including the website builder
  - Missions
  - Memory (`/api/memories`)
  - browser voice input (`useSpeech`)
- **What it lacked:** any way to touch the user's own computer, and any voice-first, multi-step flow with
  permissions.

## 2. Architecture

```
Browser (/jarvis)                                Orbis server                        Your computer
┌──────────────────────────────┐   POST /api/jarvis/turn   ┌───────────────────┐
│ Voice in (Web Speech API)    │ ────────────────────────▶ │ Planner           │
│ Voice out (speechSynthesis)  │ ◀──── say + tool calls ── │ (model proposes,  │
│ Mission runner               │                           │  server vets)     │
│  └ permission rules          │   POST /api/jarvis/look   │ Screen question   │
│  └ approvals, pause, stop    │ ────────────────────────▶ │ (vision model)    │
│ Browser tools                │                           └───────────────────┘
│ Desktop client ──────────────┼── http://127.0.0.1:47821 ──────────────────▶ ┌──────────────────────┐
└──────────────────────────────┘    (paired token)                            │ Orbis Desktop Agent   │
                                                                               │ allowed folders only  │
                                                                               │ no delete/overwrite   │
                                                                               │ operation log, undo   │
                                                                               └──────────────────────┘
```

| Part | Where | What it does |
|---|---|---|
| Tool list | `src/lib/jarvis/tools.ts` | Every tool Jarvis can use. Each has typed arguments (zod), says where it runs (browser or desktop) and has a risk class (read, private, act, write or spend). There is no tool for deleting, running commands, sending messages or buying. |
| Permission rules | `src/lib/jarvis/permissions.ts` | Four autonomy levels (Observe, Assist, Supervised, Trusted). Some rules apply at every level: emergency stop, desktop tools need the agent, and batches need approval. |
| Missions | `src/lib/jarvis/mission.ts` | Runs steps one at a time: approvals, pause/resume, stop, timeouts, and retrying failed reads only. Results are recorded honestly (see the next table). The final report is built from the results, not from the model. |
| Planner | `src/lib/jarvis/planner.ts`, `src/app/api/jarvis/turn` | The model proposes tool calls (native tool calling, or a JSON fallback). The server keeps only known tools that were offered and have valid arguments. Usage is metered like a chat message (`purpose: "jarvis"`). |
| Screen question | `src/app/api/jarvis/look` | Answers a question about one screenshot that you chose to share. The picture isn't stored. |
| Executors | `src/lib/jarvis/executors.ts` | Carries out each tool in the browser, or through the agent. |
| Desktop client | `src/lib/jarvis/desktop-client.ts` | Pairing, status checks, tool calls, halt and resume. |
| Desktop Agent | `public/downloads/orbis-desktop-agent.mjs` | A local Node.js service with no dependencies (see §4). |
| Command Center | `src/components/jarvis/*`, `src/app/(studio)/jarvis` | The animated core, the conversation, push-to-talk, quick actions, Mission control, the Desktop Agent panel, settings and activity. |

Every step records which of these happened:

| Status | Meaning |
|---|---|
| Proposed / planned | Jarvis suggested it; nothing has run. |
| Waiting for approval | It needs your OK first. |
| Rejected | You declined it. |
| Denied | Your settings don't allow it. |
| Completed | The tool reported success. |
| Failed | The tool reported failure. |
| Cancelled | It was stopped. |

On top of that, each completed step says whether it was **checked**:
- **true:** the tool checked the result (for example, that a moved file exists at its new path and not at the
  old one);
- **false:** the check failed;
- **null:** there's no way to check.

A timed-out change is reported as "may or may not have finished", never as done.

## 3. Tools in this milestone

| Tool | Runs in | Risk | Notes |
|---|---|---|---|
| `open_url` | browser | act | http(s) only. If the browser blocks the new tab, the step says so and gives you a link. |
| `open_orbis_page` | browser | act | Opens an Orbis page in a new tab. |
| `research` | browser | spend | Starts Deep Research, which runs in a new tab. |
| `build_website` | browser | act | Opens Code with the request filled in; you press send there. |
| `start_mission` | browser | act | Opens Missions with your goal filled in. |
| `remember` | browser | spend | Adds a fact to Orbis memory, which you can see and delete. |
| `read_clipboard` | browser | private | Reads the clipboard once. The text is then answered in a separate turn with no tools, marked as untrusted. |
| `look_at_screen` | browser | private | You pick a screen or window in the browser's own prompt. Jarvis takes one picture and stops sharing at once. |
| `open_application` | desktop | act | macOS: `open -a`, then checks that the app is running. Windows: `Start-Process`, with no check. Linux: reported as unsupported. |
| `open_path` | desktop | act | Opens a file or folder inside the allowed folders. |
| `list_directory`, `find_files` | desktop | read | Inside the allowed folders. Search goes 4 levels deep and stops at 200 results. |
| `create_directory`, `move_file`, `copy_file`, `rename_file` | desktop | write | Never overwrites anything. Moves and renames are logged and can be undone. |
| `organize_folder` | desktop | write, batch | Previews the exact moves, you approve that list, then the agent applies only those moves. Files still downloading are skipped. |
| `undo_last_change` | desktop | write | Reverses the last batch, but only if nothing has changed since. |
| `system_info` | desktop | read | Operating system, memory, free disk space and battery (where available). |

What each autonomy level allows:

| Risk | 1 Observe | 2 Assist | 3 Supervised | 4 Trusted |
|---|---|---|---|---|
| read | runs | runs | runs | runs |
| act | refused | asks | runs | runs |
| private | refused | asks | asks | runs (the browser still asks) |
| write | refused | asks | asks | runs; batches over 25 items ask |
| spend | refused | asks | asks | asks |

## 4. The Orbis Desktop Agent

**Setup:**
1. Download the agent from Jarvis → Desktop Agent → **Download the agent**. Or use it straight from the
   repository: `public/downloads/orbis-desktop-agent.mjs`.
2. It needs Node.js 20 or newer. Start it with:

```
node orbis-desktop-agent.mjs                       # Downloads, Documents, Desktop
node orbis-desktop-agent.mjs --allow ~/Projects    # choose folders (repeat --allow)
node orbis-desktop-agent.mjs --origin http://localhost:3000   # also accept a development copy of Orbis
```

3. Enter the 6-digit code it prints in Jarvis → Desktop Agent. Newer versions of Chrome may then ask whether
   the site may connect to apps on this device; allow it.

**Security:**
- It listens only on `127.0.0.1:47821`. The site's Content-Security-Policy allows exactly that address.
- It accepts requests only from Orbis's own addresses (the `Origin` header is checked), and only when the
  `Host` header names it (this blocks DNS rebinding). It answers Chrome's Private Network Access preflight.
- **Pairing:**
  - a 6-digit code, valid for 10 minutes;
  - a new code after 5 wrong tries;
  - one 256-bit token per paired browser, compared in constant time and kept in memory only (it's gone when
    the agent stops).
- **Paths:**
  - `~` is expanded, then the real path is resolved, so symbolic links can't escape the allowed folders;
  - case-insensitive comparison on macOS and Windows;
  - the allowed folders themselves can't be moved or renamed.
- **Changes:**
  - no tool deletes anything;
  - moves, copies and renames fail if something already exists at the destination;
  - a move between drives copies the file, checks its size, and only then removes the original;
  - undo removes only folders the agent created, and only when they're empty.
- Programs are started without a shell (`execFile`), and app names are checked against a strict pattern.
- Actions run **one at a time**. Halt (the emergency stop) refuses everything until you resume.
- **Log:** `~/.orbis-agent/operations.jsonl` records the action, paths, batch and outcome, never file contents.

## 5. Voice, privacy and data

- **Push to talk:**
  - hold **Alt+J** (⌥J on a Mac; you can change it in Settings) or hold the microphone button;
  - speak, then let go to send, or press Esc to cancel;
  - a keyboard user can press Enter or Space on the mic button to start and stop;
  - nothing is recorded until you press.
- **Voice input** uses the browser's Web Speech API.
  - In Chrome and Edge, your audio goes to the browser maker's speech service; in Safari, to Apple's.
  - Orbis receives only the words.
  - In Firefox, typing is the alternative.
- **Voice replies** use the voices on your device (`speechSynthesis`). Speaking, typing or pressing Esc
  interrupts them.
- **Sent to Orbis's server:**
  - your request;
  - the last 12 turns of the conversation;
  - your mode and autonomy level;
  - whether the agent is connected, plus its platform and allowed folder names.
- **Sent only when you ask:**
  - clipboard text and screenshots, sent to the model for that one answer and not stored by Orbis.
- **Kept in this browser only:** settings, the emergency-stop state, the pairing token, and mission history.
  History keeps requests, steps and results, but never clipboard text or screenshot answers. You choose how
  long it's kept (0, 1, 7, 30 or 90 days) and can clear it at any time.
- Nothing in this milestone writes to the database, so **no migration is needed**.

## 6. Untrusted content

- The model never sees file contents or web pages.
- Clipboard text goes back to the model in a **turn with no tools**, inside `<untrusted>` tags.
- The screen-question model can call only one tool: "ask for a better view".
- Even if a model were manipulated, it can only propose calls. Each call is vetted by the server, checked by the
  permission rules in the browser, and checked again by the agent.

## 7. What was tested (2026-10-26)

**Automated tests** (`npx vitest run`):

| File | Tests | Covers |
|---|---|---|
| `tests/jarvis.test.ts` | 19 | Tool list, proposal checks (including `javascript:` and `file:` URLs, a shell-injected app name, a path in a rename), the permission table at each level, and the mission runner: order, approval, rejection, batch approval of the exact list, refusal, partial failure, retry only for reads, a timeout counted as unknown, stop while running, stop while waiting, pause and resume. Also settings fallbacks, history trimming with private text removed, and push-to-talk key matching and clash warnings. |
| `tests/jarvis-api.test.ts` | 11 | System prompt contents, vetting, the JSON fallback, the `/turn` route (native, desktop, JSON, answer-only, bad requests, metering), and the `/look` route (answer, better view, vision required, image validation). |
| `tests/desktop-agent.test.ts` | 13 | Folder limits, symbolic-link escape, no overwrite, sorting from an approved list only, rejection of tampered moves, undo, halt, unknown tools, macOS launch without a shell plus the running check, and the HTTP layer: Origin, Host (DNS rebinding), pairing, token, Private Network Access preflight, JSON only. |

**End to end:** a production build in Chromium, with the **real Desktop Agent on Linux** and the model's turns
**mocked** (this environment has no AI provider keys):
- the sidebar entry;
- the agent shown as not running, then started, a wrong code refused, the right code paired;
- organise Downloads: 7 moves shown for approval, nothing moved before approval, then "Moved 7 of 7 files …;
  nothing was deleted", checked on disk;
- undo: "Put back 7 of 7 items", checked on disk;
- declined approval: the disk was unchanged;
- a folder outside the allowed ones was refused, and the file there was untouched;
- emergency stop: the banner showed and the next action was blocked; after resume it worked;
- Observe refused opening a page;
- `open_url` opened a tab;
- push-to-talk with Alt+J: the transcript was sent on release (the speech service was a stand-in);
- 8 missions appeared in Activity;
- no console errors;
- no sideways scrolling at 390 px.

**HTTPS check:** a page served over HTTPS with the production CSP (including `upgrade-insecure-requests`)
reached the agent at `http://127.0.0.1:47821` in this Chromium.

## 8. Not done yet, and what's needed

| Gap | Why | What it needs |
|---|---|---|
| A push-to-talk shortcut that works in **every app** | A web page can only see keys while it has focus. | A packaged desktop app (Tauri recommended: small, Rust shell with a global-shortcut plugin) that bundles the agent and adds a tray/menu-bar control and the Orbis Pulse mini window. |
| Window management, clicking or typing in other apps, reading other apps' screens through accessibility APIs | Needs native code and operating-system permissions (macOS Accessibility and Screen Recording; Windows UI Automation). | The desktop app, with per-platform adapters behind the agent's tool interface. |
| Testing on macOS and Windows | This environment is Linux. The macOS and Windows code (launching apps, battery) is written and unit-tested with a fake runner, but has **not** been run on those systems. | A run of the test plan on a real Mac and a real Windows PC. |
| A real model and speech end to end | No AI provider keys or speech service here. | A check on a deployed preview with keys. |
| A loop where Jarvis looks at results and re-plans | This milestone plans once per request; the reports come from tool results. | Feeding the results back to the model, inside `<untrusted>` tags, for follow-up steps. |
| Approved commands, media and volume controls, calendar and email | Left out on purpose for the first milestone (higher risk). | Connectors, and an allow-list of commands with previews. |
| Cross-device mission history, replay, custom voice commands, Agent Council view | History is per browser to avoid a database migration. | A table (migration to approve) and a replay that checks permissions again. |
| Wake word | Optional by design, and needs an on-device detector. | The desktop app with a local keyword model. |

## 9. The ORBIS core (Jarvis page)

The top of `/jarvis` is the ORBIS screen: a live particle core, rendered with WebGL through three.js (already a
dependency), above a perspective floor. It uses Orbis's colours: the logo's gradient (violet `#7c3aed` →
magenta `#d946ef` → rose `#fb7185`) runs across the particles from left to right, with violet links and floor
and a deep violet-black background. Error turns it orange-red, waiting for approval turns it amber, and the
emergency stop dims it. The system line runs along the top (core state, vault, terminals); the
ORBIS name and the state controls sit along the bottom.

| Part | File | What it does |
|---|---|---|
| OrbisConfig | `src/components/jarvis/orbis/config.ts` | Particle counts, link distance, link limits, pixel-ratio cap, palette, and the quality tier for this device (high: 3,200 particles, medium: 2,000, low: 1,100). |
| ParticleSystem | `orbis/particles.ts` | The cloud: denser toward the centre, an uneven edge, clusters. Smooth drift that never repeats, a travelling wave, breathing, audio swell, flashes, and particles stepping aside from the pointer. Links come from a uniform-grid neighbour search (only the 27 nearby cells), refreshed every 2–4 frames; between refreshes they follow their particles and fade with distance. |
| OrbisCore / Lighting / Grid | `orbis/scene.ts` | Points use a soft-glow shader, with depth-dependent brightness and outward light pulses. Links use additive line segments. Glow comes from three additive sprites (centre, halo, atmosphere) rather than full-screen bloom. The floor is a shader grid that fades with distance and has a slow light sweep. If frames stay slower than about 40 fps, it draws fewer particles and then steps down a tier. |
| OrbisStateManager | `orbis/state.ts` | Visual targets for idle, listening, thinking, speaking, error, plus approval (amber) and stopped (dimmed). Every value eases exponentially, so nothing jumps. It also holds the shared store and API (below). |
| OrbisAudioAnalyzer | `orbis/audio.ts` | A smoothed loudness level from the microphone stream push-to-talk already opens. |
| OrbisAnimator | `orbis/animator.ts` | The animation state both renderers share: easing between looks, blending each state's colours, rotation, and the waves of light. |
| 2D renderer | `orbis/scene-2d.ts` | The same core drawn with the ordinary 2D canvas, for browsers that give the page no WebGL (hardware acceleration off, a blocked GPU driver, some remote desktops and VMs). It uses the same particles and animator; links are stroked in six brightness groups, points are stamped from small pre-drawn glow images, and the floor is drawn once per size and colour. It starts no higher than the medium tier, then steps down (fewer particles, a lower tier, fewer pixels) if frames stay slower than about 30 fps. |
| OrbisInterface | `orbis/orbis-hero.tsx`, `orbis/orbis-core.tsx` | The layout and controls. It loads three.js only in the browser; resizes with its box; pauses when the tab is hidden or the core is off screen; draws a still picture for reduced motion; and frees GPU resources on unmount. Renderer order: WebGL, then the 2D canvas if WebGL can't start or its context is lost (logged once as a console warning), then the simple CSS core only if the 2D canvas fails too. The wrapper's `data-orbis-renderer` says which one is drawing (`webgl` or `2d`). |

**API** (`src/components/jarvis/orbis/state.ts`):

- `setOrbisState(activity)` reports what the assistant is really doing: `idle`, `listening`, `thinking`,
  `speaking` or `error`, plus Jarvis's `working`, `approval` and `stopped`. The Jarvis page calls it from its own
  state (speech recognition, requests in flight, missions, approvals, speech output and the emergency stop).
- `setOrbisMode("auto" | state)`: `auto` (the default) follows the assistant. A state previews that look, and
  the system line says **(preview)** so a preview is never mistaken for real activity.
- `pulseOrbis(strength)` sends a wave of light from the centre. Jarvis sends one for each spoken word
  (`SpeechSynthesisUtterance` boundary events). Speech engines that don't report words get a steady pulse while
  they speak, because the device's speech engine doesn't expose its audio for analysis.

**What the system line shows:**
- "Connected vault" means you're signed in, so your saved memories and history are reachable.
- "Terminals · connected" means the Desktop Agent is paired.
- Either one shows as offline otherwise.

**Settings → "Core reacts to the pointer"** turns off pointer interaction.

**Tested:**
- `tests/orbis-core.test.ts` (14 tests): tiers; the cloud's shape; the grid search giving exactly the same links
  as a brute-force search; link limits and fading; smooth, finite motion; flash rate; stepping down; easing
  without jumps; state mapping; preview labelling; pulses; the 2D camera keeping the whole core inside the
  canvas at desktop, phone and wide sizes; and the animator's colour blending, waves, and reduced motion.
- In Chromium with software WebGL (SwiftShader):
  - the core renders, and each control changes the look and the status line;
  - a request turns the real state to Thinking;
  - keyboard controls work;
  - reduced motion draws a still frame;
  - the quality tier is low at 390 px and medium at 820 and 1440 px;
  - no sideways scrolling;
  - no console errors.

  Software rendering ran at about 24–31 frames per second, which says nothing about real GPUs; the 60 fps target
  hasn't been measured on real hardware.
- In Chromium with WebGL switched off (`--disable-gpu --disable-software-rasterizer`, where three.js reports
  "Error creating WebGL context"): the 2D renderer takes over at the medium tier (2,000 particles); idle,
  thinking and error each draw their look; reduced motion draws a still frame; no page errors. The page got
  about 56 frames per second here; that headless machine isn't a real user's computer either.
