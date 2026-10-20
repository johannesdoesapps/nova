# Part 5 — Model Intelligence: Model Fingerprint & Blind Model Trials

Model Intelligence helps each user find out which of the models they can
access actually work best for *their* coding, research, writing, analysis,
extraction and general tasks. It relies on observed results only. Vendor
claims and public leaderboards are not inputs.

Two evidence streams are kept separate everywhere, in storage, statistics, UI
and routing:

| Stream | Source | Meaning |
|---|---|---|
| **Personal preference** | Blind trial votes and 1–5 ratings | What *you* prefer for your tasks. Subjective and legitimate, but yours. |
| **General measurement** | Reproducible benchmarks with deterministic checkers | How often a model meets an objective, checkable criterion. |

Code: `src/lib/intel/*`, `src/app/api/intel/*`, `src/components/intel/*`, plus the shared migration.

---

## 1. Screens

| Route | Screen | Contents |
|---|---|---|
| `/intel` | **Fingerprint** | Totals. One card per task category with two separate recommendation boxes (*Your preference* and *Measured performance*), each labelled *Not enough data*, *Tentative* or *Enough evidence*. Per-model table: blind W/L/T, preference rate with 95% CI bar, average rating, benchmark pass rate with CI, latency p50/p95, average cost per call, served version, prior-version count, drift warning. Head-to-head detail. **Routing planner.** Methodology. |
| `/intel/trials` | **Blind Trials** | Category, prompt (or a reproducible test prompt), random pair or a chosen pair. Answers A/B side by side with optional star ratings. Vote: A / B / About the same / Both bad. Reveal after the vote: model, served version, latency, tokens, cost. |
| `/intel/benchmarks` | **Benchmarks** | Test set picker (built-in or imported JSON). Description, version, content hash, system prompt, and each item with what it probes and how it is scored. Model, item count, run. Results on *this exact test-set version* per model (pass rate with Wilson CI and a below-minimum badge). Latest run item by item, with outputs. |
| `/intel/directory` | **Model Directory** | Every model with provider id, vendor-stated context, price, price validation status and issues, source link and verification date, data-handling profile (defaults to *Not verified*), versions actually served to you, and availability. **Check provider model lists** sync. "Where this data comes from". |
| `/intel/history` | **Evaluation History** | 30-day usage by model (calls, errors, served via fallback, tokens, estimated cost, by feature), all trials and benchmark runs with delete, and JSON export. |

## 2. Data structures

`src/lib/intel/types.ts`:

```ts
TrialRecord { id, createdAt, category, prompt, promptHash, testItemId,
  arms: [{ label: "A"|"B", modelId, displayName, provider, servedModel, latencyMs,
           inputTokens, outputTokens, tokensEstimated, cost, simulated, error }],
  winner: "A"|"B"|"tie"|"both_bad", ratings: { A?, B? }, note, redactions }

TestSet { id, name, category, version, description, systemPrompt, builtIn,
  items: [{ id, prompt, probes, checker: CheckerSpec }] }

CheckerSpec = exact | contains_all | contains_any | regex | numeric(tolerance)
            | json_keys | bullets(count, maxWords) | lowercase | not_stated(forbidden)

BenchmarkRun { id, createdAt, testSetId, testSetName, category, testSetHash,
  modelId, displayName, servedModel, params: { maxOutputTokens, temperature }, simulated,
  results: [{ itemId, passed, score, detail, output, latencyMs, inputTokens, outputTokens, cost, error }] }

UsageRow (model_runs) { modelId, purpose, category, servedModel, fallbackFrom, status,
                        latencyMs, inputTokens, outputTokens, cost, createdAt }

PrivacyProfile { trainsOnApiData, retentionDays, zeroRetentionAvailable, processingRegions,
                 sourceUrl, verifiedAt, notes }            // null = not verified
```

Tables (RLS on all of them):
- `blind_trials` and `benchmark_runs`: users can insert, read and delete their own, but **not update**. Evidence is not editable.
- `model_runs` gains `purpose`, `category`, `served_model` and `fallback_from`.
- `model_registry` gains `price_source_url`.
- `model_price_history` is append-only, written by a trigger on every price change.

## 3. Blind trials: keeping them blind

1. Both models get **identical** messages, system prompt and output cap.
2. Answers are released **together**, so speed cannot reveal which model is which. Latency is shown only after the vote.
3. **Self-identification is redacted** ("As ChatGPT…", "I'm Claude…", vendor and model-family names) and replaced with `[model identity hidden]`. The count is shown.
4. A/B order is randomised with a **CSPRNG** (`crypto.getRandomValues`).
5. The identity mapping travels in an **AES-256-GCM sealed token** (encrypted, authenticated, 24-hour expiry, bound to the user). The browser never sees which model is A until the vote is submitted. `NOVA_TRIAL_SECRET` keeps tokens valid across restarts.
6. *Random pair* mode is the most blind. *Choose two* reveals the pair but not the order.
7. If one arm fails, the trial is **voided**: it is revealed and not recorded, because a one-sided trial measures nothing.
8. Simulated (demo) arms are labelled before the vote and in history.

## 4. Benchmarks: reproducible measurement

- Six built-in sets: code reading, grounded reading (including "not stated" items that test hallucination resistance), instruction following, quantitative reasoning, field extraction and stable facts. Every item has an objective, deterministic checker. **No LLM-as-judge** is used in the general stream.
- Each run stores the **test-set content hash** (items, checkers, system prompt, version), the **served model version**, and the **parameters actually sent**. OpenAI's newer models reject non-default temperature, so it is recorded as `null` (provider default) rather than claimed as 0.
- Results are **only pooled for an identical test-set hash and the current served version**.
- Users can import custom test sets (validated JSON, same checker vocabulary). Custom sets are hashed the same way.
- Cost control: at most 12 items per run, each item counts against rate limits and daily quotas, and runs use 2 concurrent workers.

## 5. Statistics and "not enough data" rules

All functions are in `src/lib/intel/stats.ts` and `fingerprint.ts`, and covered by `tests/intel.test.ts`.

| Quantity | Method | Minimum before reporting |
|---|---|---|
| Pairwise preference | Share of trials where A was preferred (ties = ½, *both bad* excluded), time-decayed, prior versions down-weighted. **95% Wilson interval** on the raw count. | **10 trials per pair.** Below that: "not enough data (N more needed)". With enough trials: "preferred" only if the interval excludes 50%, otherwise "no clear difference". |
| Personal recommendation | Leader by Bradley–Terry strength (MM algorithm with a weak prior; bootstrap rank intervals, seeded). | *Enough evidence* only if the leader beats **every** other tested model with a significant pairwise preference. *Tentative* if some pairs have enough data but don't separate. *Not enough data* if every pair with the leader is below the minimum. |
| Benchmark pass rate | Pass / scored items, **Wilson interval**. | **20 scored items** per model (current version, same hash). |
| Benchmark comparison | Paired on identical items: **exact two-sided binomial (McNemar) test** on discordant items. | 6 discordant items; *better* only if p < 0.05. |
| General recommendation | Best pass rate among models with sufficient items. | *Enough evidence* only if it is significantly better than every other sufficiently tested model. |
| Latency | Median and 95th percentile of real (non-simulated) calls. | p50 needs 3 observations; p95 needs 20. |
| Cost per call | Mean of known costs. | Marked *partial* when some calls have no verified price. |
| Error rate | Errors / calls. | 10 calls. |
| Recency | Trial votes decay with a **90-day half-life**. | — |

Rankings are only used for ordering. Decisions always come from pairwise intervals or tests, so a 1–0 record never produces a recommendation.

## 6. Adapting to model versions

- Every call records `servedModel`, the model string the provider returns in the response (for example a dated snapshot behind an alias). Streaming emits it as a `served` event.
- The **current version** of a model id is the most recently observed served string.
- **Benchmarks** are pooled within the current version only. Results from older versions are excluded from the measurement and counted as *prior observations*.
- **Trial votes** from older versions count at **0.5 weight** (in addition to time decay), so preferences carry over cautiously instead of resetting or silently mixing.
- **Drift detection:** when the same test-set hash was run on the previous and current version, a paired exact test on per-item pass/fail flags *Behaviour changed* (p < 0.05, ≥ 6 discordant items), *no detectable change*, or *insufficient*.
- **Model-list sync** (`/api/intel/sync`) compares the registry with each provider's `/v1/models`. Registry models the provider no longer lists are flagged as renamed or retired, and new provider models are listed for review.

## 7. Model routing and fallbacks

`planRoute` (`src/lib/intel/routing.ts`):

1. **Classify** the prompt into a category (coding, research, writing, analysis, extraction, general). This extends the existing transparent rules router.
2. **Hard constraints** filter models, and each exclusion gets a stated reason:
   - availability and allowed providers;
   - *require no training on API data* (unverified counts as failing);
   - maximum retention days;
   - maximum blended price (unpriced models are excluded when a limit is set);
   - maximum observed p50 latency.
3. **Choose:** the user's evidence for that category in their preferred order (personal first, or benchmarks first): *clear* evidence first, then *tentative* (flagged as provisional). Otherwise the published rules pick.
4. **Fallbacks:** up to 3 remaining eligible models, **other providers first** so a single outage doesn't take out the chain, then by fingerprint rank.
5. **Execution** (`generateWithFallback`): retries the next model on timeout, rate limit, provider error or missing configuration, but not on bad requests. A per-provider **circuit breaker** opens after 3 failures in 60 seconds and stays open for 30 seconds. Every attempt is returned to the UI, and calls that succeed after a fallback are tracked with `fallback_from`.

## 8. Usage tracking

`recordRun` now stores `purpose` (chat, search, compare, trial, benchmark, claims, hypotheses, route), `category`, `served_model` and `fallback_from` on every call, alongside tokens, latency, status and estimated cost. History aggregates 30 days by model. Usage feeds latency and error figures in the fingerprint.

## 9. Privacy considerations

- **Data-handling profiles default to "Not verified".** Provider policies change and depend on account tier and contract, so Orbis does not ship claims about them. Operators record confirmed facts with source URL and date in `NOVA_PRIVACY_PROFILES`, and the router can require them.
- Trial and benchmark records (which include prompts) are private to the user via RLS and can be deleted individually or exported.
- Prompts are hashed (`promptHash`) so identical prompts can be compared without exposing text in aggregates.
- Guests' evaluation data stays in their browser. The routing planner receives it only when it is used, and it is not stored.
- Redaction in blind trials only affects display. Stored outputs keep the original text and are not retained beyond the record the user keeps.

## 10. Provider APIs and pricing data: sourcing and validation

| Data | How it is obtained | How it is validated |
|---|---|---|
| Model lists | On demand from provider APIs: OpenAI-compatible `GET {OPENAI_BASE_URL}/models`, Hugging Face `GET https://router.huggingface.co/v1/models`. | Diffed against the registry: missing → *renamed/retired?*, new → *available, not in registry*. |
| Served versions | The `model` field in every chat-completion response (streaming and non-streaming). | Observed, not configured. Changes trigger version partitioning and drift checks. |
| Prices | **Entered by the operator**, never scraped: the `model_registry` table (`input_price`, `output_price`, `price_source_url`, `last_verified_at`) or `NOVA_MODELS`. Hugging Face's router lists per-host prices; these are **shown for comparison only** and must be copied in with a source to take effect. | `validatePrice` flags: missing price; outside the $0.001–$500 per 1M sanity range (likely per-1K vs per-1M unit typos); output cheaper than input; no source URL; no verification date; **stale after 45 days**. `priceChangeNeedsReview` flags changes over 50%. `model_price_history` logs every change. |
| Costs | Provider-reported token counts × verified price. Tokens are estimated (~4 chars per token) and labelled *(est.)* only when the provider omits usage. | `reconcile(estimated, billed)` compares against provider billing exports for a period (±5% tolerance → *match*, otherwise *investigate*). Unknown prices show as n/a, never 0. |
| Context windows | Vendor model cards (`contextWindow`), labelled *vendor-stated*. | Re-verified with the price; the Models API can be used where available. |
| Privacy | Operator-verified profiles (see §9). | `verifiedAt` and `sourceUrl` are shown next to each value. |

## 11. User flows

1. **First visit:** Fingerprint shows "No evaluation data yet" with links. No recommendations are invented.
2. **Learn your preference:** Blind Trials → pick a category and a real prompt → read A and B → vote (optionally rate) → reveal. Repeat until pairs pass 10 trials; the Fingerprint card moves from *Not enough data* to *Tentative* or *Enough evidence*.
3. **Measure performance:** Benchmarks → choose a set and model → run → per-item results. Run other models on the **same set**. Once each has 20 items, paired tests decide whether one is better.
4. **Route:** Fingerprint → Routing planner → prompt and constraints → plan (category, primary, basis, sufficiency, reasons, exclusions, fallbacks) → optionally **Plan and run** to see attempts and the answer.
5. **Model update:** the provider changes the served snapshot → the directory shows the new version → benchmarks for the model restart for the new version, older votes are down-weighted → re-running the same set shows a drift verdict.
6. **Audit:** History → delete unwanted evidence, export JSON, and check usage and fallbacks.

## 12. Evaluating the evaluation system

- **Unit tests** cover the statistics (Wilson, exact binomial, Bradley–Terry, quantiles, decay), every checker, test-set hash stability, redaction, gating thresholds (insufficient, tentative, clear), version partitioning and drift, routing constraints and fallback ordering, and price validation and reconciliation.
- **Route tests** check that identities are absent from blind responses before the vote, tampered tokens are rejected, demo results are labelled, and benchmark runs are hashed.
- **Simulation check (recommended before tuning thresholds):** generate synthetic votes from known true preference rates (for example 50%, 60%, 75%) and confirm that (a) at 50%, *Enough evidence* is reported in ≤ 5% of simulated users, and (b) at 75%, it is reached within a reasonable number of trials. Adjust `minPairTrials` from these results, not from intuition.
- **Blinding check:** periodically ask users, after voting, which model they think A was. Guess accuracy near chance confirms blinding is working.
- **Checker audit:** sample failed items monthly and confirm the failures are real model errors, not checker brittleness. Fix the checker and bump the set version if not.

## 13. Known limitations

- The circuit breaker and rate limits are in-memory per server instance (same as the existing limiter).
- Code benchmarks test code *reading*. Executing model-written code needs a sandbox and is future work.
- Personal preference reflects the prompts a user chooses to try. The UI shows sample sizes so this is visible.
