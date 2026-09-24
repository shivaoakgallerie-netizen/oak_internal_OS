-- Upgrade Oak Service V1 in place. Test on a database clone before production.
begin;
lock table public.tickets,public.team_users in share row exclusive mode;

drop trigger if exists trg_sync_ticket_after_history on public.status_history;
drop function if exists public.sync_ticket_after_history();

alter type public.ticket_type rename to ticket_type_v1;
create type public.request_type as enum ('service','help_ticket','follow_up','urgent_message');
create type public.request_event_type as enum ('created','assigned','status_updated','resolved','reopened','reminder_due','overdue','notification_queued','notification_sent','notification_failed','read','acknowledged','attachment_added');
create type public.notification_kind as enum ('assigned','follow_up_due','overdue','urgent','urgent_retry');
create type public.notification_state as enum ('queued','processing','sent','failed','cancelled','acknowledged');
create type public.delivery_channel as enum ('push','email');
create type public.delivery_state as enum ('accepted','delivered','failed','bounced');

alter table public.team_users add column email text;
create unique index team_users_email_unique on public.team_users(lower(email)) where email is not null;
alter table public.team_users add constraint active_staff_requires_email check (not is_active or email is not null) not valid;

alter table public.tickets alter column type drop default;
alter table public.tickets alter column type type public.request_type using 'service'::public.request_type;
alter table public.tickets alter column type set default 'service';
alter table public.tickets alter column project_id drop not null;
update public.tickets set note='Migrated request' where note is null or btrim(note)='';
alter table public.tickets alter column note set not null;
alter table public.tickets add constraint tickets_note_length check (char_length(btrim(note)) between 1 and 2000);
alter table public.tickets drop column created_by_kind;
alter table public.tickets add column assignee_id uuid references public.team_users(id) on delete restrict;
alter table public.tickets add column reminder_at timestamptz;
alter table public.tickets add column urgent_read_at timestamptz;
alter table public.tickets add column urgent_acknowledged_at timestamptz;
alter table public.tickets add column urgent_acknowledged_by uuid references public.team_users(id) on delete restrict;
alter table public.tickets add column urgent_retry_sent_at timestamptz;
alter table public.tickets add constraint service_requires_project check (type<>'service' or project_id is not null);
alter table public.tickets add constraint follow_up_requires_reminder check (type<>'follow_up' or reminder_at is not null);
alter table public.tickets add constraint urgent_requires_assignee check (type<>'urgent_message' or assignee_id is not null);

alter table public.photos rename to attachments;
alter table public.attachments add column original_name text;
alter table public.attachments add column mime_type text;
alter table public.attachments add column byte_size bigint;
update public.attachments set original_name=regexp_replace(storage_path,'^.*/',''),mime_type=case when lower(storage_path) like '%.png' then 'image/png' when lower(storage_path) like '%.jpg' or lower(storage_path) like '%.jpeg' then 'image/jpeg' else 'image/webp' end,byte_size=1;
alter table public.attachments alter column original_name set not null;
alter table public.attachments alter column mime_type set not null;
alter table public.attachments alter column byte_size set not null;
alter table public.attachments rename column uploaded_at to uploaded_at_v1;
alter table public.attachments add column uploaded_at timestamptz;
update public.attachments set uploaded_at=uploaded_at_v1;
alter table public.attachments alter column uploaded_at set default now();
alter table public.attachments alter column uploaded_at set not null;
alter table public.attachments drop column uploaded_at_v1;
alter table public.attachments drop column uploaded_by_kind;
alter table public.attachments add constraint attachment_mime check (mime_type in ('image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'));
alter table public.attachments add constraint attachment_size check ((mime_type like 'image/%' and byte_size between 1 and 10485760) or (mime_type like 'video/%' and byte_size between 1 and 52428800)) not valid;
create unique index attachments_storage_path_unique on public.attachments(storage_path);

create table public.request_events (
 id uuid primary key default gen_random_uuid(),ticket_id uuid not null references public.tickets(id) on delete cascade,event_type public.request_event_type not null,
 actor_user_id uuid,old_status public.ticket_status,new_status public.ticket_status,note text,expected_timeline text,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now()
);
insert into public.request_events(ticket_id,event_type,actor_user_id,new_status,metadata,created_at)
select id,'created',created_by,'New',jsonb_build_object('type','service','migrated',true),created_at from public.tickets;
insert into public.request_events(ticket_id,event_type,actor_user_id,old_status,new_status,note,expected_timeline,metadata,created_at)
select ticket_id,case when new_status='Resolved' then 'resolved'::public.request_event_type else 'status_updated'::public.request_event_type end,changed_by,old_status,new_status,internal_note,expected_timeline,jsonb_build_object('migrated',true),changed_at from public.status_history;
alter table public.status_history rename to status_history_v1_archive;
revoke all on public.status_history_v1_archive from anon,authenticated;

create table public.notifications (
 id uuid primary key default gen_random_uuid(),ticket_id uuid not null references public.tickets(id) on delete cascade,recipient_id uuid not null references public.team_users(id) on delete restrict,
 kind public.notification_kind not null,state public.notification_state not null default 'queued',scheduled_for timestamptz not null default now(),next_attempt_at timestamptz not null default now(),attempt_count integer not null default 0,
 dedupe_key text not null unique,last_error text,read_at timestamptz,acknowledged_at timestamptz,created_at timestamptz not null default now(),processed_at timestamptz
);
create table public.delivery_attempts (
 id uuid primary key default gen_random_uuid(),notification_id uuid not null references public.notifications(id) on delete cascade,channel public.delivery_channel not null,provider text not null,state public.delivery_state not null,
 attempt_number integer not null,provider_message_id text,error_code text,error_message text,attempted_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.push_subscriptions (
 id uuid primary key default gen_random_uuid(),team_user_id uuid not null references public.team_users(id) on delete cascade,endpoint text not null unique,p256dh text not null,auth_key text not null,device_label text,
 created_at timestamptz not null default now(),last_seen_at timestamptz not null default now(),revoked_at timestamptz
);
create table public.worker_runs (id uuid primary key default gen_random_uuid(),worker text not null check(worker in ('notification-worker','notification-scan')),status text not null check(status in ('succeeded','failed')),processed_count integer not null default 0,error_message text,started_at timestamptz not null,finished_at timestamptz not null default now());
drop index if exists tickets_status_due_idx; drop index if exists history_ticket_idx; drop index if exists photos_ticket_idx;
create index tickets_queue_idx on public.tickets(status,urgent_acknowledged_at,next_followup_due_at,created_at);
create index tickets_assignee_idx on public.tickets(assignee_id,status);
create index events_ticket_idx on public.request_events(ticket_id,created_at desc);
create index attachments_ticket_idx on public.attachments(ticket_id,uploaded_at);
create index notifications_work_idx on public.notifications(state,next_attempt_at,scheduled_for);
create index notifications_recipient_idx on public.notifications(recipient_id,created_at desc);
create index delivery_provider_idx on public.delivery_attempts(provider_message_id) where provider_message_id is not null;

create or replace function public.is_staff() returns boolean language sql stable security definer set search_path=public as $$select exists(select 1 from public.team_users where auth_user_id=(select auth.uid()) and is_active)$$;
create or replace function public.current_team_user_id() returns uuid language sql stable security definer set search_path=public as $$select id from public.team_users where auth_user_id=(select auth.uid()) and is_active limit 1$$;
create or replace function public.assert_active_assignee(p_team_user_id uuid) returns void language plpgsql security definer set search_path=public as $$begin if p_team_user_id is not null and not exists(select 1 from public.team_users where id=p_team_user_id and is_active) then raise exception 'Recipient must be an active staff member'; end if; end$$;

create or replace function public.create_request(p_type public.request_type,p_note text,p_project_id uuid default null,p_assignee_id uuid default null,p_reminder_at timestamptz default null)
returns public.tickets language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=public.current_team_user_id();v_assignee uuid:=p_assignee_id;v_ticket public.tickets;v_kind public.notification_kind;
begin
 if v_actor is null then raise exception 'Active staff account required';end if;if nullif(btrim(p_note),'') is null then raise exception 'Description is required';end if;
 if p_type='service' and p_project_id is null then raise exception 'Service requests require a project';end if;
 if p_type='follow_up' then if p_reminder_at is null or p_reminder_at<=now() then raise exception 'Choose a future reminder';end if;v_assignee:=v_actor;elsif p_reminder_at is not null then raise exception 'Only follow-ups may have a personal reminder';end if;
 if p_type='urgent_message' and v_assignee is null then raise exception 'Urgent messages require a recipient';end if;perform public.assert_active_assignee(v_assignee);
 insert into public.tickets(project_id,type,note,created_by,assignee_id,reminder_at) values(p_project_id,p_type,btrim(p_note),(select auth.uid()),v_assignee,p_reminder_at) returning * into v_ticket;
 insert into public.request_events(ticket_id,event_type,actor_user_id,new_status,metadata) values(v_ticket.id,'created',(select auth.uid()),'New',jsonb_build_object('type',p_type));
 if v_assignee is not null and p_type in ('service','help_ticket','urgent_message') then v_kind:=case when p_type='urgent_message' then 'urgent'::public.notification_kind else 'assigned'::public.notification_kind end;
  insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key) values(v_ticket.id,v_assignee,v_kind,v_ticket.id::text||':'||v_kind::text||':created');
 elsif p_type='follow_up' then insert into public.notifications(ticket_id,recipient_id,kind,scheduled_for,next_attempt_at,dedupe_key) values(v_ticket.id,v_actor,'follow_up_due',p_reminder_at,p_reminder_at,v_ticket.id::text||':follow_up_due:'||extract(epoch from p_reminder_at)::bigint);end if;
 return v_ticket;
end$$;

create or replace function public.record_request_update(p_ticket_id uuid,p_new_status public.ticket_status,p_note text default null,p_expected_timeline text default null)
returns public.tickets language plpgsql security definer set search_path=public as $$
declare v_before public.tickets;v_after public.tickets;v_event public.request_event_type:='status_updated';
begin
 if public.current_team_user_id() is null then raise exception 'Active staff account required';end if;select * into v_before from public.tickets where id=p_ticket_id for update;if not found then raise exception 'Request not found';end if;
 if p_new_status<>'Resolved' and nullif(btrim(coalesce(p_expected_timeline,'')),'') is null then raise exception 'Expected timeline is required for an open request update';end if;
 if v_before.status='Resolved' and p_new_status not in ('Resolved','In Review') then raise exception 'Resolved requests can only reopen to In Review';end if;
 if v_before.status='New' and p_new_status not in ('New','In Review','Resolved') then raise exception 'New requests move to In Review or Resolved';end if;
 if v_before.status='In Review' and p_new_status not in ('In Review','Scheduled','Resolved') then raise exception 'In Review requests move to Scheduled or Resolved';end if;
 if v_before.status='Scheduled' and p_new_status not in ('Scheduled','Resolved') then raise exception 'Scheduled requests can only remain Scheduled or resolve';end if;
 if v_before.status<>'Resolved' and p_new_status='Resolved' then v_event:='resolved';end if;if v_before.status='Resolved' and p_new_status='In Review' then v_event:='reopened';end if;
 update public.tickets set status=p_new_status,resolved_at=case when p_new_status='Resolved' then now() else null end,last_status_update_at=now(),next_followup_due_at=now()+interval '24 hours' where id=p_ticket_id returning * into v_after;
 insert into public.request_events(ticket_id,event_type,actor_user_id,old_status,new_status,note,expected_timeline) values(p_ticket_id,v_event,(select auth.uid()),v_before.status,p_new_status,nullif(btrim(coalesce(p_note,'')),''),nullif(btrim(coalesce(p_expected_timeline,'')),''));
 if p_new_status='Resolved' then update public.notifications set state='cancelled',processed_at=now() where ticket_id=p_ticket_id and state in ('queued','processing') and kind in ('follow_up_due','overdue','urgent_retry');else update public.notifications set state='cancelled',processed_at=now() where ticket_id=p_ticket_id and state in ('queued','failed') and kind='overdue';end if;return v_after;
end$$;

create or replace function public.assign_request(p_ticket_id uuid,p_assignee_id uuid) returns public.tickets language plpgsql security definer set search_path=public as $$
declare v_ticket public.tickets;v_old uuid;
begin if public.current_team_user_id() is null then raise exception 'Active staff account required';end if;perform public.assert_active_assignee(p_assignee_id);select * into v_ticket from public.tickets where id=p_ticket_id for update;if not found then raise exception 'Request not found';end if;
 if v_ticket.type='urgent_message' and p_assignee_id is null then raise exception 'Urgent messages require a recipient';end if;if v_ticket.type='follow_up' and p_assignee_id is distinct from public.current_team_user_id() then raise exception 'Follow-ups remain assigned to their creator';end if;
 v_old:=v_ticket.assignee_id;update public.tickets set assignee_id=p_assignee_id where id=p_ticket_id returning * into v_ticket;insert into public.request_events(ticket_id,event_type,actor_user_id,metadata) values(p_ticket_id,'assigned',(select auth.uid()),jsonb_build_object('old_assignee_id',v_old,'assignee_id',p_assignee_id));
 if p_assignee_id is not null and p_assignee_id is distinct from v_old then insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key) values(p_ticket_id,p_assignee_id,case when v_ticket.type='urgent_message' then 'urgent'::public.notification_kind else 'assigned'::public.notification_kind end,p_ticket_id::text||':assigned:'||p_assignee_id::text||':'||extract(epoch from now())::bigint);end if;return v_ticket;
end$$;

create or replace function public.mark_request_read(p_ticket_id uuid) returns void language plpgsql security definer set search_path=public as $$declare v_me uuid:=public.current_team_user_id();begin if v_me is null then raise exception 'Active staff account required';end if;update public.tickets set urgent_read_at=coalesce(urgent_read_at,now()) where id=p_ticket_id and type='urgent_message' and assignee_id=v_me;if found then update public.notifications set read_at=coalesce(read_at,now()) where ticket_id=p_ticket_id and recipient_id=v_me;if not exists(select 1 from public.request_events where ticket_id=p_ticket_id and event_type='read' and actor_user_id=(select auth.uid())) then insert into public.request_events(ticket_id,event_type,actor_user_id) values(p_ticket_id,'read',(select auth.uid()));end if;end if;end$$;
create or replace function public.acknowledge_urgent(p_ticket_id uuid) returns public.tickets language plpgsql security definer set search_path=public as $$declare v_me uuid:=public.current_team_user_id();v_ticket public.tickets;begin if v_me is null then raise exception 'Active staff account required';end if;update public.tickets set urgent_read_at=coalesce(urgent_read_at,now()),urgent_acknowledged_at=coalesce(urgent_acknowledged_at,now()),urgent_acknowledged_by=v_me where id=p_ticket_id and type='urgent_message' and assignee_id=v_me returning * into v_ticket;if not found then raise exception 'Only the urgent message recipient can acknowledge it';end if;update public.notifications set state='acknowledged',read_at=coalesce(read_at,now()),acknowledged_at=coalesce(acknowledged_at,now()),processed_at=now() where ticket_id=p_ticket_id and recipient_id=v_me and kind in ('urgent','urgent_retry');if not exists(select 1 from public.request_events where ticket_id=p_ticket_id and event_type='acknowledged') then insert into public.request_events(ticket_id,event_type,actor_user_id) values(p_ticket_id,'acknowledged',(select auth.uid()));end if;return v_ticket;end$$;
create or replace function public.register_push_subscription(p_endpoint text,p_p256dh text,p_auth_key text,p_device_label text default null) returns uuid language plpgsql security definer set search_path=public as $$declare v_me uuid:=public.current_team_user_id();v_id uuid;begin if v_me is null then raise exception 'Active staff account required';end if;insert into public.push_subscriptions(team_user_id,endpoint,p256dh,auth_key,device_label) values(v_me,p_endpoint,p_p256dh,p_auth_key,nullif(btrim(coalesce(p_device_label,'')),'')) on conflict(endpoint) do update set team_user_id=excluded.team_user_id,p256dh=excluded.p256dh,auth_key=excluded.auth_key,device_label=excluded.device_label,last_seen_at=now(),revoked_at=null returning id into v_id;return v_id;end$$;
create or replace function public.revoke_push_subscription(p_endpoint text) returns void language plpgsql security definer set search_path=public as $$declare v_me uuid:=public.current_team_user_id();begin if v_me is null then raise exception 'Active staff account required';end if;update public.push_subscriptions set revoked_at=now() where team_user_id=v_me and endpoint=p_endpoint;end$$;
create or replace function public.log_attachment_event() returns trigger language plpgsql security definer set search_path=public as $$begin insert into public.request_events(ticket_id,event_type,actor_user_id,metadata) values(new.ticket_id,'attachment_added',new.uploaded_by,jsonb_build_object('attachment_id',new.id,'name',new.original_name,'mime_type',new.mime_type));return new;end$$;
create trigger trg_log_attachment after insert on public.attachments for each row execute function public.log_attachment_event();

create or replace function public.enqueue_due_notifications() returns integer language plpgsql security definer set search_path=public as $$declare v_count integer:=0;v_added integer;begin
 insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key) select t.id,coalesce(t.assignee_id,creator.id),'overdue',t.id::text||':overdue:'||extract(epoch from t.next_followup_due_at)::bigint from public.tickets t join public.team_users creator on creator.auth_user_id=t.created_by and creator.is_active where t.status<>'Resolved' and t.next_followup_due_at<=now() on conflict(dedupe_key) do nothing;get diagnostics v_added=row_count;v_count:=v_count+v_added;
 insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key) select t.id,t.assignee_id,'urgent_retry',t.id::text||':urgent_retry' from public.tickets t where t.type='urgent_message' and t.status<>'Resolved' and t.urgent_acknowledged_at is null and t.urgent_retry_sent_at is null and t.created_at<=now()-interval '15 minutes' on conflict(dedupe_key) do nothing;get diagnostics v_added=row_count;v_count:=v_count+v_added;
 update public.tickets set urgent_retry_sent_at=now() where type='urgent_message' and status<>'Resolved' and urgent_acknowledged_at is null and urgent_retry_sent_at is null and created_at<=now()-interval '15 minutes';return v_count;end$$;
create or replace function public.claim_notification_batch(p_limit integer default 25) returns setof public.notifications language plpgsql security definer set search_path=public as $$begin if coalesce((select auth.role()),'')<>'service_role' then raise exception 'Service role required';end if;return query with claimed as (select id from public.notifications where state in ('queued','failed','processing') and scheduled_for<=now() and next_attempt_at<=now() and attempt_count<4 order by scheduled_for,id for update skip locked limit greatest(1,least(p_limit,100))) update public.notifications n set state='processing',attempt_count=n.attempt_count+1,next_attempt_at=now()+interval '5 minutes' from claimed where n.id=claimed.id returning n.*;end$$;

do $$declare r record;begin for r in select schemaname,tablename,policyname from pg_policies where schemaname='public' and tablename in ('clients','team_users','projects','tickets','attachments','status_history_v1_archive','request_events','notifications','delivery_attempts','push_subscriptions','worker_runs') loop execute format('drop policy if exists %I on %I.%I',r.policyname,r.schemaname,r.tablename);end loop;end$$;
drop type if exists public.ticket_type_v1;
alter table public.clients enable row level security;alter table public.team_users enable row level security;alter table public.projects enable row level security;alter table public.tickets enable row level security;alter table public.attachments enable row level security;alter table public.request_events enable row level security;alter table public.notifications enable row level security;alter table public.delivery_attempts enable row level security;alter table public.push_subscriptions enable row level security;alter table public.worker_runs enable row level security;
revoke all on public.clients,public.team_users,public.projects,public.tickets,public.attachments,public.request_events,public.notifications,public.delivery_attempts,public.push_subscriptions,public.worker_runs from anon,authenticated;
grant select on public.clients,public.team_users,public.projects,public.tickets,public.attachments,public.request_events,public.notifications,public.delivery_attempts,public.worker_runs to authenticated;grant insert on public.attachments to authenticated;
revoke execute on function public.create_request(public.request_type,text,uuid,uuid,timestamptz),public.record_request_update(uuid,public.ticket_status,text,text),public.assign_request(uuid,uuid),public.mark_request_read(uuid),public.acknowledge_urgent(uuid),public.register_push_subscription(text,text,text,text),public.revoke_push_subscription(text) from public,anon;
grant execute on function public.create_request(public.request_type,text,uuid,uuid,timestamptz),public.record_request_update(uuid,public.ticket_status,text,text),public.assign_request(uuid,uuid),public.mark_request_read(uuid),public.acknowledge_urgent(uuid),public.register_push_subscription(text,text,text,text),public.revoke_push_subscription(text) to authenticated;
revoke execute on function public.enqueue_due_notifications(),public.claim_notification_batch(integer) from public,anon,authenticated;grant execute on function public.enqueue_due_notifications(),public.claim_notification_batch(integer) to service_role;
create policy staff_roster_read on public.team_users for select to authenticated using(public.is_staff());create policy staff_clients_read on public.clients for select to authenticated using(public.is_staff());create policy staff_projects_read on public.projects for select to authenticated using(public.is_staff());create policy staff_tickets_read on public.tickets for select to authenticated using(public.is_staff());create policy staff_attachments_read on public.attachments for select to authenticated using(public.is_staff());create policy staff_attachments_add on public.attachments for insert to authenticated with check(public.is_staff() and uploaded_by=(select auth.uid()) and exists(select 1 from public.tickets where id=ticket_id));create policy staff_events_read on public.request_events for select to authenticated using(public.is_staff());create policy staff_notifications_read on public.notifications for select to authenticated using(public.is_staff());create policy staff_delivery_read on public.delivery_attempts for select to authenticated using(public.is_staff());create policy own_push_subscriptions_read on public.push_subscriptions for select to authenticated using(team_user_id=public.current_team_user_id());create policy staff_worker_runs_read on public.worker_runs for select to authenticated using(public.is_staff());

do $$declare r record;begin for r in select policyname from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'service_photos_%' loop execute format('drop policy if exists %I on storage.objects',r.policyname);end loop;end$$;
drop function if exists public.is_client_for_project(uuid);
update storage.buckets set public=false,file_size_limit=52428800,allowed_mime_types=array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'] where id='service-photos';
create policy request_media_staff_read on storage.objects for select to authenticated using(bucket_id='service-photos' and public.is_staff());
create policy request_media_staff_add on storage.objects for insert to authenticated with check(bucket_id='service-photos' and public.is_staff() and exists(select 1 from public.tickets where id::text=(storage.foldername(name))[1]));
create policy request_media_orphan_cleanup on storage.objects for delete to authenticated using(bucket_id='service-photos' and public.is_staff() and owner_id=(select auth.uid()::text) and not exists(select 1 from public.attachments where storage_path=name));
commit;

-- After importing the real roster, validate these deferred constraints:
-- alter table public.team_users validate constraint active_staff_requires_email;
-- alter table public.attachments validate constraint attachment_size;
