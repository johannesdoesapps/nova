# Deep Research

`/research` (sidebar → Tools → Deep Research). Give it an objective, choose a depth (Quick: 2 questions, Standard: 4, Deep: 6) and, optionally, paste your own notes or a document. Orbis then:
1. **Plans**: breaks the objective into research questions (shown as the plan).
2. **Researches each question** with Claude's built-in web search. Anthropic runs the searches, and Claude's answer comes back with citations: for each passage, the page and the exact text it relied on.
3. **Writes the report**: Summary, Findings (one section per question), "Where sources disagree or are uncertain", and Recommendations or next steps. Citations appear as numbered chips that jump to the source.

Progress shows the plan with each question's searches and the current step. You can stop, continue, or "write the report now" from what's been found. History is kept per user (row-level security; tested). Exports: **Markdown** (report, sources with their quoted passages, and the method) and **Print or save as PDF** (a clean print page; the browser makes the PDF).

## Why the citations can be trusted (and their limits)

- A **source** is only a page Claude's web search returned *and* attached as a citation to a passage. Pages that were searched but not cited aren't sources. The exact quoted passages are stored and shown under each source.
- The writer may cite only those numbers. Citations to numbers that don't exist are removed from the report and counted. `[doc]` is allowed only when you gave a document.
- The page reports how many of the sources the report cites, and how many Findings paragraphs have no citation. A report without full support says so in amber.
- **Limit:** this checks that each citation points to a real, retrieved passage. It doesn't prove the sentence says what the passage says. The report is labelled AI-written and asks you to open sources for important claims.

## Safety

- Web pages, search results and your document are treated as untrusted data in every prompt: fenced, and the model is told never to follow instructions in them.
- Nothing in a research run can take an action.
- Links open in a new tab with `noopener`.

## Costs, limits and requirements

- **Models:** needs Claude (the Anthropic key is set). Sonnet plans the questions and writes the report (or the strongest Claude model the plan includes, if that's lower). The searches run on Claude Haiku, the cheapest Claude model, because each search step reads tens of thousands of tokens of web pages.
- **Web searches:** each research question uses one of the plan's monthly web searches (Free 0, Pro 50, Max 500). **Free can't use Deep Research**, and paid plans can't be bought until payments (Stripe) are set up in production. If searches run out mid-run, the report is written from the questions already done, and says so.
- **Charging:**
  - Each step is charged like a message of its size (Usage → "Deep research").
  - Each search is also billed by Anthropic at its published per-search price and recorded in the run's cost.
- **Duration:** a research question can take a minute or more. The step endpoint allows up to 5 minutes, and the search call times out after 4 minutes.
- **Rate limits:** 8 new runs per 10 minutes; at most 2 continuations of a paused search turn per question.

## Live test (24 October 2026, production)

Run on a test account with temporary Pro, a Quick research comparing the Neon and Supabase free tiers:

| Step | Model | Tokens in / out | Searches | Units | Cost |
| --- | --- | --- | --- | --- | --- |
| Plan | Sonnet 5.5 | 229 / 291 | 0 | 5.61 | $0.0034 |
| Question 1 | Sonnet 5.5 | 68,177 / 2,196 | 3 | 263.86 | $0.188 |

The second question was refused by Pro's 5-hour limit, and the run was marked failed with that reason (the failure path works). One search step on Sonnet used most of a Pro 5-hour window, so the searches were moved to Haiku (commit 5d9288b). **The Haiku version has not yet been run live**: the test account's 5-hour window was used up, so it was locked again and the re-run is scheduled for when the window resets. The expected cost of a Haiku search step is about a tenth of the Sonnet one, by list price; that is an estimate, not a measurement.

Also seen: the step reserved budget for 40,000 input tokens, but the search step used 68,177. The final charge was the real one; only the up-front reservation was low. It now reserves 70,000.

## Not built yet

- Uploading PDF/Word documents (paste text instead).
- Choosing sources or domains.
- Non-Claude providers' search (Tavily/Brave would need `SEARCH_API_KEY`).
- Sharing a report by link.
- Scheduled research.
