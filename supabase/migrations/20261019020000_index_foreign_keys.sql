-- Performance advisor: cover every foreign key with an index so cascading
-- deletes and joins don't scan whole tables as data grows.
create index if not exists claim_reports_search_session_idx on public.claim_reports (search_session_id);
create index if not exists conversations_agent_fk_idx on public.conversations (agent_id);
create index if not exists hypothesis_arenas_claim_report_idx on public.hypothesis_arenas (claim_report_id);
create index if not exists hypothesis_arenas_project_idx on public.hypothesis_arenas (project_id);
create index if not exists model_runs_conversation_idx on public.model_runs (conversation_id);
create index if not exists project_notes_user_idx on public.project_notes (user_id);
create index if not exists radar_tasks_project_idx on public.radar_tasks (project_id);
