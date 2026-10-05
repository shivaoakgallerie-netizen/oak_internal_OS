-- Apply after the secure Admin/Staff and notification-email migrations.
-- Requires Supabase Auth database audit logging. Missing evidence fails closed.
begin;
revoke all on auth.audit_log_entries from anon,authenticated;
create table if not exists public.account_events (
 id uuid primary key default gen_random_uuid(), actor_user_id uuid not null,
 team_user_id uuid references public.team_users(id), action text not null,
 created_at timestamptz not null default now()
);
alter table public.account_events enable row level security;
revoke all on public.account_events from public,anon,authenticated;
grant select on public.account_events to authenticated;
grant all on public.account_events to service_role;
drop policy if exists admin_account_events_read on public.account_events;
create policy admin_account_events_read on public.account_events for select to authenticated using(public.is_admin());
drop trigger if exists immutable_account_events on public.account_events;
create trigger immutable_account_events before update or delete on public.account_events for each row execute function public.prevent_event_mutation();

-- Reject self-service token issuance before Auth can send an unusable email or
-- SMS. The Admin API sets credentials directly and clears pending tokens.
create or replace function public.deny_staff_credential_requests() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.team_users where auth_user_id=new.id and role='staff')
 and exists(select 1 from unnest(array['recovery_token','confirmation_token','phone_change_token','reauthentication_token','email_change_token_current','email_change_token_new','email_change','phone_change']) as f
   where coalesce(to_jsonb(new)->>f,'')<>'' and (to_jsonb(new)->>f) is distinct from (to_jsonb(old)->>f)) then
  raise exception 'Staff credentials are managed by Admin. Contact your administrator.' using errcode='42501';
 end if;
 return new;
end; $$;
revoke all on function public.deny_staff_credential_requests() from public,anon,authenticated;
drop trigger if exists deny_staff_credential_requests on auth.users;
create trigger deny_staff_credential_requests before update on auth.users for each row execute function public.deny_staff_credential_requests();

create or replace function public.guard_staff_credentials() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.team_users where auth_user_id=new.id and role='staff') then return new; end if;
 if new.encrypted_password is not distinct from old.encrypted_password
    and new.email is not distinct from old.email and new.phone is not distinct from old.phone
    and new.role is not distinct from old.role
    and (new.recovery_token is not distinct from old.recovery_token or coalesce(new.recovery_token,'')='')
    and (new.email_change is not distinct from old.email_change or coalesce(new.email_change,'')='')
    and (new.phone_change is not distinct from old.phone_change or coalesce(new.phone_change,'')='')
    and not exists(select 1 from unnest(array['confirmation_token','phone_change_token','reauthentication_token','email_change_token_current','email_change_token_new']) as f
      where coalesce(to_jsonb(new)->>f,'')<>'' and (to_jsonb(new)->>f) is distinct from (to_jsonb(old)->>f)) then return new; end if;
 -- GoTrue writes user_modified with a service_role actor in the SAME transaction
 -- for its Admin API. UserUpdate/recovery never writes this trusted evidence.
 -- Check transaction identity, not timestamps or user-editable metadata.
 if not exists(select 1 from auth.audit_log_entries a
   where a.xmin::text=(pg_catalog.txid_current()%4294967296)::text
   and a.payload->>'action'='user_modified'
   and a.payload->>'actor_id'='00000000-0000-0000-0000-000000000000'
   and a.payload->>'actor_username'='service_role'
   and a.payload->'traits'->>'user_id'=new.id::text) then
   raise exception 'Staff credentials are managed by Admin. Contact your administrator.' using errcode='42501';
 end if;
 return new;
end; $$;
revoke all on function public.guard_staff_credentials() from public,anon,authenticated;
drop trigger if exists admin_managed_staff_credentials on auth.users;
create constraint trigger admin_managed_staff_credentials after update on auth.users
 deferrable initially deferred for each row execute function public.guard_staff_credentials();

-- Keep login identities synchronized in the Auth transaction. Unique roster
-- constraints also reject conflicting phone/email changes before Auth commits.
create or replace function public.sync_managed_login() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.email is distinct from old.email or new.phone is distinct from old.phone then
   update public.team_users set email=nullif(new.email,''),phone='+'||ltrim(new.phone,'+') where auth_user_id=new.id;
 end if;
 return new;
end; $$;
revoke all on function public.sync_managed_login() from public,anon,authenticated;
drop trigger if exists sync_managed_login on auth.users;
create trigger sync_managed_login after update of email,phone on auth.users for each row execute function public.sync_managed_login();

create or replace function public.save_managed_staff(p_actor uuid,p_auth_user_id uuid,p_name text,p_phone text,p_email text,p_notification_email text,p_department text,p_action text)
returns public.team_users language plpgsql security definer set search_path=public as $$
declare v_member public.team_users;
begin
 if coalesce(auth.role(),'')<>'service_role' or not exists(select 1 from public.team_users where auth_user_id=p_actor and role='admin' and is_active) then raise exception 'Only active Admin can manage accounts'; end if;
 if p_action not in ('created','profile_updated','password_reset') then raise exception 'Invalid account action'; end if;
 if nullif(btrim(p_name),'') is null or char_length(p_name)>200 or char_length(p_department)>200 then raise exception 'Invalid staff name or department'; end if;
 if exists(select 1 from public.team_users where auth_user_id=p_auth_user_id and role<>'staff') then raise exception 'Use your own account settings for Admin credentials'; end if;
 insert into public.team_users(auth_user_id,name,phone,email,notification_email,department,role)
 values(p_auth_user_id,btrim(p_name),p_phone,lower(btrim(p_email)),nullif(lower(btrim(p_notification_email)),''),coalesce(nullif(btrim(p_department),''),'Team'),'staff')
 on conflict(auth_user_id) do update set name=excluded.name,phone=excluded.phone,email=excluded.email,notification_email=excluded.notification_email,department=excluded.department returning * into v_member;
 insert into public.account_events(actor_user_id,team_user_id,action) values(p_actor,v_member.id,p_action);
 return v_member;
end; $$;
revoke all on function public.save_managed_staff(uuid,uuid,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.save_managed_staff(uuid,uuid,text,text,text,text,text,text) to service_role;

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
  update public.notifications set state='cancelled',processed_at=now() where recipient_id=p_team_user_id and state in ('queued','processing','failed');
 end if;
 insert into public.account_events(actor_user_id,team_user_id,action) values(p_actor,p_team_user_id,case when p_active then 'activated' else 'deactivated' end);
end; $$;
revoke all on function public.set_managed_staff_access(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.set_managed_staff_access(uuid,uuid,boolean) to service_role;
commit;
