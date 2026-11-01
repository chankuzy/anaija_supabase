-- Anaija Moments · migration 02 · war duration (clock starts when both sides accept)
begin;
alter table public.moment_war_config
  add column if not exists duration_minutes int not null default 1440
  check (duration_minutes between 15 and 10080);
commit;
