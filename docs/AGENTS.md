# AI Agents

Agents are specialized assistants. Each one has its own instructions, tools, model preference and conversation history. They sit next to the general chat in the studio and use the same sidebar, design and streaming pipeline.

| Route | What it shows |
| --- | --- |
| `/agents` | Browse, search, filter, create, edit, duplicate and delete agents |
| `/agents/[id]` | Chat with one agent; `?c=<conversation>` opens a past conversation |

## Built-in agents

Built-ins are defined in code (`src/lib/agents/builtins.ts`). Each has its own instructions, temperature, tools and starter prompts:

| Agent | Tools | Temperature | Behaviour |
| --- | --- | --- | --- |
| Research Agent | web search, file analysis | 0.3 | Cites sources as [n], separates facts from interpretation, lists open questions |
| Coding Agent | file analysis | 0.2 | Root cause first; code in fenced blocks; never claims to have run code |
| Writing Agent | file analysis | 0.7 | Keeps the author's voice; finished text first, then the changes |
| Data Analyst | file analysis, data analysis | 0.2 | Treats server-computed statistics as exact; states caveats |
| Creative Agent | none | 0.9 | Several distinct directions before refining one |
| General Assistant | web search, file analysis | 0.5 | Direct answer first; options and next steps |

Built-ins can't be edited or deleted. "Duplicate" or "Customize a copy" creates an editable custom agent.

## Custom agents

Every agent has these fields:
- id and name
- description
- instructions (20–8,000 characters)
- icon and accent colour
- default model
- capabilities
- up to 4 starter prompts
- created and updated timestamps

The fields are validated by one Zod schema (`src/lib/agents/schema.ts`). The browser (for inline errors) and the API use the same schema.

| Who | Where agents are stored |
| --- | --- |
| Signed in | Supabase table `agents`, with row-level security so only the owner can read or change them (`supabase/migrations/20261019000000_agents.sql`) |
| Guest, no accounts configured | This browser's `localStorage`, like guest chat history. The agent's settings are sent with each chat request, because the server has no copy. |
| Guest, accounts configured | Must sign in. The chat API returns 401. |

Deleting an agent deletes its conversations. In the database this is a foreign-key cascade.

## Conversations

Agent conversations live in the existing `conversations` and `messages` tables:
- `agent_id` links a conversation to a custom agent.
- `builtin_agent` links it to a built-in agent.
- A check constraint stops a conversation from belonging to two agents.
- The row-level security `WITH CHECK` stops anyone from attaching a conversation to someone else's agent.

The general chat list (`GET /api/conversations`) and the sidebar exclude agent conversations. `/api/chat` refuses to continue them.

Each agent has its own history: `GET /api/agents/[id]/conversations`, the clock menu in the agent header, a "New conversation" action, and titles taken from the first message. Rename and delete reuse `/api/conversations/[id]`.

## Execution: one shared service

Every turn goes through `POST /api/agents/chat` and then `runAgentTurn` in `src/lib/agents/execute.ts`:

1. **Identify the agent.** The id is either a built-in key or a custom agent's UUID, loaded under row-level security.
2. **Load its settings and the conversation history.** For guests, the history comes from the browser.
3. **`authorizeTurn` checks permissions before anything runs.** Attachments need `file_analysis`; `useWeb` needs `web_search`. Otherwise the request fails with a 400 that says how to fix it.
4. **Run only the tools that are authorized and configured:**
   - *Web search:* up to 15 seconds; the sources are sent to the client and given to the model to cite.
   - *Data analysis:* exact statistics computed for attached CSV/TSV files (`tools/csv-stats.ts`), capped at 20,000 rows and 50 columns.
   - Each tool emits a `tool` event, which appears as an expandable row above the reply.
   - A tool failure becomes a notice. The turn continues.
5. **Build the system prompt:**
   - NOVA's base rules come first.
   - Then the agent's name and its enabled tools.
   - Then the owner's instructions, inside `<agent_instructions>` tags. Tags inside them are escaped, so the instructions can't override the rules.
   - Tool results and attached files go inside `<tool_result>` and `<document>` tags, marked as untrusted.
6. **Stream the reply** from the provider: OpenAI, Hugging Face, or the labelled demo provider. The agent's temperature is used where the provider accepts it. Model timeout is 50 seconds.
7. **Save both messages** for signed-in users. The tools that ran and the sources are kept in `usage_metadata`. The run is recorded as `purpose: "agent"`.

Errors: anything that fails before streaming returns the usual JSON error. Anything that fails during streaming becomes an `error` event, and the UI shows it with a "Try again" button.

## Capabilities

`capabilityStatus()` (`src/lib/agents/capabilities.ts`) reports what this deployment can actually do. The API refuses to save an agent with a capability that isn't available. In the editor, those capabilities are switched off and labelled "Requires setup".

| Capability | Status |
| --- | --- |
| File analysis | Works. Text files are read as context. |
| Data analysis | Works. Statistics are computed on the server. |
| Web search | Works when `SEARCH_API_KEY` is set (Tavily or Brave). |
| Code execution | **Not implemented.** Needs a sandboxed runner; always shown as needing setup. |

None of the current tools takes an action outside the conversation. A future tool that does, such as sending, posting or writing, should go through the AI Lab's approval-gated executor, which already requires the user to confirm the exact payload.

## Demo mode

With no AI provider key, the demo provider writes an agent-aware template. It names the agent, quotes the first line of its role and lists its enabled tools, and it is marked "Simulated". Real tools still run in demo mode: for example, the data analysis statistics are real.

## Tests

- `tests/agents.test.ts`:
  - built-ins are genuinely different configurations;
  - the CSV statistics are exact;
  - capability reporting is honest;
  - validation messages are correct;
  - built-ins are read-only;
  - permission checks block disallowed tools;
  - the data tool really runs;
  - guests' custom agents work;
  - unknown agents are rejected;
  - instructions can't break out of their block.
- `tests/rls.test.ts`: agents are private, conversations can't be attached to someone else's agent, constraint checks work, and deleting an agent deletes its conversations.
