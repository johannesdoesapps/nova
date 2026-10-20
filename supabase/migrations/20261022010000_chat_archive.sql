-- ORBIS AI — archived chats: hidden from the main list, kept until deleted.
alter table public.conversations add column if not exists archived_at timestamptz;
create index if not exists conversations_user_archived_idx on public.conversations (user_id, updated_at desc) where archived_at is not null;
