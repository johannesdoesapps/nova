-- Stable message order. A question and its reply are inserted in one statement
-- and share created_at (now() is the transaction time), so ordering by
-- created_at alone could show a reply above its question. `seq` records insert
-- order and breaks the tie: messages are read ordered by (created_at, seq).
-- Additive only: existing rows are numbered in their current physical order.
alter table public.messages add column if not exists seq bigint generated always as identity;

create index if not exists messages_conversation_created_seq_idx on public.messages (conversation_id, created_at desc, seq desc);
