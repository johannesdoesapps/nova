-- Share a chat by a read-only link. Off for every chat until its owner turns it on.
-- The link shows the chat as it was when it was shared (shared_until); later
-- messages stay private until the owner updates the link.
alter table public.conversations
  add column if not exists share_token text unique check (share_token is null or char_length(share_token) between 32 and 64),
  add column if not exists shared_until timestamptz;

-- Public read of one shared chat by its token. Runs as the table owner so
-- visitors without an account can read it, and returns only the title, the
-- time it was shared and the user/assistant messages up to then: never the
-- owner, the project, usage details or anything else.
create or replace function public.shared_conversation(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'title', c.title,
    'shared_at', c.shared_until,
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content, 'model_id', m.model_id, 'created_at', m.created_at) order by m.created_at)
      from public.messages m
      where m.conversation_id = c.id and m.role in ('user', 'assistant') and m.created_at <= c.shared_until
    ), '[]'::jsonb)
  )
  from public.conversations c
  where p_token is not null and char_length(p_token) between 32 and 64
    and c.share_token = p_token and c.shared_until is not null;
$$;

revoke all on function public.shared_conversation(text) from public;
grant execute on function public.shared_conversation(text) to anon, authenticated;
