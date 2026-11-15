-- Atomic claim for starting a delegated task, so a double-submitted proposal (double-click, client retry,
-- replayed request) can only start once and isn't billed twice. The route inserts the proposal id here before
-- starting; a second concurrent request hits the primary-key conflict and is refused. A failed start deletes its
-- claim so the user can try again.
create table if not exists delegated_starts (
  proposal_id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table delegated_starts enable row level security;

drop policy if exists delegated_starts_own on delegated_starts;
create policy delegated_starts_own on delegated_starts
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
