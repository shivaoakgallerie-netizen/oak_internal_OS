-- Fix Admin clear-chat for projects that reject DELETE statements without a WHERE clause.
-- This updates the function only; it does not execute a delete or remove existing messages.
begin;

create or replace function public.clear_team_chat()
returns bigint language plpgsql security definer set search_path='' as $$
declare v_admin uuid; v_deleted bigint;
begin
  select id into v_admin from public.team_users
  where auth_user_id=auth.uid() and is_active and role='admin' for update;
  if v_admin is null then raise exception 'Active Admin account required' using errcode='42501'; end if;

  -- Share the lock with sends: a concurrent message belongs wholly before or after this clear.
  perform pg_advisory_xact_lock(867,1);
  -- id is the primary key, so this explicit predicate matches every valid chat row.
  delete from public.team_chat_messages where id is not null;
  get diagnostics v_deleted=row_count;
  update public.team_chat_state set clear_revision=clear_revision+1 where id=1;
  return v_deleted;
end; $$;

revoke all on function public.clear_team_chat() from public,anon,authenticated;
grant execute on function public.clear_team_chat() to authenticated;
notify pgrst, 'reload schema';

commit;
