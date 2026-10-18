-- Allow DeepSeek models in the admin-managed model registry.
alter table public.model_registry drop constraint if exists model_registry_provider_check;
alter table public.model_registry add constraint model_registry_provider_check
  check (provider in ('anthropic', 'openai', 'google', 'deepseek', 'huggingface', 'demo'));
