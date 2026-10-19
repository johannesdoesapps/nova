-- Allow xAI (Grok) models in the admin-managed model registry, and index the
-- workforce settings' updated_by foreign key (Supabase performance advisor).
alter table public.model_registry drop constraint if exists model_registry_provider_check;
alter table public.model_registry add constraint model_registry_provider_check
  check (provider in ('anthropic', 'openai', 'google', 'xai', 'deepseek', 'huggingface', 'demo'));

create index if not exists wf_settings_updated_by_idx on public.wf_settings (updated_by);
