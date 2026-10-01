-- A shared notification inbox must never become a shared login identity.
begin;
alter table public.team_users alter column email drop not null;
alter table public.team_users add column if not exists notification_email text;
alter table public.team_users drop constraint if exists team_users_notification_email_check;
alter table public.team_users add constraint team_users_notification_email_check
 check (notification_email is null or (notification_email=btrim(notification_email) and notification_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'));
alter table public.team_users drop constraint if exists team_users_active_admin_email_check;
alter table public.team_users add constraint team_users_active_admin_email_check
 check (not (is_active and role='admin') or nullif(btrim(email),'') is not null);
-- Existing email identities and all request/history records stay unchanged.
commit;
