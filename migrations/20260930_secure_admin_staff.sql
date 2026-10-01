-- Apply to an existing workflow database before creating staff accounts.
begin;
alter table public.team_users drop constraint if exists team_users_role_check;
alter table public.team_users add constraint team_users_role_check check (role in ('admin','staff'));
alter table public.team_users alter column email drop not null;
alter table public.team_users drop constraint if exists team_users_active_admin_email_check;
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
