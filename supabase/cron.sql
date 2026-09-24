-- Run once after deploying the Edge Functions.
-- First create Vault secrets named project_url and service_role_key.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$begin
  if exists(select 1 from cron.job where jobname='oak-notification-worker') then perform cron.unschedule('oak-notification-worker'); end if;
  if exists(select 1 from cron.job where jobname='oak-notification-scan') then perform cron.unschedule('oak-notification-scan'); end if;
end$$;

select cron.schedule('oak-notification-worker','* * * * *',$$
  select net.http_post(
    url:=(select decrypted_secret from vault.decrypted_secrets where name='project_url')||'/functions/v1/notification-worker',
    headers:=jsonb_build_object('content-type','application/json','authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='service_role_key')),
    body:='{}'::jsonb
  );
$$);

select cron.schedule('oak-notification-scan','*/5 * * * *',$$
  select net.http_post(
    url:=(select decrypted_secret from vault.decrypted_secrets where name='project_url')||'/functions/v1/notification-scan',
    headers:=jsonb_build_object('content-type','application/json','authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='service_role_key')),
    body:='{}'::jsonb
  );
$$);
