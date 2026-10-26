-- Permit an authenticated active Admin to clear the one shared chat room.
-- Per-user access and the existing request/employee records are unchanged.
begin;

create table if not exists public.team_chat_state (
  id smallint primary key check(id=1),
  clear_revision bigint not null default 0 check(clear_revision>=0)
);
insert into public.team_chat_state(id) values(1) on conflict(id) do nothing;

alter table public.team_chat_state enable row level security;
revoke all on public.team_chat_state from public,anon,authenticated;
grant select on public.team_chat_state to authenticated;
grant all on public.team_chat_state to service_role;
drop policy if exists team_chat_state_active_read on public.team_chat_state;
create policy team_chat_state_active_read on public.team_chat_state for select to authenticated
  using (public.is_staff());

create or replace function public.clear_team_chat()
returns bigint language plpgsql security definer set search_path='' as $$
declare v_admin uuid; v_deleted bigint;
begin
  select id into v_admin from public.team_users
  where auth_user_id=auth.uid() and is_active and role='admin' for update;
  if v_admin is null then raise exception 'Active Admin account required' using errcode='42501'; end if;

  -- Share the lock with sends: a concurrent message belongs wholly before or after this clear.
  perform pg_advisory_xact_lock(867,1);
  delete from public.team_chat_messages;
  get diagnostics v_deleted=row_count;
  update public.team_chat_state set clear_revision=clear_revision+1 where id=1;
  return v_deleted;
end; $$;
revoke all on function public.clear_team_chat() from public,anon,authenticated;
grant execute on function public.clear_team_chat() to authenticated;

-- Active readers use this revision to refresh after a clear, including missed Realtime events.
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='team_chat_state') then
    alter publication supabase_realtime add table public.team_chat_state;
  end if;
end $$;

commit;
