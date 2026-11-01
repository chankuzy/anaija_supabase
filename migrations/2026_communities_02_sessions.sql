-- Anaija Communities · migration 02 · anonymous sessions + community notification kinds
begin;

do $$ begin
  if to_regclass('public.communities') is null or to_regclass('public.community_members') is null
     or to_regclass('public.activity_policy') is null or to_regprocedure('public.activity_record(bigint,bigint,text,text,text,text,bigint,bigint,bigint,jsonb,timestamptz,boolean,timestamptz)') is null then
    raise exception 'Sessions preflight failed: run migration 01 and the activity inbox migrations first';
  end if;
end $$;

-- 1. sessions ------------------------------------------------------------------------------------
create table if not exists public.community_sessions (
  id bigint generated always as identity primary key,
  community_id bigint not null references public.communities(id) on delete cascade,
  host_id bigint not null references public.users(id),
  code text not null unique,
  type text not null default 'anonymous_feed' check (type in ('anonymous_feed')),
  title text not null check (char_length(title) between 1 and 120),
  description text check (description is null or char_length(description) <= 500),
  status text not null default 'live' check (status in ('scheduled','live','ended')),
  starts_at timestamptz,
  ends_at timestamptz,
  ended_at timestamptz,
  ended_by bigint references public.users(id),
  allow_preview boolean not null default true,
  replies_enabled boolean not null default true,
  reactions_enabled boolean not null default true,
  notify_members boolean not null default false,
  realtime_key uuid not null default gen_random_uuid(),
  posts_count int not null default 0,
  participants_count int not null default 0,
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists community_sessions_community_idx on public.community_sessions (community_id, id desc) where not is_archived;
create index if not exists community_sessions_tick_idx on public.community_sessions (status, starts_at, ends_at) where status in ('scheduled','live');

-- 2. anonymous posts + replies. author_id is NEVER returned by any endpoint. -----------------------------
create table if not exists public.session_posts (
  id bigint generated always as identity primary key,
  session_id bigint not null references public.community_sessions(id) on delete cascade,
  parent_id bigint references public.session_posts(id) on delete cascade,
  author_id bigint not null references public.users(id) on delete cascade,
  alias_no int not null,
  body text not null check (char_length(body) between 1 and 1000),
  reactions_count int not null default 0,
  replies_count int not null default 0,
  removed_at timestamptz,
  removed_by bigint references public.users(id),
  removed_reason text,
  created_at timestamptz not null default now()
);
create index if not exists session_posts_feed_idx on public.session_posts (session_id, id desc) where parent_id is null and removed_at is null;
create index if not exists session_posts_replies_idx on public.session_posts (parent_id, id) where parent_id is not null and removed_at is null;
create index if not exists session_posts_rate_idx on public.session_posts (session_id, author_id, created_at desc);

create table if not exists public.session_aliases (
  session_id bigint not null references public.community_sessions(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  alias_no int not null,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id),
  unique (session_id, alias_no)
);

create table if not exists public.session_reactions (
  post_id bigint not null references public.session_posts(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  kind text not null default 'like' check (kind in ('like','fire','laugh','wow','sad')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.session_blocks (
  session_id bigint not null references public.community_sessions(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  blocked_by bigint references public.users(id),
  reason text,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

-- random per-session alias (not sequential, so it doesn't leak join order) -----------------------------
create or replace function public.session_alias(p_session bigint, p_user bigint) returns int
language plpgsql security definer set search_path = public as $$
declare v int; n int := 0;
begin
  select alias_no into v from session_aliases where session_id = p_session and user_id = p_user;
  if found then return v; end if;
  perform pg_advisory_xact_lock(hashtextextended('session_alias|' || p_session::text, 0));
  select alias_no into v from session_aliases where session_id = p_session and user_id = p_user;
  if found then return v; end if;
  loop
    v := 1000 + floor(random() * 99000)::int;
    begin
      insert into session_aliases (session_id, user_id, alias_no) values (p_session, p_user, v);
      exit;
    exception when unique_violation then
      n := n + 1;
      if n > 30 then raise exception 'alias space exhausted'; end if;
    end;
  end loop;
  update community_sessions set participants_count = participants_count + 1 where id = p_session;
  return v;
end $$;

-- counters -------------------------------------------------------------------------------------------
create or replace function public.trg_session_post_counts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.parent_id is null then
      update community_sessions set posts_count = posts_count + 1 where id = NEW.session_id;
    else
      update session_posts set replies_count = replies_count + 1 where id = NEW.parent_id;
    end if;
  elsif TG_OP = 'UPDATE' and OLD.removed_at is null and NEW.removed_at is not null then
    if NEW.parent_id is null then
      update community_sessions set posts_count = greatest(0, posts_count - 1) where id = NEW.session_id;
    else
      update session_posts set replies_count = greatest(0, replies_count - 1) where id = NEW.parent_id;
    end if;
  elsif TG_OP = 'UPDATE' and OLD.removed_at is not null and NEW.removed_at is null then
    if NEW.parent_id is null then
      update community_sessions set posts_count = posts_count + 1 where id = NEW.session_id;
    else
      update session_posts set replies_count = replies_count + 1 where id = NEW.parent_id;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists session_post_counts on public.session_posts;
create trigger session_post_counts after insert or update of removed_at on public.session_posts
  for each row execute function public.trg_session_post_counts();

create or replace function public.trg_session_reaction_counts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    update session_posts set reactions_count = reactions_count + 1 where id = NEW.post_id;
  elsif TG_OP = 'DELETE' then
    update session_posts set reactions_count = greatest(0, reactions_count - 1) where id = OLD.post_id;
  end if;
  return null;
end $$;
drop trigger if exists session_reaction_counts on public.session_reactions;
create trigger session_reaction_counts after insert or delete on public.session_reactions
  for each row execute function public.trg_session_reaction_counts();

-- lifecycle: scheduled -> live -> ended (the API also evaluates this lazily, so it is correct even if cron lags)
create or replace function public.community_sessions_tick() returns void
language plpgsql security definer set search_path = public as $$
begin
  update community_sessions set status = 'live'
   where status = 'scheduled' and starts_at is not null and starts_at <= now()
     and (ends_at is null or ends_at > now());
  update community_sessions set status = 'ended', ended_at = coalesce(ended_at, ends_at)
   where status in ('scheduled', 'live') and ends_at is not null and ends_at <= now();
end $$;

do $$ begin
  perform cron.schedule('community-sessions-tick', '* * * * *', $c$ select public.community_sessions_tick(); $c$);
exception when others then
  raise notice 'pg_cron not available, sessions rely on lazy evaluation: %', sqlerrm;
end $$;

-- 3. notifications: new kinds ride the existing activity inbox + push outbox -------------------------------
insert into public.activity_policy (kind, merge, window_secs, max_life_secs, restore_secs, push_mode, push_cooldown_secs) values
  ('community_request',    true,  21600, 86400, 0, 'item', 1800),
  ('community_decision',   false, 0,     0,     0, 'each', 0),
  ('community_invite',     false, 0,     0,     0, 'each', 0),
  ('community_announcement', false, 0,   0,     0, 'each', 0),
  ('community_mention',    false, 0,     0,     0, 'each', 0),
  ('community_moderation', false, 0,     0,     0, 'each', 0),
  ('session_live',         false, 0,     0,     0, 'each', 0)
on conflict (kind) do nothing;

-- thin wrapper so the edge API can call the (otherwise locked) activity engine
create or replace function public.community_notify(
  p_recipient bigint, p_actor bigint, p_kind text, p_group_key text, p_dedupe text,
  p_community bigint, p_payload jsonb default '{}'::jsonb, p_push boolean default true
) returns bigint language sql security definer set search_path = public as $$
  select public.activity_record(
    p_recipient => p_recipient, p_actor => p_actor, p_kind => p_kind,
    p_group_key => p_group_key, p_dedupe => p_dedupe,
    p_target_kind => 'community', p_target_id => p_community,
    p_payload => coalesce(p_payload, '{}'::jsonb), p_push => p_push)
$$;

-- 4. lock down ---------------------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['community_sessions','session_posts','session_aliases','session_reactions','session_blocks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to service_role;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'session\_%' or p.proname like 'trg\_session\_%'
                   or p.proname like 'community\_%' or p.proname like 'trg\_community\_%') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

commit;
