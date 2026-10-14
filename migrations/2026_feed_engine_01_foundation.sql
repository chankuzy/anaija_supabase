-- Anaija Feed Engine · migration 01 · foundation
-- Visibility semantics, feed eligibility, exposure/stats/event/session storage.
-- Additive only. No existing row becomes guest-visible: public_since stays NULL
-- for legacy rows until you explicitly backfill it (see docs/feed-engine/PROGRESS.md).
begin;

-- 1. posts: guest-visibility marker + normalized institution ------------------
alter table public.posts
  add column if not exists public_since timestamptz,
  add column if not exists institution_id bigint references public.institutions(id) on delete set null;

comment on column public.posts.public_since is
  'Set when the post became intentionally public. NULL = never guest-visible (legacy rows included).';
comment on column public.posts.institution_id is
  'Normalized from context->>institution_id at insert. Used by candidate generation.';

-- safe backfill of institution_id (CASE guarantees the cast only runs on numeric text)
update public.posts p
   set institution_id = (p.context->>'institution_id')::bigint
 where p.institution_id is null
   and case when (p.context->>'institution_id') ~ '^[0-9]{1,18}$'
            then exists (select 1 from public.institutions i
                          where i.id = (p.context->>'institution_id')::bigint)
            else false end;

create or replace function public.trg_posts_feed_fields() returns trigger
language plpgsql as $$
declare v_inst bigint;
begin
  -- Only when visibility is set/changed: a like or pin must never flip guest visibility.
  if TG_OP = 'INSERT' or NEW.visibility is distinct from OLD.visibility then
    if NEW.visibility = 'public' then
      NEW.public_since := coalesce(NEW.public_since, now());
    else
      NEW.public_since := null;
    end if;
  end if;

  if TG_OP = 'INSERT' and NEW.institution_id is null then
    if (NEW.context->>'institution_id') ~ '^[0-9]{1,18}$' then
      select i.id into v_inst from public.institutions i
       where i.id = (NEW.context->>'institution_id')::bigint;
      NEW.institution_id := v_inst;
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists posts_feed_fields on public.posts;
create trigger posts_feed_fields
  before insert or update of visibility on public.posts
  for each row execute function public.trg_posts_feed_fields();

-- 2. indexes for candidate generation (predicate mirrors feed_eligible_posts) -----
create index if not exists posts_feed_fresh_idx on public.posts (created_at desc, id desc)
  where is_active and deleted_at is null and processing_status = 'ready'
    and expires_at is null and community_id is null and type in ('post','listing');

create index if not exists posts_feed_inst_idx on public.posts (institution_id, created_at desc)
  where is_active and deleted_at is null and processing_status = 'ready'
    and expires_at is null and community_id is null and type in ('post','listing')
    and institution_id is not null;

create index if not exists posts_feed_public_idx on public.posts (created_at desc)
  where is_active and deleted_at is null and processing_status = 'ready'
    and expires_at is null and community_id is null and type in ('post','listing')
    and public_since is not null;

create index if not exists users_institution_active_idx on public.users (institution_id)
  where is_active and deleted_at is null;

-- 3. eligibility: ONE definition of "may this ever appear in a feed" ---------------
create or replace view public.feed_eligible_posts as
select p.id,
       p.user_id            as author_id,
       p.type, p.subtype, p.listing_type,
       p.created_at,
       p.visibility, p.public_since, p.institution_id,
       p.hashtags::jsonb    as hashtags,
       u.institution_id     as author_institution_id
  from public.posts p
  join public.users u
    on u.id = p.user_id and u.is_active and u.deleted_at is null
  left join public.listing_details ld on ld.post_id = p.id
 where p.is_active and p.deleted_at is null and p.processing_status = 'ready'
   and p.expires_at is null and p.community_id is null
   and p.type in ('post','listing')
   and (p.type <> 'listing' or ld.status = 'available')
   and (coalesce(p.video_key, '') <> ''
        or exists (select 1 from public.post_media m
                    where m.post_id = p.id and m.purged_at is null
                      and m.processing_status = 'ready'));

-- 4. visibility: guest (viewer NULL) vs authenticated, blocks both ways ------------
-- Plain SQL, no SECURITY DEFINER / SET, so the planner can inline it.
create or replace function public.feed_visible_to(
  p_viewer bigint, p_author bigint, p_visibility text,
  p_public_since timestamptz, p_post_inst bigint
) returns boolean language sql stable as $$
  select case
    when p_viewer is null then (p_visibility = 'public' and p_public_since is not null)
    when p_author = p_viewer then true
    when exists (select 1 from public.user_blocks b
                  where (b.blocker_id = p_viewer and b.blocked_id = p_author)
                     or (b.blocker_id = p_author and b.blocked_id = p_viewer)) then false
    when p_visibility = 'public' then true
    when p_visibility = 'followers' then exists (
      select 1 from public.follows f
       where f.follower_id = p_viewer and f.following_id = p_author)
    when p_visibility = 'campus' then (p_post_inst is not null and exists (
      select 1 from public.users u
       where u.id = p_viewer and u.institution_id = p_post_inst))
    else false
  end
$$;

-- Re-check a delivered batch at hydration time (deletes, blocks, sold listings, visibility edits).
create or replace function public.feed_filter_visible(p_viewer bigint, p_ids bigint[])
returns table (post_id bigint) language sql stable as $$
  select e.id
    from public.feed_eligible_posts e
   where e.id = any (p_ids)
     and public.feed_visible_to(p_viewer, e.author_id, e.visibility, e.public_since, e.institution_id)
$$;

-- 5. per-post aggregates: every counter counts UNIQUE users --------------------------
create table if not exists public.feed_post_stats (
  post_id          bigint primary key references public.posts(id) on delete cascade,
  impressions      int not null default 0,   -- unique users who saw it
  views            int not null default 0,   -- unique users with a meaningful view
  completions      int not null default 0,
  rewatches        int not null default 0,
  skips            int not null default 0,
  likes            int not null default 0,
  comments         int not null default 0,
  saves            int not null default 0,
  shares           int not null default 0,
  reposts          int not null default 0,
  follows_from     int not null default 0,
  negatives        int not null default 0,   -- not_interested + hide_creator
  first_exposed_at timestamptz,
  updated_at       timestamptz not null default now()
);

insert into public.feed_post_stats (post_id, likes, comments, saves, reposts)
select p.id,
       (select count(*) from public.post_likes l where l.post_id = p.id)::int,
       (select count(*) from public.comments c where c.post_id = p.id and c.deleted_at is null)::int,
       (select count(*) from public.bookmarks b where b.post_id = p.id)::int,
       (select count(*) from public.reposts r where r.post_id = p.id)::int
  from public.posts p
 where p.type in ('post','listing')
on conflict (post_id) do nothing;

-- 6. exposure: one row per (user, post). Drives "seen" filtering + unique counting. ----
create table if not exists public.feed_exposures (
  user_id       bigint not null references public.users(id) on delete cascade,
  post_id       bigint not null references public.posts(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  seen_count    smallint not null default 1,
  best_outcome  smallint not null default 0,  -- 0 seen, 1 skipped, 2 viewed, 3 completed
  negative      boolean not null default false,
  src           text,                          -- candidate source that first surfaced it
  primary key (user_id, post_id)
);
create index if not exists feed_exposures_user_recent_idx on public.feed_exposures (user_id, last_seen_at desc);
create index if not exists feed_exposures_post_idx on public.feed_exposures (post_id);

-- 7. raw behavioural events (14-day retention; aggregates live above) ------------------
create table if not exists public.feed_events (
  id             bigint generated always as identity primary key,
  user_id        bigint not null references public.users(id) on delete cascade,
  event_id       uuid not null,
  kind           text not null check (kind in (
                   'impression','consume','share','profile_visit','listing_open',
                   'not_interested','hide_creator',
                   'like','comment','save','repost','follow',
                   'suggestion_impression','suggestion_open','suggestion_follow','suggestion_dismiss')),
  origin         text not null default 'client' check (origin in ('client','server')),
  post_id        bigint references public.posts(id) on delete cascade,
  target_user_id bigint references public.users(id) on delete cascade,
  session_id     uuid,
  surface        text,
  src            text,
  slot           smallint,
  dwell_ms       int check (dwell_ms is null or dwell_ms between 0 and 3600000),
  watch_ms       int check (watch_ms is null or watch_ms between 0 and 3600000),
  media_ms       int check (media_ms is null or media_ms between 0 and 14400000),
  loops          smallint check (loops is null or loops between 0 and 100),
  outcome        text check (outcome is null or outcome in ('skip','glance','view','complete')),
  created_at     timestamptz not null default now(),
  constraint feed_events_user_event_uidx unique (user_id, event_id)
);
create index if not exists feed_events_user_created_idx on public.feed_events (user_id, created_at desc);
create index if not exists feed_events_post_idx on public.feed_events (post_id) where post_id is not null;
create index if not exists feed_events_created_idx on public.feed_events (created_at);

-- 8. feed sessions: bounded server-side state behind the signed cursor -----------------
create table if not exists public.feed_sessions (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     bigint references public.users(id) on delete cascade,
  mode                        text not null default 'auth' check (mode in ('auth','guest')),
  scope                       text not null default 'for_you',
  items                       jsonb not null default '[]'::jsonb,  -- ordered, composed, not-yet-delivered
  pos                         int not null default 0,
  delivered                   int not null default 0,
  consumed                    int not null default 0,
  suggestions_shown           smallint not null default 0,
  consumed_at_last_suggestion int not null default 0,
  rebuilds                    smallint not null default 0,
  config_version              text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  expires_at                  timestamptz not null default now() + interval '30 minutes',
  constraint feed_sessions_mode_user_chk check ((mode = 'guest') = (user_id is null))
);
create index if not exists feed_sessions_user_idx on public.feed_sessions (user_id, created_at desc) where user_id is not null;
create index if not exists feed_sessions_expires_idx on public.feed_sessions (expires_at);

-- 9. retention -------------------------------------------------------------------------
create or replace function public.feed_purge() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from feed_events    where created_at   < now() - interval '14 days';
  delete from feed_sessions  where expires_at   < now() - interval '1 hour';
  delete from feed_exposures where last_seen_at < now() - interval '45 days';
end $$;

select cron.schedule('feed-purge', '23 3 * * *', $$ select public.feed_purge(); $$);

-- 10. lock down: service role only (custom auth lives in edge functions) ----------------
do $$ declare t text; begin
  foreach t in array array['feed_post_stats','feed_exposures','feed_events','feed_sessions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

revoke all on public.feed_eligible_posts from anon, authenticated;
grant select on public.feed_eligible_posts to service_role;

revoke all on function public.feed_visible_to(bigint, bigint, text, timestamptz, bigint) from public, anon, authenticated;
revoke all on function public.feed_filter_visible(bigint, bigint[]) from public, anon, authenticated;
revoke all on function public.feed_purge() from public, anon, authenticated;
revoke all on function public.trg_posts_feed_fields() from public, anon, authenticated;
grant execute on function public.feed_visible_to(bigint, bigint, text, timestamptz, bigint) to service_role;
grant execute on function public.feed_filter_visible(bigint, bigint[]) to service_role;
grant execute on function public.feed_purge() to service_role;

commit;
