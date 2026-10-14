-- Anaija Feed Engine · migration 02 · behavioural signals, affinity, ingest
-- Requires migration 01. Additive. Triggers never fail a user action (errors -> activity_errors).
begin;

-- 0. adjustments to migration 01 ------------------------------------------------------
alter table public.feed_exposures add column if not exists acts smallint not null default 0;
comment on column public.feed_exposures.acts is
  'bit flags (unique-user semantics): 1 impressed, 2 shared, 4 liked, 8 commented, 16 saved, 32 reposted, 64 followed_from, 128 profile_visit, 256 listing_open';
comment on column public.feed_exposures.best_outcome is
  '0 seen, 1 skip, 2 glance, 3 view, 4 complete, 5 rewatch';
alter table public.feed_post_stats add column if not exists delivered int not null default 0;
create index if not exists bookmarks_post_idx on public.bookmarks (post_id);

do $$ declare c record; begin
  for c in select conname from pg_constraint
            where conrelid = 'public.feed_events'::regclass and contype = 'c'
              and (pg_get_constraintdef(oid) like '%suggestion_impression%'
                or pg_get_constraintdef(oid) like '%glance%')
  loop
    execute format('alter table public.feed_events drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.feed_events add constraint feed_events_kind_chk check (kind in (
  'impression','consume','share','profile_visit','listing_open','not_interested','hide_creator',
  'follow_from_post','like','comment','save','repost','follow',
  'suggestion_impression','suggestion_open','suggestion_follow','suggestion_dismiss'));
alter table public.feed_events add constraint feed_events_outcome_chk check (
  outcome is null or outcome in ('skip','glance','view','complete','rewatch'));

-- 1. config (tune with UPDATE; no redeploy) --------------------------------------------
create table if not exists public.feed_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.feed_config (key, value) values
('meta',   $j${"version":"v1"}$j$::jsonb),
('ingest', $j${"max_batch":50,"max_per_min":240}$j$::jsonb),
('consume',$j${
  "image":{"skip_ms":700,"view_ms":2000,"complete_ms":8000},
  "video":{"default_ms":15000,"skip_ms":1200,
           "short_ms":15000,"short_view_abs_ms":2500,"short_view_frac":0.6,"short_complete_frac":0.9,
           "view_abs_ms":3000,"view_frac":0.4,"complete_frac":0.85,
           "long_ms":60000,"long_view_abs_ms":8000,"long_view_frac":0.12,"long_complete_frac":0.7,
           "rewatch_frac":1.8}
}$j$::jsonb),
('delta',  $j${"view":0.25,"complete":0.5,"rewatch":0.8,"skip":-0.12,
              "like":1.0,"unlike":-1.0,"comment":1.2,"save":1.5,"unsave":-1.5,
              "share":1.2,"repost":1.2,"unrepost":-1.2,"follow":2.0,"unfollow":-1.5,
              "profile_visit":0.4,"listing_open":0.8,"not_interested":-1.5,
              "hide_creator":-3.0,"suggestion_dismiss":-0.5}$j$::jsonb),
('affinity',$j${"halflife_days":21,"max_score":10,"min_topic_score":1.5,"min_creator_score":1.5,
                "neg_topic_score":-1.5,"creator_factor":1.0,"format_factor":0.5,"inst_factor":0.5,
                "topics_per_post":8}$j$::jsonb)
on conflict (key) do nothing;

create or replace function public.feed_cfg() returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from public.feed_config
$$;

-- 2. consumption classifier: raw client metrics -> outcome (server decides) ---------------
create or replace function public.feed_classify(
  p_is_video boolean, p_duration_ms int, p_dwell_ms int, p_watch_ms int, p_loops int, p_cfg jsonb
) returns text language plpgsql immutable as $$
declare
  c jsonb; d numeric; w numeric; frac numeric;
  dw numeric := coalesce(p_dwell_ms, 0);
  lp int := coalesce(p_loops, 0);
begin
  if not p_is_video then
    c := p_cfg->'consume'->'image';
    if dw < (c->>'skip_ms')::numeric then return 'skip'; end if;
    if dw < (c->>'view_ms')::numeric then return 'glance'; end if;
    if dw >= (c->>'complete_ms')::numeric then return 'complete'; end if;
    return 'view';
  end if;

  c := p_cfg->'consume'->'video';
  d := greatest(coalesce(nullif(p_duration_ms, 0), (c->>'default_ms')::int), 1000);
  w := coalesce(p_watch_ms, 0);
  frac := w / d;

  if lp >= 2 or frac >= (c->>'rewatch_frac')::numeric then return 'rewatch'; end if;

  if d <= (c->>'short_ms')::numeric then
    if lp >= 1 or frac >= (c->>'short_complete_frac')::numeric then return 'complete'; end if;
    if w >= (c->>'short_view_abs_ms')::numeric or frac >= (c->>'short_view_frac')::numeric then return 'view'; end if;
  elsif d >= (c->>'long_ms')::numeric then
    if frac >= (c->>'long_complete_frac')::numeric then return 'complete'; end if;
    if w >= (c->>'long_view_abs_ms')::numeric or frac >= (c->>'long_view_frac')::numeric then return 'view'; end if;
  else
    if frac >= (c->>'complete_frac')::numeric then return 'complete'; end if;
    if w >= (c->>'view_abs_ms')::numeric or frac >= (c->>'view_frac')::numeric then return 'view'; end if;
  end if;

  if w < (c->>'skip_ms')::numeric then return 'skip'; end if;
  return 'glance';
end $$;

create or replace function public.feed_outcome_code(p text) returns smallint language sql immutable as $$
  select (case p when 'skip' then 1 when 'glance' then 2 when 'view' then 3
                 when 'complete' then 4 when 'rewatch' then 5 else 0 end)::smallint
$$;

-- 3. affinity + people tables ---------------------------------------------------------------
create table if not exists public.user_topic_affinity (
  user_id    bigint not null references public.users(id) on delete cascade,
  topic      text   not null,          -- '#tag' | 'cat:<id>' | 'sub:<subtype>' | 'fmt:video|image|listing' | 'inst:<id>'
  score      real   not null default 0,
  events     int    not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, topic)
);
create index if not exists user_topic_affinity_rank_idx on public.user_topic_affinity (user_id, score desc);

create table if not exists public.user_creator_affinity (
  user_id    bigint not null references public.users(id) on delete cascade,
  creator_id bigint not null references public.users(id) on delete cascade,
  score      real   not null default 0,
  pos_events int    not null default 0,
  neg_events int    not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, creator_id),
  check (user_id <> creator_id)
);
create index if not exists user_creator_affinity_creator_idx on public.user_creator_affinity (creator_id);

create table if not exists public.user_creator_hides (
  user_id    bigint not null references public.users(id) on delete cascade,
  creator_id bigint not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, creator_id)
);

create table if not exists public.people_suggestions (
  user_id        bigint not null references public.users(id) on delete cascade,
  target_id      bigint not null references public.users(id) on delete cascade,
  shown_count    smallint not null default 0,
  first_shown_at timestamptz,
  last_shown_at  timestamptz,
  opened_at      timestamptz,
  dismissed_at   timestamptz,
  followed_at    timestamptz,
  reason         text,
  primary key (user_id, target_id),
  check (user_id <> target_id)
);
create index if not exists people_suggestions_recent_idx on public.people_suggestions (user_id, last_shown_at desc);

-- 4. core helpers --------------------------------------------------------------------------
create or replace function public.feed_decayed(p_score real, p_updated timestamptz, p_halflife_days numeric)
returns real language sql stable as $$
  select (p_score * power(0.5,
      greatest(extract(epoch from (now() - p_updated)), 0) / (86400 * greatest(p_halflife_days, 1))))::real
$$;

create or replace function public.feed_bump_creator(p_user bigint, p_creator bigint, p_delta numeric)
returns void language plpgsql security definer set search_path = public as $$
declare a jsonb := feed_cfg()->'affinity';
        hl numeric := (a->>'halflife_days')::numeric;
        mx numeric := (a->>'max_score')::numeric;
begin
  if p_delta is null or p_user = p_creator then return; end if;
  insert into user_creator_affinity as u (user_id, creator_id, score, pos_events, neg_events, updated_at)
  values (p_user, p_creator, greatest(-mx, least(mx, p_delta)),
          (p_delta > 0)::int, (p_delta < 0)::int, now())
  on conflict (user_id, creator_id) do update set
    score      = greatest(-mx, least(mx, feed_decayed(u.score, u.updated_at, hl) + p_delta)),
    pos_events = u.pos_events + (p_delta > 0)::int,
    neg_events = u.neg_events + (p_delta < 0)::int,
    updated_at = now();
end $$;

create or replace function public.feed_apply_signal(p_user bigint, p_post bigint, p_signal text)
returns void language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb := feed_cfg();
  a jsonb := cfg->'affinity';
  delta numeric := (cfg->'delta'->>p_signal)::numeric;
  hl numeric := (a->>'halflife_days')::numeric;
  mx numeric := (a->>'max_score')::numeric;
  p record; topics text[]; n int; per numeric; fmt text;
begin
  if delta is null then return; end if;

  select pp.user_id, pp.type, pp.subtype, pp.institution_id, pp.hashtags::jsonb as hashtags,
         (coalesce(pp.video_key, '') <> ''
          or exists (select 1 from post_media m where m.post_id = pp.id and m.media_type = 'video')) as is_video
    into p from posts pp where pp.id = p_post;
  if not found or p.type not in ('post','listing') or p.user_id = p_user then return; end if;

  select coalesce(array_agg(t), '{}') into topics from (
    select t from (
      select '#' || lower(ltrim(h, '#')) as t
        from jsonb_array_elements_text(
               case when jsonb_typeof(p.hashtags) = 'array' then p.hashtags else '[]'::jsonb end) h
       where length(ltrim(h, '#')) between 2 and 40
      union
      select 'cat:' || pc.category_id from post_categories pc where pc.post_id = p_post
      union
      select 'sub:' || p.subtype where p.subtype is not null
    ) x limit (a->>'topics_per_post')::int
  ) y;

  n := coalesce(array_length(topics, 1), 0);
  per := delta / sqrt(greatest(n, 1));
  fmt := case when p.is_video then 'video' when p.type = 'listing' then 'listing' else 'image' end;

  insert into user_topic_affinity as u (user_id, topic, score, events, updated_at)
  select p_user, x.topic, greatest(-mx, least(mx, x.d)), 1, now()
    from (
      select tp as topic, per as d from unnest(topics) tp
      union all select 'fmt:' || fmt, delta * (a->>'format_factor')::numeric
      union all select 'inst:' || p.institution_id, delta * (a->>'inst_factor')::numeric
                 where p.institution_id is not null
    ) x
  on conflict (user_id, topic) do update set
    score = greatest(-mx, least(mx, feed_decayed(u.score, u.updated_at, hl) + excluded.score)),
    events = u.events + 1,
    updated_at = now();

  perform feed_bump_creator(p_user, p.user_id, delta * (a->>'creator_factor')::numeric);
end $$;

-- exposure upsert with before/after state, so callers count each unique-user transition once
create or replace function public.feed_touch_exposure(
  p_user bigint, p_post bigint, p_src text, p_seen_inc int, p_bit int, p_best smallint, p_neg boolean,
  out old_acts int, out old_best smallint, out old_neg boolean,
  out new_acts int, out new_best smallint, out new_neg boolean
) language plpgsql security definer set search_path = public as $$
begin
  insert into feed_exposures (user_id, post_id, src, seen_count, acts, best_outcome, negative)
  values (p_user, p_post, p_src, 0, 0, 0, false)
  on conflict (user_id, post_id) do nothing;

  select e.acts, e.best_outcome, e.negative into old_acts, old_best, old_neg
    from feed_exposures e where e.user_id = p_user and e.post_id = p_post for update;

  update feed_exposures e set
    seen_count   = case when p_seen_inc > 0 then least(e.seen_count + p_seen_inc, 32000)
                        when (p_bit & 1) = 1 and e.seen_count = 0 then 1
                        else e.seen_count end,
    last_seen_at = now(),
    acts         = (e.acts | p_bit),
    best_outcome = greatest(e.best_outcome, p_best),
    negative     = e.negative or p_neg,
    src          = coalesce(e.src, p_src)
  where e.user_id = p_user and e.post_id = p_post
  returning e.acts, e.best_outcome, e.negative into new_acts, new_best, new_neg;
end $$;

create or replace function public.feed_stat_add(
  p_post bigint, d_imp int, d_view int, d_comp int, d_rew int, d_skip int, d_share int, d_follow int, d_neg int
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into feed_post_stats (post_id) values (p_post) on conflict do nothing;
  update feed_post_stats set
    impressions  = greatest(0, impressions + d_imp),
    views        = greatest(0, views + d_view),
    completions  = greatest(0, completions + d_comp),
    rewatches    = greatest(0, rewatches + d_rew),
    skips        = greatest(0, skips + d_skip),
    shares       = greatest(0, shares + d_share),
    follows_from = greatest(0, follows_from + d_follow),
    negatives    = greatest(0, negatives + d_neg),
    first_exposed_at = case when d_imp > 0 then coalesce(first_exposed_at, now()) else first_exposed_at end,
    updated_at   = now()
  where post_id = p_post;
end $$;

-- exact, self-healing recount for table-backed signals; the author never counts toward own post
create or replace function public.feed_recount_post(p_post bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_author bigint; v_type text;
begin
  select user_id, type into v_author, v_type from posts where id = p_post;
  if not found or v_type not in ('post','listing') then return; end if;
  insert into feed_post_stats (post_id) values (p_post) on conflict do nothing;
  update feed_post_stats set
    likes    = (select count(*) from post_likes where post_id = p_post and user_id <> v_author),
    comments = (select count(distinct user_id) from comments
                 where post_id = p_post and deleted_at is null and user_id <> v_author),
    saves    = (select count(*) from bookmarks where post_id = p_post and user_id <> v_author),
    reposts  = (select count(*) from reposts where post_id = p_post and user_id <> v_author),
    updated_at = now()
  where post_id = p_post;
end $$;

-- 5. triggers: real engagement -> stats + affinity -----------------------------------------
create or replace function public.trg_feed_engagement() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_user bigint; v_post bigint; v_sig text; v_bit int := 0; v_author bigint; v_type text;
begin
  begin
    if TG_OP = 'DELETE' then v_user := OLD.user_id; v_post := OLD.post_id;
    else v_user := NEW.user_id; v_post := NEW.post_id; end if;

    select pp.user_id, pp.type into v_author, v_type from posts pp where pp.id = v_post;
    if not found or v_type not in ('post','listing') then return null; end if;

    if TG_TABLE_NAME = 'post_likes' then
      v_sig := case TG_OP when 'INSERT' then 'like' else 'unlike' end;  v_bit := 4;
    elsif TG_TABLE_NAME = 'bookmarks' then
      v_sig := case TG_OP when 'INSERT' then 'save' else 'unsave' end;  v_bit := 16;
    elsif TG_TABLE_NAME = 'reposts' then
      v_sig := case TG_OP when 'INSERT' then 'repost' else 'unrepost' end; v_bit := 32;
    elsif TG_TABLE_NAME = 'comments' then
      if TG_OP = 'INSERT' then
        if NEW.deleted_at is not null then return null; end if;
        v_sig := 'comment'; v_bit := 8;
      elsif TG_OP = 'UPDATE' then
        if not (NEW.deleted_at is not null and OLD.deleted_at is null) then return null; end if;
      end if;
    end if;

    perform feed_recount_post(v_post);

    if v_sig is not null and v_user <> v_author then
      perform feed_apply_signal(v_user, v_post, v_sig);
      if TG_OP = 'INSERT' then
        perform feed_touch_exposure(v_user, v_post, null, 0, v_bit, 0::smallint, false);
      end if;
    end if;
  exception when others then
    perform activity_log_error('trg_feed_engagement', sqlerrm, jsonb_build_object('t', TG_TABLE_NAME, 'op', TG_OP));
  end;
  return null;
end $$;

create or replace function public.trg_feed_follow() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    if TG_OP = 'INSERT' then
      perform feed_bump_creator(NEW.follower_id, NEW.following_id, (feed_cfg()->'delta'->>'follow')::numeric);
      update people_suggestions set followed_at = coalesce(followed_at, now())
       where user_id = NEW.follower_id and target_id = NEW.following_id;
    elsif TG_OP = 'DELETE' then
      perform feed_bump_creator(OLD.follower_id, OLD.following_id, (feed_cfg()->'delta'->>'unfollow')::numeric);
    end if;
  exception when others then
    perform activity_log_error('trg_feed_follow', sqlerrm, jsonb_build_object('op', TG_OP));
  end;
  return null;
end $$;

drop trigger if exists feed_on_like on public.post_likes;
create trigger feed_on_like after insert or delete on public.post_likes
  for each row execute function public.trg_feed_engagement();
drop trigger if exists feed_on_bookmark on public.bookmarks;
create trigger feed_on_bookmark after insert or delete on public.bookmarks
  for each row execute function public.trg_feed_engagement();
drop trigger if exists feed_on_repost on public.reposts;
create trigger feed_on_repost after insert or delete on public.reposts
  for each row execute function public.trg_feed_engagement();
drop trigger if exists feed_on_comment on public.comments;
create trigger feed_on_comment after insert or update of deleted_at or delete on public.comments
  for each row execute function public.trg_feed_engagement();
drop trigger if exists feed_on_follow on public.follows;
create trigger feed_on_follow after insert or delete on public.follows
  for each row execute function public.trg_feed_follow();

-- 6. client event ingest ---------------------------------------------------------------------
create or replace function public.feed_ingest_events(p_user bigint, p_events jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb := feed_cfg();
  ing jsonb := cfg->'ingest';
  client_kinds text[] := array['impression','consume','share','profile_visit','listing_open',
    'not_interested','hide_creator','follow_from_post',
    'suggestion_impression','suggestion_open','suggestion_follow','suggestion_dismiss'];
  e jsonb;
  v_kind text; v_event uuid; v_post bigint; v_target bigint; v_session uuid; v_author bigint;
  v_src text; v_surface text; v_slot int;
  v_dwell int; v_watch int; v_media int; v_loops int;
  v_outcome text; v_inserted bigint; v_sig text;
  v_bit int; v_neg boolean; v_seen int; v_best smallint;
  pr record; x record;
  v_accepted int := 0; v_dups int := 0; v_rejected int := 0; v_recent int;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return jsonb_build_object('accepted',0,'duplicates',0,'rejected',0,'error','bad_payload');
  end if;
  if jsonb_array_length(p_events) > (ing->>'max_batch')::int then
    return jsonb_build_object('accepted',0,'duplicates',0,'rejected',0,'error','batch_too_large');
  end if;
  select count(*) into v_recent from feed_events
   where user_id = p_user and created_at > now() - interval '1 minute';
  if v_recent >= (ing->>'max_per_min')::int then
    return jsonb_build_object('accepted',0,'duplicates',0,'rejected',0,'error','rate_limited');
  end if;

  for e in select value from jsonb_array_elements(p_events) loop
    begin
      v_post := null; v_target := null; v_author := null; v_outcome := null; v_inserted := null;

      v_kind := e->>'kind';
      if v_kind is null or not (v_kind = any (client_kinds)) then
        v_rejected := v_rejected + 1; continue;
      end if;

      v_event   := (e->>'event_id')::uuid;
      v_session := nullif(e->>'session_id', '')::uuid;
      v_src     := left(e->>'src', 24);
      v_surface := left(e->>'surface', 24);
      v_slot    := least(greatest(coalesce((e->>'slot')::int, 0), 0), 500);
      v_dwell   := least(greatest(coalesce((e->>'dwell_ms')::numeric, 0), 0), 3600000)::int;
      v_watch   := least(greatest(coalesce((e->>'watch_ms')::numeric, 0), 0), 3600000)::int;
      v_media   := least(greatest(coalesce((e->>'media_ms')::numeric, 0), 0), 14400000)::int;
      v_loops   := least(greatest(coalesce((e->>'loops')::numeric, 0), 0), 100)::int;
      -- a client cannot claim to have watched longer than the post was on screen (+1s slack)
      v_watch   := least(v_watch, v_dwell + 1000);

      if left(v_kind, 11) = 'suggestion_' then
        v_target := (e->>'target_user_id')::bigint;
        if v_target is null or v_target = p_user
           or not exists (select 1 from users u where u.id = v_target and u.is_active and u.deleted_at is null)
           or exists (select 1 from user_blocks b
                       where (b.blocker_id = p_user and b.blocked_id = v_target)
                          or (b.blocker_id = v_target and b.blocked_id = p_user)) then
          v_rejected := v_rejected + 1; continue;
        end if;
        if v_kind = 'suggestion_follow' and not exists (
             select 1 from follows f where f.follower_id = p_user and f.following_id = v_target) then
          v_rejected := v_rejected + 1; continue;
        end if;
      else
        v_post := (e->>'post_id')::bigint;
        select fe.author_id into v_author from feed_eligible_posts fe
         where fe.id = v_post
           and feed_visible_to(p_user, fe.author_id, fe.visibility, fe.public_since, fe.institution_id);
        if not found then v_rejected := v_rejected + 1; continue; end if;
        if v_kind = 'follow_from_post' and not exists (
             select 1 from follows f where f.follower_id = p_user and f.following_id = v_author) then
          v_rejected := v_rejected + 1; continue;
        end if;

        if v_kind = 'consume' then
          select (coalesce(p.video_key, '') <> ''
                  or exists (select 1 from post_media m where m.post_id = p.id and m.media_type = 'video')) as is_video,
                 (greatest(coalesce((select max(m.duration_seconds) from post_media m
                                      where m.post_id = p.id and m.media_type = 'video'), 0),
                           p.duration_seconds) * 1000) as dur
            into pr from posts p where p.id = v_post;
          v_outcome := feed_classify(pr.is_video, case when pr.dur > 0 then pr.dur else v_media end,
                                     v_dwell, v_watch, v_loops, cfg);
        end if;
      end if;

      insert into feed_events (user_id, event_id, kind, origin, post_id, target_user_id, session_id,
                               surface, src, slot, dwell_ms, watch_ms, media_ms, loops, outcome)
      values (p_user, v_event, v_kind, 'client', v_post, v_target, v_session,
              v_surface, v_src, v_slot, v_dwell, v_watch, nullif(v_media, 0), v_loops, v_outcome)
      on conflict (user_id, event_id) do nothing
      returning id into v_inserted;

      if v_inserted is null then v_dups := v_dups + 1; continue; end if;

      if v_post is not null then
        if v_author is distinct from p_user then      -- own posts are logged but never counted
          v_bit := case v_kind when 'share' then 3 when 'profile_visit' then 129
                     when 'listing_open' then 257 when 'follow_from_post' then 65 else 1 end;
          v_best := case when v_kind = 'consume' then feed_outcome_code(v_outcome) else 0 end;
          v_neg  := v_kind in ('not_interested', 'hide_creator');
          v_seen := case when v_kind = 'impression' then 1 else 0 end;

          select * into x from feed_touch_exposure(p_user, v_post, v_src, v_seen, v_bit, v_best, v_neg);

          perform feed_stat_add(v_post,
            (x.new_acts & 1) - (x.old_acts & 1),
            (x.new_best >= 3)::int - (x.old_best >= 3)::int,
            (x.new_best >= 4)::int - (x.old_best >= 4)::int,
            (x.new_best >= 5)::int - (x.old_best >= 5)::int,
            (x.new_best = 1)::int  - (x.old_best = 1)::int,
            ((x.new_acts >> 1) & 1) - ((x.old_acts >> 1) & 1),
            ((x.new_acts >> 6) & 1) - ((x.old_acts >> 6) & 1),
            x.new_neg::int - x.old_neg::int);

          v_sig := null;
          if v_kind = 'consume' and x.new_best > x.old_best then
            v_sig := case v_outcome when 'view' then 'view' when 'complete' then 'complete'
                       when 'rewatch' then 'rewatch' when 'skip' then 'skip' else null end;
          elsif v_kind = 'share' and ((x.old_acts >> 1) & 1) = 0 then v_sig := 'share';
          elsif v_kind = 'listing_open' and (x.old_acts & 256) = 0 then v_sig := 'listing_open';
          elsif v_kind = 'not_interested' and not x.old_neg then v_sig := 'not_interested';
          end if;
          if v_sig is not null then perform feed_apply_signal(p_user, v_post, v_sig); end if;

          if v_kind = 'profile_visit' and (x.old_acts & 128) = 0 then
            perform feed_bump_creator(p_user, v_author, (cfg->'delta'->>'profile_visit')::numeric);
          end if;
          if v_kind = 'hide_creator' then
            insert into user_creator_hides (user_id, creator_id) values (p_user, v_author) on conflict do nothing;
            if not x.old_neg then
              perform feed_bump_creator(p_user, v_author, (cfg->'delta'->>'hide_creator')::numeric);
            end if;
          end if;
        end if;
      else
        insert into people_suggestions as ps (user_id, target_id, shown_count, first_shown_at, last_shown_at,
                                              opened_at, dismissed_at, followed_at)
        values (p_user, v_target,
                case when v_kind = 'suggestion_impression' then 1 else 0 end, now(), now(),
                case when v_kind = 'suggestion_open' then now() end,
                case when v_kind = 'suggestion_dismiss' then now() end,
                case when v_kind = 'suggestion_follow' then now() end)
        on conflict (user_id, target_id) do update set
          shown_count   = case when v_kind = 'suggestion_impression'
                               then least(ps.shown_count + 1, 32000) else ps.shown_count end,
          last_shown_at = case when v_kind = 'suggestion_impression' then now() else ps.last_shown_at end,
          opened_at     = case when v_kind = 'suggestion_open' then now() else ps.opened_at end,
          dismissed_at  = case when v_kind = 'suggestion_dismiss' then now() else ps.dismissed_at end,
          followed_at   = case when v_kind = 'suggestion_follow'
                               then coalesce(ps.followed_at, now()) else ps.followed_at end;
        if v_kind = 'suggestion_dismiss' then
          perform feed_bump_creator(p_user, v_target, (cfg->'delta'->>'suggestion_dismiss')::numeric);
        end if;
      end if;

      v_accepted := v_accepted + 1;
    exception when others then
      v_rejected := v_rejected + 1;
    end;
  end loop;

  return jsonb_build_object('accepted', v_accepted, 'duplicates', v_dups, 'rejected', v_rejected);
end $$;

-- 7. retention -------------------------------------------------------------------------------
create or replace function public.feed_purge() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from feed_events    where created_at   < now() - interval '14 days';
  delete from feed_sessions  where expires_at   < now() - interval '1 hour';
  delete from feed_exposures where last_seen_at < now() - interval '45 days';
  delete from user_topic_affinity   where updated_at < now() - interval '120 days';
  delete from user_creator_affinity where updated_at < now() - interval '120 days';
  delete from people_suggestions
   where coalesce(dismissed_at, last_shown_at, first_shown_at) < now() - interval '180 days'
     and followed_at is null;
end $$;

-- 8. lock down ------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['feed_config','user_topic_affinity','user_creator_affinity',
                           'user_creator_hides','people_suggestions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'feed\_%' or p.proname like 'trg\_feed\_%') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname not like 'trg\_feed\_%' then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;

-- 9. one-time seed: affinity from your existing real engagement ----------------------------------
do $$ begin
  if not exists (select 1 from user_topic_affinity) then
    perform feed_apply_signal(l.user_id, l.post_id, 'like')   from post_likes l;
    perform feed_apply_signal(b.user_id, b.post_id, 'save')   from bookmarks b;
    perform feed_apply_signal(r.user_id, r.post_id, 'repost') from reposts r;
    perform feed_apply_signal(c.user_id, c.post_id, 'comment')
      from (select distinct user_id, post_id from comments where deleted_at is null) c;
    perform feed_bump_creator(f.follower_id, f.following_id, (feed_cfg()->'delta'->>'follow')::numeric)
      from follows f;
  end if;
end $$;

commit;
