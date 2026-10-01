-- Phone-only Staff accounts; Admin keeps email for password recovery.
begin;
alter table public.team_users alter column email drop not null;
alter table public.team_users drop constraint if exists team_users_email_identity_check;
alter table public.team_users add constraint team_users_email_identity_check
 check (email is null or (email=btrim(email) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'));
alter table public.team_users drop constraint if exists team_users_active_admin_email_check;
alter table public.team_users add constraint team_users_active_admin_email_check
 check (not (is_active and role='admin') or nullif(btrim(email),'') is not null);
commit;
