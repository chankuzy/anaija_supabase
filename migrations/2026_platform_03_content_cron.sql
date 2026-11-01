-- Anaija Platform · migration 03 · Content Studio scheduler
-- Requires migration 02 and the vault secret 'platform_cron_secret' (same value as the PLATFORM_CRON_SECRET edge secret).
begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin
  if to_regclass('public.platform_content') is null then
    raise exception 'Run migration 02 first';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'platform_cron_secret') then
    raise exception 'Create the vault secret platform_cron_secret first';
  end if;
end $$;

select cron.schedule('platform-content-publish', '* * * * *', $cron$
  select net.http_post(
    url := 'https://eqwcndxdbfljsjxsduid.supabase.co/functions/v1/platform/content/publish-due',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'platform_cron_secret' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
$cron$);

commit;
