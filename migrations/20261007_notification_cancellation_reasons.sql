-- Apply after 20261005_admin_managed_accounts.sql and 20261006_new_staff_request_access.sql.
-- Records the cause at the time of cancellation, even if work is later reopened.
begin;
alter table public.notifications add column if not exists cancellation_reason text
 check (cancellation_reason in ('request_resolved','request_updated','assignment_changed','recipient_inactive','urgent_acknowledged'));

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
  update public.notifications set state='cancelled',processed_at=now(),cancellation_reason=case when p_new_status='Resolved' then 'request_resolved' else 'request_updated' end
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
  update public.notifications set state='cancelled',processed_at=now(),cancellation_reason='assignment_changed' where ticket_id=p_ticket_id and state in ('queued','processing','failed') and kind in ('assigned','urgent','urgent_retry');
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
    update public.notifications set state='cancelled',processed_at=now(),cancellation_reason='recipient_inactive' where recipient_id=p_team_user_id and state in ('queued','processing','failed');
  end if;
end; $$;

create or replace function public.set_managed_staff_access(p_actor uuid,p_team_user_id uuid,p_active boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'service_role' or not exists(select 1 from public.team_users where auth_user_id=p_actor and role='admin' and is_active) then raise exception 'Only active Admin can manage accounts'; end if;
 perform 1 from public.team_users where id=p_team_user_id and role='staff' for update;
 if not found or p_active is null then raise exception 'Select a Staff account'; end if;
 if not p_active and exists(select 1 from public.tickets where assignee_id=p_team_user_id and status<>'Resolved') then raise exception 'Resolve or reassign open work before deactivation'; end if;
 update public.team_users set is_active=p_active where id=p_team_user_id;
 if not p_active then
  update public.push_subscriptions set revoked_at=now() where team_user_id=p_team_user_id and revoked_at is null;
  update public.notifications set state='cancelled',processed_at=now(),cancellation_reason='recipient_inactive' where recipient_id=p_team_user_id and state in ('queued','processing','failed');
 end if;
 insert into public.account_events(actor_user_id,team_user_id,action) values(p_actor,p_team_user_id,case when p_active then 'activated' else 'deactivated' end);
end; $$;

-- CREATE OR REPLACE preserves existing function grants. Keep account management
-- restricted to the service role; this migration must not open a browser bypass.
revoke all on function public.set_managed_staff_access(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.set_managed_staff_access(uuid,uuid,boolean) to service_role;

-- Historical evidence must match the cancellation transaction timestamp exactly.
-- Leave unknown or ambiguous history empty instead of using today's request state.
with evidence as (
 select n.id,'request_resolved' as reason
 from public.notifications n join public.request_events e on e.ticket_id=n.ticket_id
 where n.state='cancelled' and n.cancellation_reason is null
 and e.event_type='resolved' and e.created_at=n.processed_at
 union all
 select n.id,'request_updated'
 from public.notifications n join public.request_events e on e.ticket_id=n.ticket_id
 where n.state='cancelled' and n.cancellation_reason is null and n.kind='overdue'
 and e.event_type in ('status_updated','reopened') and e.created_at=n.processed_at
 union all
 select n.id,'assignment_changed'
 from public.notifications n join public.request_events e on e.ticket_id=n.ticket_id
 where n.state='cancelled' and n.cancellation_reason is null
 and n.kind in ('assigned','urgent','urgent_retry')
 and e.event_type='assigned' and e.created_at=n.processed_at
 and e.metadata->>'old_assignee_id'=n.recipient_id::text
 union all
 select n.id,'recipient_inactive'
 from public.notifications n join public.account_events e on e.team_user_id=n.recipient_id
 where n.state='cancelled' and n.cancellation_reason is null
 and e.action='deactivated' and e.created_at=n.processed_at
), confirmed as (
 select id,min(reason) as reason from evidence group by id having count(distinct reason)=1
)
update public.notifications n set cancellation_reason=c.reason
from confirmed c where n.id=c.id;
commit;
