create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('activity-sweep', '* * * * *', $$
  select net.http_post(
    url := 'https://eqwcndxdbfljsjxsduid.supabase.co/functions/v1/activity/dispatch',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{"sweep": true}'::jsonb,
    timeout_milliseconds := 10000
  );
$$);

select cron.schedule('activity-purge', '17 3 * * *', $$ select public.activity_purge(); $$);
