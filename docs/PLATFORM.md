# NOVA platform features

What each signature feature does, what it needs, and its honest limits.

| Feature | Where | Needs | Without it |
|---|---|---|---|
| Smart Router | Model menu → Smart Router (Auto, Quick, Deep, Research, Coding) | At least one AI key | Only the models you configured are ever chosen |
| Nova Council | `/council` | 2+ AI models configured | Works with a single provider's models (e.g. two OpenAI models) |
| Nova Arena | `/arena` | 2+ AI models configured | — |
| Mission Control | `/missions` | Supabase accounts (sign-in) | Page asks the visitor to sign in |
| Truth Layer | Shield button under any AI reply | `SEARCH_PROVIDER` + `SEARCH_API_KEY` (Tavily or Brave) | Claims are listed by type and marked **Not verified** |
| Council web sources | Toggle on `/council` | `SEARCH_PROVIDER` + `SEARCH_API_KEY` | Toggle is disabled with the reason shown |
| Research router mode | Model menu → Auto · Research | Search key for live sources | Answers without sources and says so |
| Command palette | Ctrl+K / ⌘K anywhere in the studio | — | — |
| Security Team | `/agents/security` | Accounts (sign-in); optional ABUSEIPDB_API_KEY, GITHUB_TOKEN | See docs/SECURITY_AGENTS.md |

## Smart Router
Auto ids are `auto` (balanced) and `auto:quick|deep|research|coding`. Each mode narrows
the pool of configured models (low-cost, reasoning, coding), then routes by task type.
When a user is close to their usage limit, Auto prefers low-cost models and says so.
The reason for every choice is shown under the reply.

## Nova Council
1. Each selected model answers independently, in parallel (`/api/council/answer`).
2. Deep mode: each model reviews the anonymised answers ("Response A/B…") (`/api/council/critique`).
3. A chair model writes a synthesis listing agreements, disagreements and what needs checking (`/api/council/synthesize`).

Every step shows the model, latency, tokens and estimated cost. A failed model doesn't stop
the others and can be retried on its own. Sessions are saved per user (`council_sessions`, RLS).

## Nova Arena
Blind mode hides model names until you reveal them. Rate 1–5, pick a winner, ask any
model to improve its answer, or get a comparison summary. Ratings are saved with the session.

## Mission Control
A goal becomes an editable AI plan (milestones → tasks with priority and an "AI can draft
this" flag). Nothing is saved until you press Create. Tasks can be drafted by any model;
every attempt is logged in `task_runs`. The AI never marks tasks complete — you do — and it
is told it cannot take real-world actions. Drafts can be edited and saved to mission notes.

## Truth Layer
`POST /api/verify` splits an answer into claims (fact, statistic, cause, prediction,
comparison, definition, opinion), runs one web search, and judges each claim against the
results. A model's judgement only counts when its quote is found word-for-word in a source.
Results are based on search snippets, not full articles, and say so.

## Later phases (not built yet)
Knowledge Graph, Flow (visual workflows), Live Workspace, Context Handoff between models,
Learning Engine, Prompt Doctor, Time Machine (conversation branching), Command Center
dashboard, Privacy Center, theme/accent customisation. Several build on pieces that already
exist (projects, notes, claim reports, usage records).
