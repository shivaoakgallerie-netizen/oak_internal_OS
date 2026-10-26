-- New Admin-created Staff accounts can submit requests immediately.
-- Existing accounts retain their activation setting on profile/password updates.
begin;
create or replace function public.save_managed_staff(p_actor uuid,p_auth_user_id uuid,p_name text,p_phone text,p_email text,p_notification_email text,p_department text,p_action text)
returns public.team_users language plpgsql security definer set search_path=public as $$
declare v_member public.team_users;
begin
 if coalesce(auth.role(),'')<>'service_role' or not exists(select 1 from public.team_users where auth_user_id=p_actor and role='admin' and is_active) then raise exception 'Only active Admin can manage accounts'; end if;
 if p_action not in ('created','profile_updated','password_reset') then raise exception 'Invalid account action'; end if;
 if nullif(btrim(p_name),'') is null or char_length(p_name)>200 or char_length(p_department)>200 then raise exception 'Invalid staff name or department'; end if;
 if exists(select 1 from public.team_users where auth_user_id=p_auth_user_id and role<>'staff') then raise exception 'Use your own account settings for Admin credentials'; end if;
 insert into public.team_users(auth_user_id,name,phone,email,notification_email,department,role,is_active)
 values(p_auth_user_id,btrim(p_name),p_phone,lower(btrim(p_email)),nullif(lower(btrim(p_notification_email)),''),coalesce(nullif(btrim(p_department),''),'Team'),'staff',true)
 on conflict(auth_user_id) do update set name=excluded.name,phone=excluded.phone,email=excluded.email,notification_email=excluded.notification_email,department=excluded.department returning * into v_member;
 insert into public.account_events(actor_user_id,team_user_id,action) values(p_actor,v_member.id,p_action);
 return v_member;
end; $$;
revoke all on function public.save_managed_staff(uuid,uuid,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.save_managed_staff(uuid,uuid,text,text,text,text,text,text) to service_role;

commit;
