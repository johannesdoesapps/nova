-- NOVA AI — multi-model platform settings and agent conversation settings.

-- Administrators: managed with SQL or the Supabase dashboard, never from the app.
create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
create policy "admins_select_own" on public.admins for select to authenticated using (user_id = (select auth.uid()));

-- True when the current user is an administrator.
create or replace function public.is_admin()
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = (select auth.uid()));
$$;

-- One row of platform-wide AI settings (enabled models, default, Auto, fallback,
-- per-model usage units). It holds no secrets, so everyone may read it; only
-- administrators may change it. API keys stay in server environment variables.
create table public.app_settings (
  id smallint primary key default 1 check (id = 1),
  settings jsonb not null default '{}'::jsonb check (octet_length(settings::text) <= 200000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
create trigger app_settings_updated_at before update on public.app_settings
  for each row execute function public.set_updated_at();
alter table public.app_settings enable row level security;
create policy "app_settings_read" on public.app_settings for select to anon, authenticated using (true);
create policy "app_settings_admin_update" on public.app_settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
insert into public.app_settings (id) values (1);

-- Google Gemini models in the admin-managed registry.
alter table public.model_registry drop constraint if exists model_registry_provider_check;
alter table public.model_registry add constraint model_registry_provider_check
  check (provider in ('anthropic', 'openai', 'google', 'huggingface', 'demo'));

-- Custom agents: response style and how many earlier messages they remember.
alter table public.agents
  add column response_style text not null default 'balanced' check (response_style in ('concise', 'balanced', 'detailed')),
  add column history_limit int not null default 20 check (history_limit in (10, 20, 40));
create index app_settings_updated_by_idx on public.app_settings (updated_by);
