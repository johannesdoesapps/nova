# UI, accessibility, responsive and performance audit (24 Oct 2026)

How it was measured: axe-core 4.14 (WCAG 2.0/2.1/2.2 A and AA rules plus best practices), a Playwright sweep for horizontal overflow, clipped elements, touch targets and heading structure, keyboard scripts for menus and dialogs, Lighthouse 12 (mobile, simulated throttling) on the live site, and JavaScript transfer sizes per page. Public pages were tested on tryorbis.app; signed-in pages on a local production build backed by a fake database (no real accounts used). Agent-run states (running, finished with failed tests, diffs) were filled with sample data.

## Results

| Check | Before | After |
| --- | --- | --- |
| axe violations, signed-in app (20 pages × 4 widths × 2 themes) | heading order on 14 pages, missing h1 in Code, missing main landmark on sign-in, password reset and 404, small target in the composer | 0 |
| Horizontal scroll (320, 390, 430, 768, 1024, 1440, 1920 px) | none | none |
| Colour contrast (axe, both themes) | passes | passes |
| Lighthouse mobile, home (4 runs) | 88–98, median ~97; LCP 2.4–3.2 s; CLS 0 | unchanged (no regression to fix) |
| Lighthouse mobile, pricing / docs / sign-in | 96 / 95 / 99 performance; 100 accessibility | — |
| Layout shift, app pages | ≤ 0.064 (Usage), ≤ 0.059 (Code) | — |
| JavaScript (gzip) | marketing home 178 KB; app pages 220–336 KB; sign-in 305 KB | — |
| SEO (25 sitemap pages) | unique titles/descriptions, canonicals, social images, one h1 each; 7 descriptions over 160 characters | home and features trimmed |

## Fixed

- **Free accounts were told their advanced-model allowance was used up.** Free has no advanced-model share, so its limit was $0 and "spent ≥ limit" was true from day one. Display only (the database enforces limits separately). `budgetState` now ignores a zero share.
- **Code composer said "Each step uses 1 unit".** Steps are charged by size; the note now says so.
- **Next steps said "below" for sections shown above them.** They now name the section.
- **Phones: the Code header hid the project name.** The computer switch moves into the More menu on phones.
- **Screen readers:**
  - The agent's whole activity feed was a live region, so every log line and test output would be read out. Now one status line announces the task's state.
  - The app had no skip link; one now jumps past the sidebar to the main area.
  - The sidebar's group labels were h3s before the page's h1. They are now h2s.
  - Chat replies' headings now start at level 2 (with `aria-level`, so the look is unchanged).
  - Code workspace has an h1.
  - Sign-in, password reset and 404 have a main landmark; the 404 has its own title.
  - Labels that screen readers ignore (`aria-label` on plain spans and divs) were replaced or given roles. This includes the file tree's unsaved dot and the +/− line counts.
- **Touch targets:**
  - The composer's lightbulb could be squeezed to 15 px wide; it no longer shrinks.
  - The tip's close button is 24 px.
  - Sign-in "Forgot password?" and "Sign up", and the consent page's sign-out link, are taller.
  - Report file links are at least 24 px.
- **Marketing focus ring:** the light-theme focus ring was about 1.8:1 against the page; it now matches the app's ring (above 3:1 in both themes).

## Checked and fine

Menus and the model picker: arrow keys, Escape, and focus returns to the trigger. Dialogs use native modal `<dialog>`. The command palette traps Tab and restores focus. The mobile sidebar traps focus and Escape closes it. Reduced motion turns off animations. Status pills always have text, never colour alone.

## Remaining (not fixed)

1. On phones the Code header shows only a few letters of a long project name. A dedicated phone header (or the name in the pane tabs) would show more.
2. Several standalone text links are 19–20 px tall. They pass WCAG 2.5.8 through its spacing exception, but larger tap areas would be easier: "Getting started", "All tasks", "Settings", "Continue: …", and the homepage "Start from this idea".
3. Sign-in loads 305 KB of JavaScript (mostly the Supabase client). Loading it only when the form is submitted would cut that; Lighthouse already scores the page 99.
4. Two separate token sets exist: marketing `--fg/--bg…` and app `--s-*`. They agree on values but could be merged into one source.
5. Five feature-page descriptions are still 165–205 characters.
6. Not tested: real screen readers (VoiceOver, NVDA), real touch devices, and signed-in pages against live data. The test accounts are locked, so signed-in pages were checked against sample data.
