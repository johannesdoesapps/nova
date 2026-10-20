-- ORBIS AI — the per-user usage lock is named after the product.
-- Every usage function takes pg_advisory_xact_lock(hashtextextended('<name>-usage:' || uid, 0))
-- so a user's reservations run one at a time. This rewrites that key to
-- 'orbis-usage:' in every function that takes it, all in this one
-- transaction, so they keep sharing the same lock. A database built from the
-- migrations already has this key; there the rewrite changes nothing.
do $$
declare
  f record;
begin
  for f in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.prosrc ~ 'hashtextextended\(''[a-z]+-usage:'''
      and p.prosrc !~ 'hashtextextended\(''orbis-usage:'''
  loop
    execute regexp_replace(pg_get_functiondef(f.oid), 'hashtextextended\(''[a-z]+-usage:''', 'hashtextextended(''orbis-usage:''', 'g');
  end loop;
end;
$$;
