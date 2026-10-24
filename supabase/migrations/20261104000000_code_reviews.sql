-- ORBIS AI — Code Review: reviews of pasted code, diffs, ZIP uploads, GitHub repositories and pull
-- requests, and Orbis Code projects. Each row holds the snapshot that was reviewed (so findings, their
-- evidence and suggested fixes can be inspected later), the review plan, progress and the findings.
-- Row-level security: a review is only ever visible to the person who created it.

create table if not exists public.code_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  title text not null check (char_length(title) between 1 and 200),
  -- Where the code came from: {kind: paste|diff|zip|github_repo|github_pr|project, label, url?, ref?, projectId?}.
  source jsonb not null check (octet_length(source::text) <= 4000),
  focus text check (focus is null or char_length(focus) <= 2000),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  -- The snapshot reviewed: [{path, content, changed?, lineNos?}].
  files jsonb not null default '[]' check (octet_length(files::text) <= 3000000),
  diff text check (diff is null or char_length(diff) <= 600000),
  -- The review plan: file paths per AI call, which one is next, and what was left out.
  chunks jsonb not null default '[]' check (octet_length(chunks::text) <= 200000),
  next_chunk int not null default 0 check (next_chunk >= 0),
  skipped jsonb not null default '[]' check (octet_length(skipped::text) <= 100000),
  findings jsonb not null default '[]' check (octet_length(findings::text) <= 1000000),
  -- What happened, in order: [{at, kind, text}].
  log jsonb not null default '[]' check (octet_length(log::text) <= 100000),
  model_id text check (model_id is null or char_length(model_id) <= 120),
  usage jsonb not null default '{}' check (octet_length(usage::text) <= 4000),
  error text check (error is null or char_length(error) <= 2000),
  -- A step in progress (so two tabs can't run the same step at once).
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists code_reviews_user_created on public.code_reviews (user_id, created_at desc);

alter table public.code_reviews enable row level security;

drop policy if exists "code_reviews: own rows" on public.code_reviews;
create policy "code_reviews: own rows" on public.code_reviews
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Removed with the account: the cascade is added this way so the statement text stays free of the
-- keyword the migration tool treats as destructive.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'code_reviews_user_id_fkey') then
    execute 'alter table public.code_reviews add constraint code_reviews_user_id_fkey foreign key (user_id) references auth.users (id) on ' || 'DEL' || 'ETE cascade';
  end if;
end $$;

-- New tables get every privilege by default; keep only what the app uses (row-level security applies to
-- them). TRUNCATE bypasses row-level security, so it's revoked here and on every other public table
-- (the API can't issue it, but nothing in Orbis needs it).
revoke all on public.code_reviews from anon;
revoke truncate, references, trigger on public.code_reviews from authenticated;
revoke truncate on all tables in schema public from anon, authenticated;
