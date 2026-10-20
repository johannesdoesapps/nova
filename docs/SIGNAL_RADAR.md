# Part 8 — Signal Radar & Opportunity Radar

Signal Radar follows the things a user cares about and reports **what changed
relative to a recorded baseline**: with sources, a label that separates confirmed
developments from speculation, a transparent score, and the time it last looked.
Opportunity Radar matches those signals against the user's stated interests.

**No false promise of continuous monitoring.** Checks happen only when the
user presses **Check now** or the Orbis worker process runs. The page tells the
user which of these is true, using the worker heartbeat.

Code: `engine/orbis_engine/radar/*`, `engine/orbis_engine/worker.py`, `src/components/radar/radar-view.tsx`.

---

## 1. Interface concepts (`/radar`)

- **Scheduler banner:** "Scheduled checks are running" (heartbeat in the last 15 min) or "No continuous monitoring on this server".
- **Signals tab:**
  - Filters by watch, label and baseline items.
  - A legend explains the three labels.
  - Each card shows the label, change kind, watch, score, title linking to the source, summary, publisher, source type, published and fetched dates, and "also reported by …".
  - "Why this score and label" shows the full score formula, the label reason and injection flags.
  - Dismiss.
- **Watches tab:**
  - Create form: name, kind, query, keywords, exclusions, frequency, sources (each with cost and whether it receives the query), sensitivity, alert mode, speculation alerts, private mode.
  - Each watch shows:
    - a freshness badge (`fresh / due / stale / error / never checked / manual`);
    - last checked, next check, baseline time and number of new items since;
    - alert settings and cost per check;
    - its last error;
    - **Check now**, Pause/Resume and Delete.
- **Patterns & opportunities tab:** emerging terms with lift and evidence counts ("statistical pattern, not a verified trend"), and opportunities with type, label, deadline, and why it matched.
- **Alerts tab:** instant alerts vs. "held for digest", with the reason (score vs. threshold, label, change kind, quiet hours or daily cap). Mark all read.
- **Digests tab:** generate daily or weekly now. Each digest has a cited summary ([n] → source list), sections by label, patterns, opportunities, held alerts, and **freshness of every watch at digest time**.
- **Settings tab:** interests, opportunity types, muted terms, digest frequency, max instant alerts per day, max paid web searches per day, quiet hours with UTC offset, retention days, and the privacy statement.

## 2. What can be followed

`kind` ∈ topic · question · project · source · industry · technology · competitor. Each watch has a query, keywords, exclusions and 1–10 sources.

## 3. Monitoring sources

| Source | How it is fetched | Receives your query? | Cost | Default label prior |
|---|---|---|---|---|
| RSS / Atom feed | Conditional GET (ETag / Last-Modified cache) | No (only the URL) | free | feed (or **official** if you mark it) |
| GitHub releases | `https://github.com/{owner}/{repo}/releases.atom` | No | free | official |
| arXiv | Public Atom API, newest first | Yes | free, rate-limited | preprint |
| Hacker News | Algolia search API | Yes | free | discussion (always speculative) |
| Web search | Tavily or Brave (needs `SEARCH_API_KEY`) | Yes | **paid per query** | web |

Fetching safeguards: SSRF guard on every URL and redirect hop, 2 MB response cap, 20–30 s timeouts, XML parsed with the standard library (no external entities), and a polite User-Agent.

## 4. Refresh schedules and freshness

| Frequency | Interval | Freshness: fresh / due / stale |
|---|---|---|
| hourly | 1 h (+ up to 3 min jitter) | ≤ 1.2× / ≤ 2× / > 2× the interval since the last success |
| daily | 24 h (+ ≤ 10 min jitter) | same rule |
| weekly | 7 d (+ ≤ 10 min jitter) | same rule |
| manual | never scheduled | "manual" |

The worker (`python -m orbis_engine.worker`, as a loop or `--once` from cron) claims due watches with a row lease, so two workers never check the same watch. Manual checks are limited to 3 per watch per 10 minutes. Every check is recorded (`radar_checks`) with fetched, new, duplicate, upgraded, alerts, errors, web searches and volume spike.

## 5. Baseline and change detection

1. The **first successful check is the baseline**: items are stored with `is_baseline = true` and raise no alerts.
2. Later checks keep only items that are new **and** not near-duplicates of what is already known:
   - **URL canonicalisation:** lower-case host, drop `www.`, tracking parameters (`utm_*`, `fbclid`, `gclid`, …), fragments and trailing slashes; sort the query.
   - **Exact duplicates:** SHA-256 of the normalised title and summary.
   - **Near duplicates / same story:** 64-bit SimHash over word bigrams (Hamming ≤ 6), or titles sharing ≥ 80% of terms.
3. Change kinds:
   - `new_development`: a new story cluster;
   - `corroboration`: a new publisher joins an existing story, which can upgrade it to *confirmed*;
   - `new_release` / `official_update`: from official sources;
   - `volume_spike`: new items in a check exceed the baseline mean + 2σ, with ≥ 3 items and ≥ 3 prior checks;
   - `duplicate`: stored, hidden.

## 6. Confirmed vs. reported vs. speculative

| Label | Rule |
|---|---|
| **confirmed** | Official source (release feed or a feed you marked official), **or** ≥ 2 independent publishers reporting the same story without speculative language. |
| **reported** | A single non-official source without speculative language. |
| **speculative** | Speculative language in the title (rumour, reportedly, could, may, might, plans to, sources say, leak, unconfirmed, predicts, in talks, …), or in the summary of a non-official source, or any discussion-forum item. |

The label reason is stored with each item and shown in the UI. Labels describe sourcing, not truth.

## 7. Relevance ranking (0–100, fully shown to the user)

```
score = match (0–40)          share of query/keyword terms in title (×2) and summary (×1)
      + interest (0–15)       overlap with the user's interests
      + source (0–15)         prior by source type (official 15, preprint/news 10, feed 9, web 7, discussion 5) × your source weight (0–1.5)
      + recency (0–15)        15 × 0.5^(age_days / 7); unknown date → 5
      + novelty (0–10)        new story 10 · corroboration 4 · duplicate 0
      + corroboration (0–5)   2.5 × (publishers − 1)
      − 30 if a muted term appears
score = 0 if an excluded keyword appears
```

The feed groups items by story cluster and shows the highest-scoring member, plus "also reported by".

## 8. Notification rules

| Rule | Value |
|---|---|
| Sensitivity → instant-alert threshold | low ≥ 80 · medium ≥ 65 · high ≥ 50 |
| Digest inclusion | ≥ threshold − 20 |
| Instant alert requires | alert mode `immediate`, a non-baseline item of a meaningful change kind, score ≥ threshold, label **confirmed** (unless "instant alerts for speculation" is on), watch active and not muted, not in quiet hours, under the daily cap (default 5) |
| Otherwise | Recorded as **held for digest**, with the reason ("quiet hours or daily alert limit"). |
| De-duplication | One alert per story cluster per watch. |
| Volume spikes | Always digest-level. |
| Channels | In-app (available). Email is designed but needs an email provider, so it is not offered as working. |

## 9. Digests

Daily or weekly, generated by the worker per the user's setting or on demand.

- **Content:** the highest-scoring story per cluster above the digest threshold, split into confirmed / reported / speculative, with a numbered **source list** that the extractive summary cites ([n]).
- **Also included:** emerging patterns, top opportunities, the number of alerts held, and the **freshness of every watch** at generation time (so a stale watch is visible in the digest itself).

The summary method is stated in the digest ("extractive"). A model-written summary is a planned option and must pass citation validation.

## 10. Opportunity Radar

Matches items that contain an opportunity cue **and** overlap the user's interests. The cue types are: funding, grant, tender/RFP, launch, API/tool, dataset, regulation, event/CFP, partnership, hiring.

- **Output per match:** types, matched interests, deadline text (when one is found), sourcing label, score (`0.6 × item score + 15 × matched interests + 10 × types`) and a plain-language reason.
- **Framing:** shown as "pattern matches, not recommendations — verify before acting".

**Emerging patterns:** unigrams and bigrams whose recent (14-day) frequency exceeds the prior window by ≥ 2× (additive smoothing), seen ≥ 3 times across ≥ 2 publishers, excluding the watch's own query terms.

## 11. Mute and sensitivity controls

Per watch: pause, mute until a date, sensitivity, alert mode, speculation alerts, exclusions and source weights. Global: muted terms (−30 points, never alert), quiet hours, alert cap, digest frequency and web-search budget.

## 12. Privacy controls

- Watches, items, alerts and digests are private to the owner (scoped in the engine; RLS in Postgres — see ARCHITECTURE §7).
- **Private mode** refuses sources that receive the query (arXiv, Hacker News, web search); only feeds and GitHub releases are allowed.
- The settings page states which sources receive queries.
- **Retention:** non-baseline items older than `retention_days` (default 90, range 7–365) are purged by the worker. Deleting a watch deletes its items, checks and alerts.
- Feed and item text is untrusted. Injection-like text is flagged, and it is wrapped as data whenever it is used in AI Lab.

## 13. Cost considerations

| Driver | Control |
|---|---|
| Paid web searches | Per-user daily cap (default 20); per-watch cost shown; "free sources only" badge. |
| Fetch volume | Conditional GETs (304 → reuse cached body); ≤ 50 items per source per check; jittered schedules. |
| Model calls | None in the default pipeline (scoring, labels, patterns and digests are deterministic). Model summaries would be opt-in with a per-day call budget. |
| Storage | Retention purge; baseline items kept for de-duplication only. |

Example: 10 daily watches with one web-search source each ≈ 300 paid queries a month. The same watches on feeds and GitHub releases cost nothing beyond hosting.

## 14. Interfaces

`GET radar/meta`, `GET/POST radar/watches`, `PATCH/DELETE radar/watches/{id}`, `POST radar/watches/{id}/check`, `GET radar/feed?watch_id&label&include_baseline&min_score`, `POST radar/items/{id}/dismiss`, `GET radar/patterns`, `GET radar/opportunities`, `GET/PUT radar/profile`, `GET radar/alerts?unread`, `POST radar/alerts/read`, `GET/POST radar/digests`.

## 15. Evaluation

| Metric | Target / method | Test |
|---|---|---|
| Baseline correctness | No alerts on the first check | `test_baseline_then_changes_and_alert_rules` |
| De-duplication | Tracking-parameter variants and same-headline/other-outlet items collapse | same + `test_same_headline_from_two_outlets_is_one_story` |
| Label precision | Speculation never pushed as instant by default; corroboration upgrades to confirmed | `test_baseline_then_changes_and_alert_rules`, `test_labels_and_scoring` |
| Notification discipline | Daily cap and quiet hours honoured, held alerts explained | `test_daily_alert_cap` |
| Honesty | Worker status reported truthfully; freshness states correct | `test_worker_status_is_honest`, `test_freshness_states` |
| Relevance (offline) | nDCG@10 against user-labelled relevance on 20 watches × 2 weeks; target ≥ 0.7 before tuning weights | planned |
| Alert usefulness (online) | Alert open rate, dismiss rate, mute rate per watch; target dismiss < 30% | product analytics |

## 16. Known limitations

- Hacker News, arXiv and GitHub fetches need outbound network access to those hosts. They fail visibly (as a watch error) when blocked.
- Email delivery and model-written digest summaries are not implemented.
- Lexical matching only; semantic (embedding) relevance is in the roadmap (pgvector).
