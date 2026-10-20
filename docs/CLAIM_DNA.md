# Part 4 — Claim DNA & Research Intelligence

Claim DNA is Orbis's evidence-centred layer. It turns an answer or report into
discrete claims, links each claim to the evidence Orbis can actually see, and
records how every judgement was made so it can be inspected, challenged and
replayed.

**Ground rule:** nothing in Claim DNA is presented as truth. A status describes
the relationship between a claim and the supplied sources. Every judgement
names its author (keyword rules, a model, or the user). The only number shown
is a heuristic, labelled as one, with its formula one click away.

Code: `src/lib/claims/*` (pure TypeScript that runs on the server and in the
browser), `src/app/api/claims/*`, `src/components/research/*`, and the migration
`supabase/migrations/20261018010000_claim_dna_model_intelligence.sql`.

---

## 1. Screens

| Route | Screen | Purpose |
|---|---|---|
| `/claims` | **Claim DNA workspace** | Paste an answer and its sources, or arrive from AI Search with **Check claims**. Choose *Rules only* (free, deterministic) or *Rules + model judgement*. Includes a fictional example. |
| `/claims` (report) | **Report view** | Summary headline and status counts. Warnings for snippet-only or missing sources. A *How to read this* explainer. The answer with each claim underlined by status. Six workflow tabs. A claim detail panel. A source list. |
| (drawer) | **Source inspector** | Full text Orbis checked against, with the quote highlighted. Type, date, content kind, content hash. Reliability indicators (facts, not a score). Provenance timeline. Link to the original. |
| `/claims/arena` | **Hypothesis Arena** | Competing explanations, each with editable predictions. A standings table, a verdict box, evidence recording, and suggested claims from a linked report. |
| `/claims/replay` | **Research Replay** | Timeline of recorded steps (actor, determinism, hashes, duration, output snapshot). Exact replay, what-if replays (leave sources out) and, for model runs, a live re-run. Shows step-by-step diffs and which conclusions changed. |

### Claim detail panel (the core interaction)
- Claim text, id, **status**, **evidence basis** (direct / AI inference / not backed), kind (factual, statistical, causal, predictive, comparative, definitional, opinion), origin (cited, labelled as inference, uncited).
- **Limitations of this check**: always shown when any apply. Examples: snippet-only, single publisher, undated, old figures, indirect evidence, mis-citation, a discarded model judgement, keyword-rule caveats, informal sources.
- **Evidence match** meter: three-step band (weak / moderate / strong) plus the caveat. *Show how this was computed* reveals the raw 0–1 value ("not a percentage chance") and the exact formula.
- **Evidence list**: stance, who judged it, direct/indirect, whether the answer cited it, term overlap, and the quote. A quote is struck through and marked *quote NOT found in source* when it fails verification. Includes the rationale, an *inspect source* link, and *Your review* buttons (Supports / Conflicts / Doesn't settle it).
- **Evidence that would help**: what kind of evidence would settle the claim, plus one-click searches.

## 2. Data structures

Defined in `src/lib/claims/types.ts`. Summary:

```ts
SourceRecord {
  id: "S1", index: 1, url, title, publisher, author, publishedAt, retrievedAt,
  contentKind: "snippet" | "full_text" | "user_pasted",
  text, contentHash,
  reliability: { sourceType, hasDate, ageDays, https, contentKind, textLength, flags[] },
  provenance: [{ at, actor: "search_provider"|"user"|"nova"|"model", action, detail }]
}

Claim {
  id: "C3", index, text, span: {start,end},
  kind, origin: "cited"|"ai_inference"|"uncited", hedged, citedSourceIds[],
  evidence: EvidenceLink[],
  assessment: {
    status: "supported"|"partially_supported"|"contested"|"contradicted"|"insufficient"|"not_checkable",
    basis: "direct"|"inference"|"none",
    supporting, contradicting, independentSupportingPublishers,
    estimate: { value, band, method, judgedBy, caveat } | null,
    limitations[], explanation[]
  }
}

EvidenceLink {
  id: "C3-S1", claimId, sourceId,
  stance: "supports"|"contradicts"|"insufficient", directness: "direct"|"indirect",
  quote, quoteStart, quoteVerified, relevance, cited,
  judgedBy: "rules"|"model"|"user", rationale, rulesStance?   // previous judgement kept for audit
}

ClaimReport { id, version: "claim-dna/1", question, answer, createdAt, mode, modelId,
              sources[], claims[], summary, reviews[], modelJudgements[], replay: ReplayLog }

ReplayLog { pipelineVersion, config: { mode, modelId, now },
            events: [{ seq, step, actor, description, inputHash, outputHash, output,
                       deterministic, durationMs, model?: { id, servedModel, temperature, promptHash } }] }

Arena { id, question, reportId, hypotheses: [{ id, label, statement, origin,
        predictions: [{ id, expectation, test, status, evidence: [{ claimId?, note, stance, addedBy }] }] }] }
```

Storage: `claim_reports` holds the full report as JSONB plus `summary`. `hypothesis_arenas` holds arenas. Both are protected by RLS so users can only see and change their own. Guests keep up to 20 reports and 30 arenas in `localStorage`.

## 3. Pipeline (deterministic)

`runClaimPipeline(input)` in `src/lib/claims/pipeline.ts`. Each step is recorded by `ReplayRecorder`:

1. **input**: question, answer and source count.
2. **source_ingest**: `buildSource` classifies publisher type by domain (government, academic, preprint, reference, news, blog/forum, unknown, user-provided). It computes age and flags, fingerprints the content and starts the provenance trail.
3. **claim_extraction**: strips Markdown and the follow-ups block. Splits into sentences, protecting abbreviations and decimals. Splits compound sentences at citation boundaries (`X [1], and Y [2]` becomes two claims). Drops questions and meta text. Parses `[n]` citations, detects inference labels and inference language, and classifies the claim's kind and hedging.
4. **evidence_linking**: for every claim × source, finds the best passage (single sentences and two-sentence windows) by IDF-weighted term coverage. Then:
   - *contradicts* if relevance ≥ 0.45 and there is a numeric mismatch (same unit, different value) or a polarity mismatch (antonym pairs, or negation on one side only);
   - *supports* if relevance ≥ 0.60 and the claim's figures appear in the passage; *direct* if relevance ≥ 0.75;
   - *insufficient* otherwise. A cited source always gets a link, so mis-citations are visible.
5. **model_judgement** (model mode only, marked non-deterministic): the model returns `{claimIndex, sourceIndex, stance, quote}` JSON. A judgement **counts only if its quote is found verbatim** (case- and whitespace-insensitive) in the source. Otherwise it is kept for inspection and downgraded to *insufficient*. Sources are delimited and treated as untrusted (prompt-injection hardening).
6. **user_review**: user verdicts override earlier judgements. The previous stance is kept in `rulesStance`.
7. **assessment**: the status rules are
   - opinion with no evidence → `not_checkable`
   - supports and contradicts → `contested`
   - contradicts only → `contradicted`
   - supports with a direct link → `supported`; supports with indirect links only → `partially_supported`
   - nothing → `insufficient`. The UI calls this "No evidence found" and adds "It may still be true".
8. **summary**: counts and headline.

**Evidence match estimate:** `0.20 + 0.35×best relevance + 0.12×independent publishers (max 3) + 0.08 if direct − 0.22×contradictions`. It is clamped to 0.03–0.90 and **capped at 0.69 when only snippets were read**, so snippet evidence never reaches "strong". It is shown as a band. It is never shown for opinions and never called a probability.

## 4. Workflows

| Workflow | Function | What it answers |
|---|---|---|
| Fact-check queue | `factCheckQueue` | Every claim, worst first (contradicted → contested → no evidence → partial → supported → opinion). |
| Unsupported statements | `unsupportedStatements` | Assertions with nothing in the sources (opinions excluded). |
| Conflicting sources | `conflicts` | Claims where sources disagree, with quotes on each side and the reason for the conflict. |
| Missing evidence | `missingEvidence` | For weak or unsupported claims (and supported claims with only one publisher), the *kind* of evidence that would settle it plus suggested searches. Statistical → primary dataset; causal → controlled study; predictive → dated forecast and track record. |
| Direct vs inference | `directVsInference` | Three groups: stated by a source, inferred or interpreted, and not backed. |
| Mis-citations | `misCitations` | The answer cites a source whose text does not appear to contain the claim. |

## 5. User flows

1. **From search:** AI Search answer → **Check claims** → the answer and its retrieved snippets are handed over (sessionStorage, never persisted) → **Analyse** → work through the fact-check queue → inspect sources → review judgements. Each review re-runs the pure pipeline in the browser and saves.
2. **Paste & check:** paste any report and source texts, then follow the same flow. User-pasted sources are labelled as such in provenance.
3. **Model-assisted:** choose *Rules + model judgement*. Rules always run as well, and model judgements show as "Model judgement" with verified or unverified quotes. Demo mode, a model failure or unparseable output falls back to rules with a visible notice.
4. **Hypothesis Arena:** from a report → **Compare explanations** → start from a labelled template or generate with a model → edit hypotheses and predictions → record evidence (free text, or accept a suggested claim from the report) → read the standings.
5. **Research Replay:** from a report → **Replay this analysis** → *Replay exactly* (frozen: recorded inputs, clock and model outputs) → expect "every step reproduced". Then leave out a source → re-run → see the first divergent step and which claims changed status. For model runs, *Live re-run* calls the model again to measure how stable its judgements are.

## 6. Hypothesis Arena rules

- Each hypothesis has predictions written as "If true, we should observe…" with a test.
- A prediction is **discriminating** when no rival hypothesis has a near-identical prediction (≥ 70% key-term overlap means it is shared). Testing shared predictions cannot separate hypotheses.
- Prediction status comes from the evidence attached to it. Possible values: untested, consistent, inconsistent, ambiguous.
- Hypothesis standing: untested, unrefuted, weakened or mixed.
- **Verdict:** no leader is named until at least 2 discriminating predictions are tested. A leader is named only when it is the *only* unrefuted hypothesis and every rival has at least one inconsistent result, and even then it is called "provisional".
- There are no probabilities. Suggested evidence (term overlap with report claims) is never applied automatically.

## 7. Evaluation methods

How to tell whether Claim DNA works, and keep it honest:

| Aspect | Method | Target / guardrail |
|---|---|---|
| Claim segmentation | Annotate 100 answers into atomic claims and compare boundaries (precision/recall of claim spans). | Track compound-sentence misses; citation-boundary splitting is covered by unit tests. |
| Evidence linking | Labelled claim–passage pairs (supports / contradicts / insufficient) from real search sessions. Report a confusion matrix **per judge** (rules vs model). | The most important error is *false "supported"*. Optimise for its precision before overall accuracy. |
| Contradiction detection | Seeded test set: numeric changes, direction flips, negations. | Numeric and polarity rules are unit-tested; measure recall on real data. |
| Quote verification | Count model judgements with unverifiable quotes per model version. | Every unverified quote is discarded, which bounds hallucinated support at 0. |
| Calibration of the estimate | Bin claims by band and measure how often human reviewers agree the evidence supports the claim. | Bands must be monotonic. If not, change the formula, not the label. The value is never relabelled as truth. |
| Mis-citation detection | Answers with citations deliberately swapped. | Recall of swapped citations. |
| Replay | `tests/claims.test.ts` checks that a rules-mode report reproduces every step hash, and that a changed source is reported as the first divergence. | CI must stay green; bump `CLAIM_DNA_VERSION` on any pipeline change. |
| User reviews | Rate of user overrides by original judge and stance. | High override rates on a judge or stance flag a weak rule. |
| UX honesty | Review copy: no screen may show a confidence number without its caveat, or a status called "true/false". | Enforced in `EstimateMeter` and the status vocabulary. |

## 8. Known limitations

- Rule-based stance detection is lexical. It misses paraphrase, sarcasm and subtle hedging. Model mode helps, but only within quote verification.
- AI Search provides snippets, not full pages. Reports say so prominently and cap the estimate.
- Source-type classification uses domain lists, which are incomplete; anything unrecognised is shown as "unknown".
- Arena evidence is user-recorded. Orbis does not run the tests the predictions describe.
