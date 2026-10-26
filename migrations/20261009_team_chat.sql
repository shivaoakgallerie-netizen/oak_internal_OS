-- Shared company chat for every active Admin/Staff account, including future users.
-- Apply after the secure Admin/Staff migration. Existing work is not changed.
begin;
create table if not exists public.team_chat_messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references public.team_users(id) on delete restrict,
  client_message_id uuid not null,
  body text not null check (char_length(btrim(body,E' \n\r\t')) between 1 and 2000),
  created_at timestamptz not null default clock_timestamp(),
  unique(sender_id,client_message_id)
);
create index if not exists team_chat_sender_time_idx on public.team_chat_messages(sender_id,created_at desc);
alter table public.team_chat_messages enable row level security;
revoke all on public.team_chat_messages from public,anon,authenticated;
grant select on public.team_chat_messages to authenticated;
grant all on public.team_chat_messages to service_role;
grant usage,select on sequence public.team_chat_messages_id_seq to service_role;
drop policy if exists team_chat_active_read on public.team_chat_messages;
create policy team_chat_active_read on public.team_chat_messages for select to authenticated
  using (public.is_staff());

create or replace function public.send_team_message(p_body text,p_client_message_id uuid)
returns public.team_chat_messages language plpgsql security definer set search_path='' as $$
declare v_sender uuid; v_message public.team_chat_messages; v_body text:=btrim(p_body,E' \n\r\t');
begin
  -- Serialize this sender's sends to enforce the rate limit under concurrent calls.
  -- The lock also orders sends against account deactivation.
  select id into v_sender from public.team_users
  where auth_user_id=auth.uid() and is_active and role in ('admin','staff') for update;
  if v_sender is null then raise exception 'Active staff account required' using errcode='42501'; end if;
  if p_client_message_id is null then raise exception 'Message reference is required'; end if;
  if v_body is null or char_length(v_body) not between 1 and 2000 or char_length(p_body)>2000 then raise exception 'Write a message between 1 and 2000 characters'; end if;
  select * into v_message from public.team_chat_messages where sender_id=v_sender and client_message_id=p_client_message_id;
  if found then
    if v_message.body<>v_body then raise exception 'This message reference has already been used'; end if;
    return v_message;
  end if;
  if (select count(*) from public.team_chat_messages where sender_id=v_sender and created_at>clock_timestamp()-interval '1 minute')>=20 then
    raise exception 'Too many messages. Please wait a minute and try again.' using errcode='P0001';
  end if;
  -- One room: order RPC commits so an incremental ID cursor cannot skip a late send.
  perform pg_advisory_xact_lock(867,1);
  insert into public.team_chat_messages(sender_id,client_message_id,body)
    values(v_sender,p_client_message_id,v_body) returning * into v_message;
  return v_message;
end; $$;
revoke all on function public.send_team_message(text,uuid) from public,anon,authenticated;
grant execute on function public.send_team_message(text,uuid) to authenticated;

-- Hosted Supabase uses this publication. Polling still works without Realtime.
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='team_chat_messages') then
    alter publication supabase_realtime add table public.team_chat_messages;
  end if;
end $$;
commit;
