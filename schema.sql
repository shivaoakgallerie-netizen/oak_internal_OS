-- Oak Gallerie secure Admin/Staff schema. NEW installations only.
-- Existing installations apply migrations/20260930_secure_admin_staff.sql.
-- All installations also apply migrations/20261005_admin_managed_accounts.sql
-- to enable Admin account management and block Staff credential self-service.
begin;
create extension if not exists pgcrypto;

create type public.request_type as enum ('service','help_ticket','follow_up','urgent_message');
create type public.ticket_status as enum ('New','In Review','Scheduled','Resolved');
create type public.request_event_type as enum ('created','assigned','status_updated','resolved','reopened','reminder_due','overdue','notification_queued','notification_sent','notification_failed','read','acknowledged','attachment_added');
create type public.notification_kind as enum ('assigned','follow_up_due','overdue','urgent','urgent_retry');
create type public.notification_state as enum ('queued','processing','sent','failed','cancelled','acknowledged');
create type public.delivery_channel as enum ('push','email');
create type public.delivery_state as enum ('accepted','delivered','failed','bounced');

create table public.clients (
  id uuid primary key default gen_random_uuid(), auth_user_id uuid unique,
  name text not null, phone text not null unique, email text,
  is_active boolean not null default true, created_at timestamptz not null default now()
);

create table public.team_users (
  id uuid primary key default gen_random_uuid(), auth_user_id uuid unique,
  name text not null, phone text not null unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  email text unique check (email is null or (email=btrim(email) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')), role text not null default 'staff' check (role='staff'),
  notification_email text check (notification_email is null or (notification_email=btrim(notification_email) and notification_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  is_active boolean not null default true, created_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  name text not null, site_address text,
  status text not null default 'handed over' check (status in ('active','handed over')),
  boq_url text, created_at timestamptz not null default now()
);

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete restrict,
  type public.request_type not null,
  note text not null check (char_length(btrim(note)) between 1 and 2000),
  status public.ticket_status not null default 'New', created_by uuid not null,
  assignee_id uuid references public.team_users(id) on delete restrict,
  reminder_at timestamptz, created_at timestamptz not null default now(), resolved_at timestamptz,
  last_status_update_at timestamptz not null default now(),
  next_followup_due_at timestamptz not null default (now()+interval '24 hours'),
  urgent_read_at timestamptz, urgent_acknowledged_at timestamptz,
  urgent_acknowledged_by uuid references public.team_users(id) on delete restrict,
  urgent_retry_sent_at timestamptz,
  constraint service_requires_project check (type<>'service' or project_id is not null),
  constraint follow_up_requires_reminder check (type<>'follow_up' or reminder_at is not null),
  constraint urgent_requires_assignee check (type<>'urgent_message' or assignee_id is not null)
);

create table public.attachments (
  id uuid primary key default gen_random_uuid(), ticket_id uuid not null references public.tickets(id) on delete cascade,
  storage_path text not null unique, original_name text not null,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm')),
  byte_size bigint not null check ((mime_type like 'image/%' and byte_size between 1 and 10485760) or (mime_type like 'video/%' and byte_size between 1 and 52428800)),
  uploaded_by uuid not null, uploaded_at timestamptz not null default now()
);

create table public.request_events (
  id uuid primary key default gen_random_uuid(), ticket_id uuid not null references public.tickets(id) on delete cascade,
  event_type public.request_event_type not null, actor_user_id uuid,
  old_status public.ticket_status, new_status public.ticket_status,
  note text, expected_timeline text, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(), ticket_id uuid not null references public.tickets(id) on delete cascade,
  recipient_id uuid not null references public.team_users(id) on delete restrict,
  kind public.notification_kind not null, state public.notification_state not null default 'queued',
  scheduled_for timestamptz not null default now(), next_attempt_at timestamptz not null default now(),
  attempt_count integer not null default 0, dedupe_key text not null unique, last_error text,
  read_at timestamptz, acknowledged_at timestamptz,
  created_at timestamptz not null default now(), processed_at timestamptz
);

create table public.delivery_attempts (
  id uuid primary key default gen_random_uuid(), notification_id uuid not null references public.notifications(id) on delete cascade,
  channel public.delivery_channel not null, provider text not null, state public.delivery_state not null,
  attempt_number integer not null, provider_message_id text, error_code text, error_message text,
  attempted_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(), team_user_id uuid not null references public.team_users(id) on delete cascade,
  endpoint text not null unique, p256dh text not null, auth_key text not null, device_label text,
  created_at timestamptz not null default now(), last_seen_at timestamptz not null default now(), revoked_at timestamptz
);
create table public.worker_runs (
  id uuid primary key default gen_random_uuid(), worker text not null check (worker in ('notification-worker','notification-scan')),
  status text not null check (status in ('succeeded','failed')), processed_count integer not null default 0,
  error_message text, started_at timestamptz not null, finished_at timestamptz not null default now()
);

create index projects_client_idx on public.projects(client_id);
create index tickets_queue_idx on public.tickets(status,urgent_acknowledged_at,next_followup_due_at,created_at);
create index tickets_assignee_idx on public.tickets(assignee_id,status);
create index events_ticket_idx on public.request_events(ticket_id,created_at desc);
create index attachments_ticket_idx on public.attachments(ticket_id,uploaded_at);
create index notifications_work_idx on public.notifications(state,next_attempt_at,scheduled_for);
create index notifications_recipient_idx on public.notifications(recipient_id,created_at desc);
create index delivery_provider_idx on public.delivery_attempts(provider_message_id) where provider_message_id is not null;

create or replace function public.is_staff() returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.team_users where auth_user_id=(select auth.uid()) and is_active);
$$;
create or replace function public.current_team_user_id() returns uuid language sql stable security definer set search_path=public as $$
  select id from public.team_users where auth_user_id=(select auth.uid()) and is_active limit 1;
$$;
create or replace function public.assert_active_assignee(p_team_user_id uuid) returns void language plpgsql security definer set search_path=public as $$
begin
  if p_team_user_id is not null and not exists(select 1 from public.team_users where id=p_team_user_id and is_active) then
    raise exception 'Recipient must be an active staff member';
  end if;
end; $$;

create or replace function public.create_request(p_type public.request_type,p_note text,p_project_id uuid default null,p_assignee_id uuid default null,p_reminder_at timestamptz default null)
returns public.tickets language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=public.current_team_user_id(); v_assignee uuid:=p_assignee_id; v_ticket public.tickets; v_kind public.notification_kind;
begin
  if v_actor is null then raise exception 'Active staff account required'; end if;
  if nullif(btrim(p_note),'') is null then raise exception 'Description is required'; end if;
  if p_type='service' and p_project_id is null then raise exception 'Service requests require a project'; end if;
  if p_type='follow_up' then
    if p_reminder_at is null or p_reminder_at<=now() then raise exception 'Choose a future reminder'; end if;
    v_assignee:=v_actor;
  elsif p_reminder_at is not null then raise exception 'Only follow-ups may have a personal reminder'; end if;
  if p_type='urgent_message' and v_assignee is null then raise exception 'Urgent messages require a recipient'; end if;
  perform public.assert_active_assignee(v_assignee);
  insert into public.tickets(project_id,type,note,created_by,assignee_id,reminder_at)
  values(p_project_id,p_type,btrim(p_note),(select auth.uid()),v_assignee,p_reminder_at) returning * into v_ticket;
  insert into public.request_events(ticket_id,event_type,actor_user_id,new_status,metadata)
  values(v_ticket.id,'created',(select auth.uid()),'New',jsonb_build_object('type',p_type));
  if v_assignee is not null and p_type in ('service','help_ticket','urgent_message') then
    v_kind:=case when p_type='urgent_message' then 'urgent'::public.notification_kind else 'assigned'::public.notification_kind end;
    insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key)
    values(v_ticket.id,v_assignee,v_kind,v_ticket.id::text||':'||v_kind::text||':created');
    insert into public.request_events(ticket_id,event_type,actor_user_id,metadata)
    values(v_ticket.id,'notification_queued',(select auth.uid()),jsonb_build_object('kind',v_kind,'recipient_id',v_assignee));
  elsif p_type='follow_up' then
    insert into public.notifications(ticket_id,recipient_id,kind,scheduled_for,next_attempt_at,dedupe_key)
    values(v_ticket.id,v_actor,'follow_up_due',p_reminder_at,p_reminder_at,v_ticket.id::text||':follow_up_due:'||extract(epoch from p_reminder_at)::bigint);
  end if;
  return v_ticket;
end; $$;

create or replace function public.record_request_update(p_ticket_id uuid,p_new_status public.ticket_status,p_note text default null,p_expected_timeline text default null)
returns public.tickets language plpgsql security definer set search_path=public as $$
declare v_before public.tickets; v_after public.tickets; v_event public.request_event_type:='status_updated';
begin
  if public.current_team_user_id() is null then raise exception 'Active staff account required'; end if;
  select * into v_before from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'Request not found'; end if;
  if p_new_status<>'Resolved' and nullif(btrim(coalesce(p_expected_timeline,'')),'') is null then raise exception 'Expected timeline is required for an open request update'; end if;
  if v_before.status='Resolved' and p_new_status not in ('Resolved','In Review') then raise exception 'Resolved requests can only reopen to In Review'; end if;
  if v_before.status='New' and p_new_status not in ('New','In Review','Resolved') then raise exception 'New requests move to In Review or Resolved'; end if;
  if v_before.status='In Review' and p_new_status not in ('In Review','Scheduled','Resolved') then raise exception 'In Review requests move to Scheduled or Resolved'; end if;
  if v_before.status='Scheduled' and p_new_status not in ('Scheduled','Resolved') then raise exception 'Scheduled requests can only remain Scheduled or resolve'; end if;
  if v_before.status<>'Resolved' and p_new_status='Resolved' then v_event:='resolved'; end if;
  if v_before.status='Resolved' and p_new_status='In Review' then v_event:='reopened'; end if;
  update public.tickets set status=p_new_status,resolved_at=case when p_new_status='Resolved' then now() else null end,
    last_status_update_at=now(),next_followup_due_at=now()+interval '24 hours'
  where id=p_ticket_id returning * into v_after;
  insert into public.request_events(ticket_id,event_type,actor_user_id,old_status,new_status,note,expected_timeline)
  values(p_ticket_id,v_event,(select auth.uid()),v_before.status,p_new_status,nullif(btrim(coalesce(p_note,'')),''),nullif(btrim(coalesce(p_expected_timeline,'')),''));
  if p_new_status='Resolved' then
    update public.notifications set state='cancelled',processed_at=now() where ticket_id=p_ticket_id and state in ('queued','processing') and kind in ('follow_up_due','overdue','urgent_retry');
  else
    update public.notifications set state='cancelled',processed_at=now() where ticket_id=p_ticket_id and state in ('queued','failed') and kind='overdue';
  end if;
  return v_after;
end; $$;

create or replace function public.assign_request(p_ticket_id uuid,p_assignee_id uuid)
returns public.tickets language plpgsql security definer set search_path=public as $$
declare v_ticket public.tickets; v_old uuid;
begin
  if public.current_team_user_id() is null then raise exception 'Active staff account required'; end if;
  perform public.assert_active_assignee(p_assignee_id);
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'Request not found'; end if;
  if v_ticket.type='urgent_message' and p_assignee_id is null then raise exception 'Urgent messages require a recipient'; end if;
  if v_ticket.type='follow_up' and p_assignee_id is distinct from public.current_team_user_id() then raise exception 'Follow-ups remain assigned to their creator'; end if;
  v_old:=v_ticket.assignee_id;
  update public.tickets set assignee_id=p_assignee_id where id=p_ticket_id returning * into v_ticket;
  insert into public.request_events(ticket_id,event_type,actor_user_id,metadata)
  values(p_ticket_id,'assigned',(select auth.uid()),jsonb_build_object('old_assignee_id',v_old,'assignee_id',p_assignee_id));
  if p_assignee_id is not null and p_assignee_id is distinct from v_old then
    insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key)
    values(p_ticket_id,p_assignee_id,case when v_ticket.type='urgent_message' then 'urgent'::public.notification_kind else 'assigned'::public.notification_kind end,
      p_ticket_id::text||':assigned:'||p_assignee_id::text||':'||extract(epoch from now())::bigint);
  end if;
  return v_ticket;
end; $$;

create or replace function public.mark_request_read(p_ticket_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare v_me uuid:=public.current_team_user_id();
begin
  if v_me is null then raise exception 'Active staff account required'; end if;
  update public.tickets set urgent_read_at=coalesce(urgent_read_at,now()) where id=p_ticket_id and type='urgent_message' and assignee_id=v_me;
  if found then
    update public.notifications set read_at=coalesce(read_at,now()) where ticket_id=p_ticket_id and recipient_id=v_me;
    if not exists(select 1 from public.request_events where ticket_id=p_ticket_id and event_type='read' and actor_user_id=(select auth.uid())) then
      insert into public.request_events(ticket_id,event_type,actor_user_id) values(p_ticket_id,'read',(select auth.uid()));
    end if;
  end if;
end; $$;

create or replace function public.acknowledge_urgent(p_ticket_id uuid) returns public.tickets language plpgsql security definer set search_path=public as $$
declare v_me uuid:=public.current_team_user_id(); v_ticket public.tickets;
begin
  if v_me is null then raise exception 'Active staff account required'; end if;
  update public.tickets set urgent_read_at=coalesce(urgent_read_at,now()),urgent_acknowledged_at=coalesce(urgent_acknowledged_at,now()),urgent_acknowledged_by=v_me
  where id=p_ticket_id and type='urgent_message' and assignee_id=v_me returning * into v_ticket;
  if not found then raise exception 'Only the urgent message recipient can acknowledge it'; end if;
  update public.notifications set state='acknowledged',read_at=coalesce(read_at,now()),acknowledged_at=coalesce(acknowledged_at,now()),processed_at=now()
  where ticket_id=p_ticket_id and recipient_id=v_me and kind in ('urgent','urgent_retry');
  if not exists(select 1 from public.request_events where ticket_id=p_ticket_id and event_type='acknowledged') then
    insert into public.request_events(ticket_id,event_type,actor_user_id) values(p_ticket_id,'acknowledged',(select auth.uid()));
  end if;
  return v_ticket;
end; $$;

create or replace function public.register_push_subscription(p_endpoint text,p_p256dh text,p_auth_key text,p_device_label text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_me uuid:=public.current_team_user_id(); v_id uuid;
begin
  if v_me is null then raise exception 'Active staff account required'; end if;
  insert into public.push_subscriptions(team_user_id,endpoint,p256dh,auth_key,device_label)
  values(v_me,p_endpoint,p_p256dh,p_auth_key,nullif(btrim(coalesce(p_device_label,'')),''))
  on conflict(endpoint) do update set team_user_id=excluded.team_user_id,p256dh=excluded.p256dh,auth_key=excluded.auth_key,device_label=excluded.device_label,last_seen_at=now(),revoked_at=null
  returning id into v_id; return v_id;
end; $$;

create or replace function public.revoke_push_subscription(p_endpoint text) returns void language plpgsql security definer set search_path=public as $$
declare v_me uuid:=public.current_team_user_id();
begin
  if v_me is null then raise exception 'Active staff account required'; end if;
  update public.push_subscriptions set revoked_at=now() where team_user_id=v_me and endpoint=p_endpoint;
end; $$;

create or replace function public.log_attachment_event() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.request_events(ticket_id,event_type,actor_user_id,metadata)
  values(new.ticket_id,'attachment_added',new.uploaded_by,jsonb_build_object('attachment_id',new.id,'name',new.original_name,'mime_type',new.mime_type));
  return new;
end; $$;
create trigger trg_log_attachment after insert on public.attachments for each row execute function public.log_attachment_event();

create or replace function public.enqueue_due_notifications() returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer:=0; v_added integer;
begin
  insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key)
  select t.id,coalesce(t.assignee_id,creator.id),'overdue',t.id::text||':overdue:'||extract(epoch from t.next_followup_due_at)::bigint
  from public.tickets t join public.team_users creator on creator.auth_user_id=t.created_by and creator.is_active
  where t.status<>'Resolved' and t.next_followup_due_at<=now()
  on conflict(dedupe_key) do nothing;
  get diagnostics v_added=row_count; v_count:=v_count+v_added;
  insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key)
  select t.id,t.assignee_id,'urgent_retry',t.id::text||':urgent_retry'
  from public.tickets t where t.type='urgent_message' and t.status<>'Resolved' and t.urgent_acknowledged_at is null
    and t.urgent_retry_sent_at is null and t.created_at<=now()-interval '15 minutes'
  on conflict(dedupe_key) do nothing;
  get diagnostics v_added=row_count; v_count:=v_count+v_added;
  update public.tickets set urgent_retry_sent_at=now() where type='urgent_message' and status<>'Resolved' and urgent_acknowledged_at is null
    and urgent_retry_sent_at is null and created_at<=now()-interval '15 minutes';
  return v_count;
end; $$;

create or replace function public.claim_notification_batch(p_limit integer default 25) returns setof public.notifications language plpgsql security definer set search_path=public as $$
begin
  if coalesce((select auth.role()),'')<>'service_role' then raise exception 'Service role required'; end if;
  return query with claimed as (
    select id from public.notifications where state in ('queued','failed','processing') and scheduled_for<=now() and next_attempt_at<=now() and attempt_count<4
    order by scheduled_for,id for update skip locked limit greatest(1,least(p_limit,100))
  ) update public.notifications n set state='processing',attempt_count=n.attempt_count+1,next_attempt_at=now()+interval '5 minutes' from claimed where n.id=claimed.id returning n.*;
end; $$;

alter table public.clients enable row level security; alter table public.team_users enable row level security;
alter table public.projects enable row level security; alter table public.tickets enable row level security;
alter table public.attachments enable row level security; alter table public.request_events enable row level security;
alter table public.notifications enable row level security; alter table public.delivery_attempts enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.worker_runs enable row level security;

revoke all on public.clients,public.team_users,public.projects,public.tickets,public.attachments,public.request_events,public.notifications,public.delivery_attempts,public.push_subscriptions,public.worker_runs from anon,authenticated;
grant select on public.clients,public.team_users,public.projects,public.tickets,public.attachments,public.request_events,public.notifications,public.delivery_attempts,public.worker_runs to authenticated;
grant insert on public.attachments to authenticated;
revoke execute on function public.create_request(public.request_type,text,uuid,uuid,timestamptz),public.record_request_update(uuid,public.ticket_status,text,text),public.assign_request(uuid,uuid),public.mark_request_read(uuid),public.acknowledge_urgent(uuid),public.register_push_subscription(text,text,text,text),public.revoke_push_subscription(text) from public,anon;
grant execute on function public.create_request(public.request_type,text,uuid,uuid,timestamptz),public.record_request_update(uuid,public.ticket_status,text,text),public.assign_request(uuid,uuid),public.mark_request_read(uuid),public.acknowledge_urgent(uuid),public.register_push_subscription(text,text,text,text),public.revoke_push_subscription(text) to authenticated;
revoke execute on function public.enqueue_due_notifications(),public.claim_notification_batch(integer) from public,anon,authenticated;
grant execute on function public.enqueue_due_notifications(),public.claim_notification_batch(integer) to service_role;

create policy staff_roster_read on public.team_users for select to authenticated using(public.is_staff());
create policy staff_clients_read on public.clients for select to authenticated using(public.is_staff());
create policy staff_projects_read on public.projects for select to authenticated using(public.is_staff());
create policy staff_tickets_read on public.tickets for select to authenticated using(public.is_staff());
create policy staff_attachments_read on public.attachments for select to authenticated using(public.is_staff());
create policy staff_attachments_add on public.attachments for insert to authenticated with check(public.is_staff() and uploaded_by=(select auth.uid()) and exists(select 1 from public.tickets where id=ticket_id));
create policy staff_events_read on public.request_events for select to authenticated using(public.is_staff());
create policy staff_notifications_read on public.notifications for select to authenticated using(public.is_staff());
create policy staff_delivery_read on public.delivery_attempts for select to authenticated using(public.is_staff());
create policy own_push_subscriptions_read on public.push_subscriptions for select to authenticated using(team_user_id=public.current_team_user_id());
create policy staff_worker_runs_read on public.worker_runs for select to authenticated using(public.is_staff());

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('service-photos','service-photos',false,52428800,array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy request_media_staff_read on storage.objects for select to authenticated using(bucket_id='service-photos' and public.is_staff());
create policy request_media_staff_add on storage.objects for insert to authenticated with check(bucket_id='service-photos' and public.is_staff() and exists(select 1 from public.tickets where id::text=(storage.foldername(name))[1]));
create policy request_media_orphan_cleanup on storage.objects for delete to authenticated using(
  bucket_id='service-photos' and public.is_staff() and owner_id=(select auth.uid()::text)
  and not exists(select 1 from public.attachments where storage_path=name)
);

alter table public.team_users drop constraint if exists team_users_role_check;
alter table public.team_users add constraint team_users_role_check check (role in ('admin','staff'));
alter table public.team_users alter column email drop not null;
alter table public.team_users add constraint team_users_active_admin_email_check
 check (not (is_active and role='admin') or nullif(btrim(email),'') is not null);
alter table public.team_users add column if not exists department text not null default 'Team';
alter table public.tickets add column if not exists expected_timeline text;
alter table public.tickets add column if not exists reminder_cancelled_at timestamptz;
alter table public.tickets add column if not exists urgent_assigned_at timestamptz;
alter table public.tickets add column if not exists assignment_version integer not null default 0;
update public.tickets set urgent_assigned_at=created_at where type='urgent_message' and urgent_assigned_at is null;

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.team_users where auth_user_id=auth.uid() and is_active and role='admin');
$$;
create or replace function public.can_read_request(p_ticket_id uuid) returns boolean language sql stable security definer set search_path=public as $$
  select public.is_staff() and exists(select 1 from public.tickets t where t.id=p_ticket_id and
    (public.is_admin() or t.assignee_id=public.current_team_user_id() or t.created_by=auth.uid() or (t.assignee_id is null and t.type in ('service','help_ticket'))));
$$;
create or replace function public.can_update_request(p_ticket_id uuid) returns boolean language sql stable security definer set search_path=public as $$
  select public.is_staff() and exists(select 1 from public.tickets t where t.id=p_ticket_id and (public.is_admin() or t.assignee_id=public.current_team_user_id()));
$$;
create or replace function public.can_attach_request(p_ticket_id uuid) returns boolean language sql stable security definer set search_path=public as $$
  select public.is_staff() and exists(select 1 from public.tickets t where t.id=p_ticket_id and t.status<>'Resolved' and (public.is_admin() or t.assignee_id=public.current_team_user_id() or t.created_by=auth.uid()));
$$;
create or replace function public.staff_directory() returns table(id uuid,auth_user_id uuid,name text,role text,department text,is_active boolean)
language plpgsql stable security definer set search_path=public as $$
begin
  if not public.is_staff() then raise exception 'Active staff account required'; end if;
  return query select t.id,t.auth_user_id,t.name,t.role,t.department,t.is_active from public.team_users t order by t.name;
end; $$;

create or replace function public.create_request(p_type public.request_type,p_note text,p_project_id uuid default null,p_assignee_id uuid default null,p_reminder_at timestamptz default null)
returns public.tickets language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=public.current_team_user_id(); v_assignee uuid:=p_assignee_id; v_ticket public.tickets; v_kind public.notification_kind;
begin
  if v_actor is null then raise exception 'Active staff account required'; end if;
  if p_type='urgent_message' and not public.is_admin() then raise exception 'Only Admin can create urgent messages'; end if;
  if not public.is_admin() and p_assignee_id is not null and p_assignee_id<>v_actor then raise exception 'Only Admin can assign another person'; end if;
  if p_type='service' and p_project_id is null then raise exception 'Service requires a project'; end if;
  if p_type='follow_up' then
    if p_reminder_at is null or p_reminder_at<=now() then raise exception 'Choose a future reminder'; end if;
    v_assignee:=v_actor;
  elsif p_reminder_at is not null then raise exception 'Only follow-ups may have a reminder'; end if;
  if p_type='urgent_message' and v_assignee is null then raise exception 'Urgent messages require a recipient'; end if;
  perform public.assert_active_assignee(v_assignee);
  insert into public.tickets(project_id,type,note,created_by,assignee_id,reminder_at,urgent_assigned_at)
  values(p_project_id,p_type,btrim(p_note),auth.uid(),v_assignee,p_reminder_at,case when p_type='urgent_message' then now() end) returning * into v_ticket;
  insert into public.request_events(ticket_id,event_type,actor_user_id,new_status,metadata)
  values(v_ticket.id,'created',auth.uid(),'New',jsonb_build_object('type',p_type,'assignee_id',v_assignee));
  if v_assignee is not null and p_type in ('service','help_ticket','urgent_message') then
    v_kind:=case when p_type='urgent_message' then 'urgent'::public.notification_kind else 'assigned'::public.notification_kind end;
    insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key) values(v_ticket.id,v_assignee,v_kind,v_ticket.id::text||':created:'||v_assignee::text);
    insert into public.request_events(ticket_id,event_type,actor_user_id,metadata) values(v_ticket.id,'notification_queued',auth.uid(),jsonb_build_object('kind',v_kind,'recipient_id',v_assignee));
  elsif p_type='follow_up' then
    insert into public.notifications(ticket_id,recipient_id,kind,scheduled_for,next_attempt_at,dedupe_key)
    values(v_ticket.id,v_actor,'follow_up_due',p_reminder_at,p_reminder_at,v_ticket.id::text||':follow_up:'||extract(epoch from p_reminder_at)::text);
    insert into public.request_events(ticket_id,event_type,actor_user_id,metadata) values(v_ticket.id,'notification_queued',auth.uid(),jsonb_build_object('kind','follow_up_due','scheduled_for',p_reminder_at));
  end if;
  return v_ticket;
end; $$;

create or replace function public.record_request_update(p_ticket_id uuid,p_new_status public.ticket_status,p_note text default null,p_expected_timeline text default null)
returns public.tickets language plpgsql security definer set search_path=public as $$
declare v_before public.tickets; v_after public.tickets; v_event public.request_event_type:='status_updated';
begin
  select * into v_before from public.tickets where id=p_ticket_id for update;
  if not found or not public.can_update_request(p_ticket_id) then raise exception 'You cannot update this request'; end if;
  if p_new_status is null then raise exception 'Status is required'; end if;
  if nullif(btrim(coalesce(p_note,'')),'') is null then raise exception 'Describe the workflow update'; end if;
  if char_length(p_note)>2000 or char_length(coalesce(p_expected_timeline,''))>500 then raise exception 'Update is too long'; end if;
  if p_new_status<>'Resolved' and nullif(btrim(coalesce(p_expected_timeline,'')),'') is null then raise exception 'Expected timeline is required'; end if;
  if (v_before.status='Resolved' and p_new_status<>'In Review') or
     (v_before.status='New' and p_new_status not in ('New','In Review','Resolved')) or
     (v_before.status='In Review' and p_new_status not in ('In Review','Scheduled','Resolved')) or
     (v_before.status='Scheduled' and p_new_status not in ('Scheduled','Resolved')) then raise exception 'Invalid workflow transition'; end if;
  if p_new_status='Resolved' then v_event:='resolved'; elsif v_before.status='Resolved' then v_event:='reopened'; end if;
  update public.tickets set status=p_new_status,resolved_at=case when p_new_status='Resolved' then now() end,
    last_status_update_at=now(),next_followup_due_at=now()+interval '24 hours',expected_timeline=nullif(btrim(p_expected_timeline),''),
    reminder_cancelled_at=case when p_new_status='Resolved' and type='follow_up' then now() else reminder_cancelled_at end
  where id=p_ticket_id returning * into v_after;
  insert into public.request_events(ticket_id,event_type,actor_user_id,old_status,new_status,note,expected_timeline)
  values(p_ticket_id,v_event,auth.uid(),v_before.status,p_new_status,btrim(p_note),nullif(btrim(p_expected_timeline),''));
  update public.notifications set state='cancelled',processed_at=now()
  where ticket_id=p_ticket_id and state in ('queued','processing','failed') and (p_new_status='Resolved' or kind='overdue');
  return v_after;
end; $$;

create or replace function public.assign_request(p_ticket_id uuid,p_assignee_id uuid) returns public.tickets
language plpgsql security definer set search_path=public as $$
declare v_ticket public.tickets; v_old uuid; v_kind public.notification_kind;
begin
  if not public.is_admin() then raise exception 'Only Admin can assign work'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'Request not found'; end if;
  if v_ticket.type='follow_up' then raise exception 'Follow-ups remain with their creator'; end if;
  if v_ticket.status='Resolved' then raise exception 'Reopen before assigning'; end if;
  if v_ticket.type='urgent_message' and p_assignee_id is null then raise exception 'Urgent requires a recipient'; end if;
  perform public.assert_active_assignee(p_assignee_id);
  v_old:=v_ticket.assignee_id;
  if v_old is not distinct from p_assignee_id then return v_ticket; end if;
  update public.notifications set state='cancelled',processed_at=now() where ticket_id=p_ticket_id and state in ('queued','processing','failed') and kind in ('assigned','urgent','urgent_retry');
  update public.notifications set recipient_id=coalesce(p_assignee_id,(select id from public.team_users where auth_user_id=v_ticket.created_by))
  where ticket_id=p_ticket_id and state in ('queued','failed') and kind='overdue';
  update public.tickets set assignee_id=p_assignee_id,assignment_version=assignment_version+1,
    urgent_assigned_at=case when type='urgent_message' then now() else urgent_assigned_at end,
    urgent_read_at=case when type='urgent_message' then null else urgent_read_at end,
    urgent_acknowledged_at=case when type='urgent_message' then null else urgent_acknowledged_at end,
    urgent_acknowledged_by=case when type='urgent_message' then null else urgent_acknowledged_by end,
    urgent_retry_sent_at=case when type='urgent_message' then null else urgent_retry_sent_at end
  where id=p_ticket_id returning * into v_ticket;
  insert into public.request_events(ticket_id,event_type,actor_user_id,metadata)
  values(p_ticket_id,'assigned',auth.uid(),jsonb_build_object('old_assignee_id',v_old,'new_assignee_id',p_assignee_id));
  if p_assignee_id is not null then
    v_kind:=case when v_ticket.type='urgent_message' then 'urgent'::public.notification_kind else 'assigned'::public.notification_kind end;
    insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key)
    values(p_ticket_id,p_assignee_id,v_kind,p_ticket_id::text||':assignment:'||v_ticket.assignment_version::text);
    insert into public.request_events(ticket_id,event_type,actor_user_id,metadata) values(p_ticket_id,'notification_queued',auth.uid(),jsonb_build_object('kind',v_kind,'recipient_id',p_assignee_id));
  end if;
  return v_ticket;
end; $$;

create or replace function public.mark_request_read(p_ticket_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare v_me uuid:=public.current_team_user_id();
begin
  if not public.can_read_request(p_ticket_id) then raise exception 'You cannot read this request'; end if;
  perform 1 from public.tickets where id=p_ticket_id for update;
  update public.tickets set urgent_read_at=coalesce(urgent_read_at,now()) where id=p_ticket_id and type='urgent_message' and assignee_id=v_me;
  update public.notifications set read_at=coalesce(read_at,now()) where ticket_id=p_ticket_id and recipient_id=v_me;
  if not exists(select 1 from public.request_events where ticket_id=p_ticket_id and event_type='read' and actor_user_id=auth.uid()) then
    insert into public.request_events(ticket_id,event_type,actor_user_id) values(p_ticket_id,'read',auth.uid());
  end if;
end; $$;
create or replace function public.acknowledge_urgent(p_ticket_id uuid) returns public.tickets language plpgsql security definer set search_path=public as $$
declare v_me uuid:=public.current_team_user_id(); v_ticket public.tickets;
begin
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if v_me is null or not found or v_ticket.type<>'urgent_message' or v_ticket.status='Resolved' or v_ticket.assignee_id<>v_me then raise exception 'Only the active recipient can acknowledge an open urgent message'; end if;
  if v_ticket.urgent_acknowledged_at is not null then return v_ticket; end if;
  update public.tickets set urgent_read_at=coalesce(urgent_read_at,now()),urgent_acknowledged_at=now(),urgent_acknowledged_by=v_me where id=p_ticket_id returning * into v_ticket;
  update public.notifications set state='acknowledged',read_at=coalesce(read_at,now()),acknowledged_at=now(),processed_at=now() where ticket_id=p_ticket_id and recipient_id=v_me and kind in ('urgent','urgent_retry') and state<>'cancelled';
  insert into public.request_events(ticket_id,event_type,actor_user_id) values(p_ticket_id,'acknowledged',auth.uid());
  return v_ticket;
end; $$;

create or replace function public.set_staff_active(p_team_user_id uuid,p_active boolean) returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'Only Admin can change staff access'; end if;
  if p_active is null or p_team_user_id=public.current_team_user_id() then raise exception 'Your own access cannot be changed here'; end if;
  perform 1 from public.team_users where id=p_team_user_id for update;
  if not found then raise exception 'Staff member not found'; end if;
  if not p_active and exists(select 1 from public.tickets where assignee_id=p_team_user_id and status<>'Resolved') then raise exception 'Reassign or resolve open work first'; end if;
  update public.team_users set is_active=p_active where id=p_team_user_id;
  if not p_active then
    update public.push_subscriptions set revoked_at=now() where team_user_id=p_team_user_id;
    update public.notifications set state='cancelled',processed_at=now() where recipient_id=p_team_user_id and state in ('queued','processing','failed');
  end if;
end; $$;
create or replace function public.retry_notification(p_notification_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare v_n public.notifications; v_t public.tickets;
begin
  if not public.is_admin() then raise exception 'Only Admin can retry delivery'; end if;
  select * into v_n from public.notifications where id=p_notification_id for update;
  if not found or v_n.state<>'failed' then raise exception 'Only failed delivery can be retried'; end if;
  select * into v_t from public.tickets where id=v_n.ticket_id;
  if v_t.status='Resolved' or (v_n.kind in ('urgent','urgent_retry') and v_t.urgent_acknowledged_at is not null) or not exists(select 1 from public.team_users where id=v_n.recipient_id and is_active) then raise exception 'This notification is no longer actionable'; end if;
  update public.notifications set state='queued',attempt_count=0,next_attempt_at=now(),processed_at=null,last_error=null where id=p_notification_id;
  insert into public.request_events(ticket_id,event_type,actor_user_id,metadata) values(v_n.ticket_id,'notification_queued',auth.uid(),jsonb_build_object('manual_retry',true,'notification_id',v_n.id));
end; $$;

create or replace function public.register_push_subscription(p_endpoint text,p_p256dh text,p_auth_key text,p_device_label text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_me uuid:=public.current_team_user_id();v_id uuid;
begin
 if v_me is null then raise exception 'Active staff account required'; end if;
 if p_endpoint is null or p_endpoint !~ '^https://([a-z0-9.-]+[.])?(fcm[.]googleapis[.]com|push[.]services[.]mozilla[.]com|web[.]push[.]apple[.]com|notify[.]windows[.]com)/' or char_length(p_endpoint)>4096 then raise exception 'Unsupported push endpoint'; end if;
 if p_p256dh is null or char_length(p_p256dh) not between 80 and 100 or p_p256dh !~ '^[A-Za-z0-9_=-]+$' or p_auth_key is null or char_length(p_auth_key) not between 20 and 32 or p_auth_key !~ '^[A-Za-z0-9_=-]+$' then raise exception 'Invalid push keys'; end if;
 insert into public.push_subscriptions(team_user_id,endpoint,p256dh,auth_key,device_label)
 values(v_me,p_endpoint,p_p256dh,p_auth_key,left(p_device_label,200))
 on conflict(endpoint) do update set team_user_id=excluded.team_user_id,p256dh=excluded.p256dh,auth_key=excluded.auth_key,device_label=excluded.device_label,last_seen_at=now(),revoked_at=null
 where push_subscriptions.team_user_id=v_me or push_subscriptions.revoked_at is not null
 returning id into v_id;
 if v_id is null then raise exception 'Sign out the previous account on this device before registering alerts'; end if;
 return v_id;
end; $$;

create or replace function public.create_project(p_client_name text,p_client_phone text,p_project_name text,p_site_address text default null)
returns public.projects language plpgsql security definer set search_path=public as $$
declare v_client uuid; v_project public.projects;
begin
  if not public.is_admin() then raise exception 'Only Admin can add projects'; end if;
  if nullif(btrim(p_client_name),'') is null or char_length(p_client_name)>200 or nullif(btrim(p_project_name),'') is null or char_length(p_project_name)>200 or p_client_phone !~ '^\+[1-9][0-9]{7,14}$' or p_client_phone is null then raise exception 'Enter a client name, E.164 phone and project name'; end if;
  if char_length(coalesce(p_site_address,''))>1000 then raise exception 'Address is too long'; end if;
  insert into public.clients(name,phone) values(btrim(p_client_name),p_client_phone) on conflict(phone) do nothing;
  select id into v_client from public.clients where phone=p_client_phone for update;
  if exists(select 1 from public.projects where client_id=v_client and name=btrim(p_project_name)) then raise exception 'This client project already exists'; end if;
  insert into public.projects(client_id,name,site_address,status) values(v_client,btrim(p_project_name),nullif(btrim(p_site_address),''),'active') returning * into v_project;
  return v_project;
end; $$;
revoke execute on function public.create_project(text,text,text,text) from public,anon;
grant execute on function public.create_project(text,text,text,text) to authenticated,service_role;

-- A reservation binds upload permissions to one request, actor and file.
create table if not exists public.attachment_uploads (
 id uuid primary key default gen_random_uuid(),ticket_id uuid not null references public.tickets(id),
 uploaded_by uuid not null,storage_path text not null unique,original_name text not null,
 mime_type text not null,byte_size bigint not null,created_at timestamptz not null default now(),finalized_at timestamptz
);
alter table public.attachment_uploads enable row level security;
create or replace function public.reserve_attachment(p_ticket_id uuid,p_original_name text,p_mime_type text,p_byte_size bigint) returns public.attachment_uploads
language plpgsql security definer set search_path=public as $$
declare v_upload public.attachment_uploads; v_id uuid:=gen_random_uuid(); v_ext text;
begin
  perform 1 from public.tickets where id=p_ticket_id for update;
  if not public.can_attach_request(p_ticket_id) then raise exception 'You cannot attach files to this request'; end if;
  v_ext:=case p_mime_type when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' when 'video/mp4' then 'mp4' when 'video/quicktime' then 'mov' when 'video/webm' then 'webm' end;
  if v_ext is null or p_byte_size is null or p_byte_size<1 or p_byte_size>(case when p_mime_type like 'image/%' then 10485760 else 52428800 end) then raise exception 'Invalid attachment format or size'; end if;
  if nullif(btrim(p_original_name),'') is null or char_length(p_original_name)>255 then raise exception 'Invalid file name'; end if;
  insert into public.attachment_uploads(id,ticket_id,uploaded_by,storage_path,original_name,mime_type,byte_size)
  values(v_id,p_ticket_id,auth.uid(),p_ticket_id::text||'/'||v_id::text||'.'||v_ext,btrim(p_original_name),p_mime_type,p_byte_size) returning * into v_upload;
  return v_upload;
end; $$;
create or replace function public.finalize_attachment(p_upload_id uuid) returns public.attachments language plpgsql security definer set search_path=public as $$
declare v_u public.attachment_uploads; v_a public.attachments; v_metadata jsonb;
begin
  select * into v_u from public.attachment_uploads where id=p_upload_id for update;
  perform 1 from public.tickets where id=v_u.ticket_id for update;
  if not found or v_u.uploaded_by<>auth.uid() or not public.can_attach_request(v_u.ticket_id) then raise exception 'Upload is not permitted'; end if;
  select * into v_a from public.attachments where storage_path=v_u.storage_path;
  if found then return v_a; end if;
  select metadata into v_metadata from storage.objects where bucket_id='service-photos' and name=v_u.storage_path and owner_id=auth.uid()::text;
  if not found or (v_metadata->>'size')::bigint is distinct from v_u.byte_size or v_metadata->>'mimetype' is distinct from v_u.mime_type then raise exception 'Stored file does not match the upload reservation'; end if;
  insert into public.attachments(ticket_id,storage_path,original_name,mime_type,byte_size,uploaded_by)
  values(v_u.ticket_id,v_u.storage_path,v_u.original_name,v_u.mime_type,v_u.byte_size,auth.uid()) returning * into v_a;
  update public.attachment_uploads set finalized_at=now() where id=p_upload_id;
  return v_a;
end; $$;

create or replace function public.enqueue_due_notifications() returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer:=0; v_added integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  -- Lock requests first, matching workflow mutations, to avoid obsolete jobs.
  perform 1 from public.tickets where status<>'Resolved' and (reminder_at<=now() or next_followup_due_at<=now() or (type='urgent_message' and urgent_acknowledged_at is null and urgent_retry_sent_at is null and urgent_assigned_at<=now()-interval '15 minutes')) for update;
  with queued as (insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key)
  select t.id,coalesce(t.assignee_id,c.id),'overdue',t.id::text||':overdue:'||extract(epoch from t.next_followup_due_at)::text
  from public.tickets t left join public.team_users c on c.auth_user_id=t.created_by
  join public.team_users r on r.id=coalesce(t.assignee_id,c.id) and r.is_active
  where t.status<>'Resolved' and t.next_followup_due_at<=now() on conflict(dedupe_key) do nothing returning *)
  insert into public.request_events(ticket_id,event_type,metadata)
  select ticket_id,'overdue',jsonb_build_object('notification_id',id,'recipient_id',recipient_id) from queued;
  get diagnostics v_added=row_count; v_count:=v_count+v_added;
  with queued as (insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key)
  select t.id,t.assignee_id,'urgent_retry',t.id::text||':urgent_retry:'||t.assignment_version::text
  from public.tickets t join public.team_users r on r.id=t.assignee_id and r.is_active where t.type='urgent_message' and t.status<>'Resolved' and t.urgent_acknowledged_at is null and t.urgent_retry_sent_at is null and t.urgent_assigned_at<=now()-interval '15 minutes' on conflict(dedupe_key) do nothing returning *)
  insert into public.request_events(ticket_id,event_type,metadata)
  select ticket_id,'notification_queued',jsonb_build_object('notification_id',id,'recipient_id',recipient_id,'kind','urgent_retry') from queued;
  get diagnostics v_added=row_count; v_count:=v_count+v_added;
  update public.tickets set urgent_retry_sent_at=now() where type='urgent_message' and status<>'Resolved' and urgent_acknowledged_at is null and urgent_retry_sent_at is null and urgent_assigned_at<=now()-interval '15 minutes';
  insert into public.request_events(ticket_id,event_type,metadata)
  select n.ticket_id,'reminder_due',jsonb_build_object('notification_id',n.id) from public.notifications n join public.tickets t on t.id=n.ticket_id
  where n.kind='follow_up_due' and n.scheduled_for<=now() and n.state in ('queued','processing','failed') and t.status<>'Resolved'
  and not exists(select 1 from public.request_events e where e.event_type='reminder_due' and e.metadata->>'notification_id'=n.id::text);
  return v_count;
end; $$;

-- Remove inherited browser write privileges and broad reads.
do $$ declare p record; begin
 for p in select schemaname,tablename,policyname from pg_policies where schemaname='public' and tablename in ('clients','team_users','projects','tickets','attachments','request_events','notifications','delivery_attempts','push_subscriptions','worker_runs','attachment_uploads') loop
   execute format('drop policy %I on %I.%I',p.policyname,p.schemaname,p.tablename);
 end loop;
end $$;
revoke all on public.clients,public.team_users,public.projects,public.tickets,public.attachments,public.request_events,public.notifications,public.delivery_attempts,public.push_subscriptions,public.worker_runs,public.attachment_uploads from anon,authenticated;
grant select on public.clients,public.team_users,public.projects,public.tickets,public.attachments,public.request_events,public.notifications,public.delivery_attempts,public.push_subscriptions,public.worker_runs,public.attachment_uploads to authenticated;
grant all on public.clients,public.team_users,public.projects,public.tickets,public.attachments,public.request_events,public.notifications,public.delivery_attempts,public.push_subscriptions,public.worker_runs,public.attachment_uploads to service_role;
create policy roster_read on public.team_users for select to authenticated using(public.is_admin() or (public.is_staff() and auth_user_id=auth.uid()));
create policy clients_read on public.clients for select to authenticated using(public.is_staff());
create policy projects_read on public.projects for select to authenticated using(public.is_staff());
create policy tickets_read on public.tickets for select to authenticated using(public.can_read_request(id));
create policy attachments_read on public.attachments for select to authenticated using(public.can_read_request(ticket_id));
create policy events_read on public.request_events for select to authenticated using(public.can_read_request(ticket_id));
create policy notifications_read on public.notifications for select to authenticated using(public.is_staff() and (public.is_admin() or recipient_id=public.current_team_user_id() or exists(select 1 from public.tickets t where t.id=ticket_id and t.created_by=auth.uid())));
create policy deliveries_read on public.delivery_attempts for select to authenticated using(exists(select 1 from public.notifications n where n.id=notification_id));
create policy subscriptions_read on public.push_subscriptions for select to authenticated using(team_user_id=public.current_team_user_id());
create policy worker_read on public.worker_runs for select to authenticated using(public.is_admin());
create policy uploads_read on public.attachment_uploads for select to authenticated using(public.is_staff() and uploaded_by=auth.uid());
drop policy if exists request_media_staff_read on storage.objects;
drop policy if exists request_media_staff_add on storage.objects;
drop policy if exists request_media_orphan_cleanup on storage.objects;
create policy request_media_staff_read on storage.objects for select to authenticated using(bucket_id='service-photos' and (exists(select 1 from public.attachments a where a.storage_path=name and public.can_read_request(a.ticket_id)) or exists(select 1 from public.attachment_uploads u where u.storage_path=name and u.uploaded_by=auth.uid() and public.can_attach_request(u.ticket_id))));
create policy request_media_staff_add on storage.objects for insert to authenticated with check(bucket_id='service-photos' and exists(select 1 from public.attachment_uploads u where u.storage_path=name and u.uploaded_by=auth.uid() and u.finalized_at is null and u.created_at>now()-interval '1 hour' and public.can_attach_request(u.ticket_id)));
create or replace function public.is_unlinked_media(p_path text) returns boolean language sql stable security definer set search_path=public as $$
  select not exists(select 1 from public.attachments where storage_path=p_path);
$$;
revoke execute on function public.is_unlinked_media(text) from public,anon;
grant execute on function public.is_unlinked_media(text) to authenticated,service_role;
create policy request_media_orphan_cleanup on storage.objects for delete to authenticated using(bucket_id='service-photos' and public.is_staff() and owner_id=auth.uid()::text and public.is_unlinked_media(name));

create or replace function public.prevent_event_mutation() returns trigger language plpgsql set search_path=public as $$
begin raise exception 'The documented trail is append-only'; end; $$;
drop trigger if exists immutable_request_events on public.request_events;
create trigger immutable_request_events before update or delete on public.request_events for each row execute function public.prevent_event_mutation();

-- Every public function is explicitly allowlisted; helper functions need no
-- anonymous execution and privileged workers can only run with service role.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('is_staff','current_team_user_id','assert_active_assignee','is_admin','can_read_request','can_update_request','can_attach_request','staff_directory','create_request','record_request_update','assign_request','mark_request_read','acknowledge_urgent','set_staff_active','retry_notification','reserve_attachment','finalize_attachment','register_push_subscription','revoke_push_subscription','log_attachment_event','prevent_event_mutation','enqueue_due_notifications','claim_notification_batch') loop
  execute format('revoke execute on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
grant execute on function public.is_staff(),public.current_team_user_id(),public.is_admin(),public.can_read_request(uuid),public.can_update_request(uuid),public.can_attach_request(uuid),public.staff_directory(),public.create_request(public.request_type,text,uuid,uuid,timestamptz),public.record_request_update(uuid,public.ticket_status,text,text),public.assign_request(uuid,uuid),public.mark_request_read(uuid),public.acknowledge_urgent(uuid),public.set_staff_active(uuid,boolean),public.retry_notification(uuid),public.reserve_attachment(uuid,text,text,bigint),public.finalize_attachment(uuid),public.register_push_subscription(text,text,text,text),public.revoke_push_subscription(text) to authenticated;
commit;
