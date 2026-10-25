# Mimic

**Show it once. It learns. It does it for you.**

Mimic learns a task from one demonstration and repeats it with checks and your oversight. The first supported task is supplier-invoice processing. It's in the sidebar as **Mimic** (`/mimic`).

Written 25 October 2026 against the code on branch `mimic`.

## 1. What's built

| Area | Built | Notes |
| --- | --- | --- |
| Dashboard | Yes | All figures come from real runs and drafts. Time saved is labelled an estimate and explains its basis. |
| Teach Mimic | Yes | A practice desk with an invoice and the Demo Books form. Recording is visible and can be stopped, reviewed or discarded. |
| Structured workflow | Yes | Learned from the demonstration's events: which value went into which field, and which label it sat next to. Never coordinates. |
| Review and edit | Yes | Steps, mode, trigger, automatic limit and answers to Mimic's questions. Safety steps can't be turned off. |
| Test run | Yes | Shows what Mimic would read, check and create. Nothing is saved. Required before an automation can be turned on. |
| One working automation | Yes | Supplier invoice → draft transaction in **Demo Books**, Mimic's built-in practice ledger (clearly labelled; not a real accounting system). |
| Invoice extraction | Yes | Text invoices: learned labels first, then general labels, then (optionally) AI. AI answers are kept only if found word for word in the document. |
| Validation and duplicates | Yes | Required fields, net + tax = total, date order, expected currency. Duplicates are checked by supplier and invoice number (confirmed) or supplier, total and date (probable). |
| Human approval | Yes | Three modes: Assist, Supervised (default) and Automatic, with a limit. "Needs my attention" collects approvals, missing details, uncertain categories and failures. |
| Learning from corrections | Yes | A category correction asks "only this invoice" or "always for this supplier". Only "always" creates a rule. Rules have a history and can be edited or removed. |
| Execution history | Yes | Every run, with every step's result. The audit log can't be edited and separates proposed, approved, completed, failed and rejected actions. |
| Integrations page | Yes | Says honestly what's connected (Demo Books, the inbox, optional AI reading) and what isn't. |
| Security | Yes | Row-level security on every table. Document text is treated as data. Emergency stop. Delete all data. |
| Mimic Observer | No | Needs observation outside the browser; see section 7. |
| Bank reconciliation, payment reminders, reports | No | Need a real accounting or bank connection. |
| Real accounting software | No | No Xero, QuickBooks or Bexio connector exists. Mimic doesn't pretend to write to one. |
| PDF and image invoices (OCR) | No | Text only (paste or `.txt`) for now. |

## 2. How it works

### The user journey

1. **Teach Mimic** → pick a sample invoice → **Teach Mimic** starts recording.
2. Select a value in the invoice and choose the field it belongs in, or type into the form. Then:
   - search for duplicates;
   - choose a category;
   - **Save draft** (practice only; nothing is written);
   - optionally open the saved draft.
3. **Stop and review**. The list shows what Mimic saw. **Create the automation**.
4. Review the automation:
   - answer Mimic's questions (for example, whether a category applies to every invoice from that supplier);
   - check the steps;
   - pick a mode.
5. **Test run** on another invoice. Nothing is saved.
6. **Turn on**. This is refused until every question is answered and a test has run.
7. Run it from **Run now**, or set it to run **when an invoice is added** to the inbox (Accounting tab).
8. Approve or correct the run in **Needs my attention**. The draft appears in Demo Books, and every step is in **Activity**.

### Architecture

Understanding and execution are separate, and the pure modules have no I/O:

| Module | Job |
| --- | --- |
| `src/lib/mimic/types.ts` | Fields, the chart of accounts, demonstration events (zod), the workflow definition, run results |
| `src/lib/mimic/extract.ts` | Reads invoices: labels, amounts (`1'234.50`, `1.234,50`), dates (flags day/month ambiguity), currencies, evidence lines; spots instruction-like text |
| `src/lib/mimic/learn.ts` | Demonstration → workflow and questions |
| `src/lib/mimic/validate.ts` | Checks and duplicate detection; the invoice key |
| `src/lib/mimic/engine.ts` | Runs a workflow on one invoice. The only side effect goes through a `LedgerPort` |
| `src/lib/mimic/samples.ts` | Seven fictional sample invoices, each covering a scenario |
| `src/lib/mimic/server.ts` | Storage, runs, approvals, rules, the inbox trigger, settings, the audit log, the optional AI reader |
| `src/app/api/mimic/**` | API routes |
| `src/components/mimic/*` | The page: dashboard, practice desk, workflow review, run cards |
| `supabase/migrations/20261108000000_mimic.sql` | Tables and row-level security |

**Technology:** everything uses what Orbis already has: Next.js, Supabase (Postgres with row-level security), zod, and Orbis's model router and metering for the optional AI reader. No new services, no model training.

### How a run decides whether to write

1. **Emergency stop on** → nothing runs. Test runs still work.
2. The document is read. Instruction-like text ("ignore previous instructions", "new bank details" and similar) is flagged and never followed.
3. Duplicates, then validation, then category, which comes from an approved rule or the user, never a guess.
4. Any problem → **Needs my attention**, and nothing is written.
5. If there's no problem, what happens depends on the mode:
   - **Test** → reports what it *would* create.
   - **Assist** → prepares the draft; the user creates it.
   - **Supervised** → waits for approval.
   - **Automatic** → creates the draft only if all of these hold:
     - the total is under the limit;
     - there are no warnings;
     - no suspicious content;
     - the step isn't marked "ask me".
6. Before writing, the draft is looked up by its **invoice key** (supplier + invoice number). If it exists, an earlier attempt succeeded, so nothing new is written. The database enforces the same key with a unique index.
7. The draft is read back and compared field by field. A mismatch is reported as a failure.

## 3. Running it

- **Locally:** `npm run dev`, sign in, open `/mimic`. It needs Supabase configured and the migration applied.
- **Tests:**
  - `npx vitest run tests/mimic.test.ts` — engine scenarios.
  - `npx vitest run tests/mimic-db.test.ts` — end to end through the server code on the real migrations, with row-level security, in PGlite.

## 4. Setup

1. **Apply the migration** `supabase/migrations/20261108000000_mimic.sql` to the Supabase project. Until then, the page says the tables aren't set up.
2. Nothing else is required. AI reading uses the AI providers Orbis already has. It can be turned off per user in Mimic's Settings, and its usage is recorded as purpose `mimic`.

## 5. Tests and results

`tests/mimic.test.ts` (20 tests) and `tests/mimic-db.test.ts` (8 tests) cover the brief's scenarios:

- a successful demonstration;
- an incomplete demonstration (no save, missing required fields);
- a changed layout (same supplier, fields in another order, supplier under "From:");
- labels Mimic has never seen ("Issued:"), learned from the demonstration;
- missing invoice fields, with a correction;
- wrong amounts (net + tax ≠ total);
- duplicate documents (confirmed and probable);
- an unexpected currency;
- an ambiguous category (new supplier): it asks; "only this invoice" doesn't create a rule;
- repeated triggers (no second draft; the same inbox document can't be added twice);
- partial failures: the write fails, or the saved draft doesn't match on read-back;
- recovery after an interruption: the draft exists but the run wasn't recorded, so the retry finds it and doesn't duplicate;
- unauthorised actions:
  - Automatic mode over the limit;
  - an "always ask" step;
  - Assist mode;
  - the emergency stop;
  - another user's runs and workflows (row-level security);
- malicious instructions in a document: flagged, never acted on, even in Automatic mode;
- AI readings not present in the document: discarded;
- the audit log can't be edited;
- deleting all data.

All 28 pass. Not tested against production yet: the migration isn't applied there.

## 6. Security

- **Row-level security** on all seven tables. The audit log is read, append and delete only, with no update.
- **No credentials.** Mimic stores none, so nothing needs sealing. Future integrations would use Orbis's connector framework, which seals tokens with `ORBIS_CONNECTOR_KEY`.
- **Least data.** Demonstrations record field values and the labels next to them, not screens, keystrokes or anything outside the practice desk.
- **Untrusted input.** Document text never becomes instructions:
  - the AI reader gets it inside `<document>` tags and is told so;
  - its output is validated against the document itself.
- **Explicit authority.** Every write is a draft in the practice ledger:
  - no posting, payments, email or tax filing;
  - Automatic mode is bounded by a per-workflow limit;
  - a workflow can only create drafts, so it can't be used for anything else.
- **Emergency stop** on every Mimic page, and **Delete all Mimic data** in Settings.

## 7. Known limitations

- **No desktop or whole-browser observation.** Orbis is a web app; Mimic learns on its own practice desk. Learning in other apps would need a browser extension or a desktop agent.
- **One task type.** Supplier invoices → draft transactions. The learner is specific to the practice desk's form.
- **Text invoices only.** No PDF text extraction or OCR.
- **Demo Books only.** There's no real accounting system.
- **Triggers.** Manual, or "invoice added to the inbox". There's no email inbox watching and no schedules, so no background worker.
- **Unused retention setting.** The retention column exists, but there's no automatic purge yet. Deletion is manual.

## 8. Next tasks, in order

1. Apply the migration, then test the full journey live on a test account.
2. PDF text extraction for uploaded invoices.
3. A real accounting integration (pick one: Bexio for Switzerland, or Xero) as a connector, with draft-only writes and the same approval cards.
4. An email trigger through the existing Gmail and Outlook connectors (read-only), using the Security Team's per-user scheduler pattern.
5. Payment reminders, as drafts: approval before sending, never automatic at first.
6. Bank reconciliation suggestions: confirmed versus probable matches, never inventing data.
7. Generalise the practice desk to other forms (customer registration, order entry) before attempting a browser extension for Mimic Observer.
