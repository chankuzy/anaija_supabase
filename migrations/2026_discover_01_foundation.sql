-- Anaija Discover Engine · migration 01 · foundation
-- Requires feed engine migrations 01-03. Additive: touches no Feed function.
begin;

-- 0. preflight: prod is the source of truth, fail loudly if the feed layer is not there
do $$ begin
  if to_regclass('public.feed_eligible_posts') is null
     or to_regclass('public.feed_post_topic') is null
     or to_regclass('public.feed_exposures') is null
     or to_regclass('public.feed_post_stats') is null
     or to_regprocedure('public.feed_visible_to(bigint,bigint,text,timestamptz,bigint)') is null
     or to_regprocedure('public.feed_apply_signal(bigint,bigint,text)') is null
     or to_regprocedure('public.feed_decayed(real,timestamptz,numeric)') is null
     or to_regprocedure('public.feed_cfg()') is null then
    raise exception 'Discover preflight failed: feed engine migrations 01-03 are not fully applied';
  end if;
end $$;

-- 1. storage: Discover exposure is separate from Feed exposure (grid tiles are weak impressions)
create table if not exists public.discover_exposures (
  user_id       bigint not null references public.users(id) on delete cascade,
  post_id       bigint not null references public.posts(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  seen_count    smallint not null default 0,
  opened_at     timestamptz,
  open_count    smallint not null default 0,
  src           text,
  primary key (user_id, post_id)
);
create index if not exists discover_exposures_user_recent_idx
  on public.discover_exposures (user_id, last_seen_at desc);
create index if not exists discover_exposures_post_idx
  on public.discover_exposures (post_id);

create table if not exists public.discover_post_stats (
  post_id     bigint primary key references public.posts(id) on delete cascade,
  impressions int not null default 0,   -- unique users who saw the tile (meaningful impression)
  opens       int not null default 0,   -- unique users who opened it
  delivered   int not null default 0,   -- pages that carried it (bounds exposure when events drop)
  updated_at  timestamptz not null default now()
);

-- 2. feed_events: one new kind, 'open' (drift-safe: patches whatever the prod constraint is)
do $$ declare c record; begin
  for c in select conname, pg_get_constraintdef(oid) as def from pg_constraint
            where conrelid = 'public.feed_events'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%suggestion_impression%'
              and pg_get_constraintdef(oid) not like '%''open''%'
  loop
    execute format('alter table public.feed_events drop constraint %I', c.conname);
    execute format('alter table public.feed_events add constraint %I %s', c.conname,
      replace(c.def, '''suggestion_impression''::text',
                     '''suggestion_impression''::text, ''open''::text'));
  end loop;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.feed_events'::regclass and contype = 'c'
                    and pg_get_constraintdef(oid) like '%''open''%') then
    raise exception 'feed_events kind constraint was not extended with open';
  end if;
end $$;

-- 3. indexes for the bounded "recent activity" lookups used by trending momentum
create index if not exists post_likes_post_created_idx on public.post_likes (post_id, created_at);
create index if not exists comments_post_created_idx on public.comments (post_id, created_at) where deleted_at is null;
create index if not exists bookmarks_post_created_idx on public.bookmarks (post_id, created_at);
create index if not exists listing_inquiries_post_buyer_idx on public.listing_inquiries (post_id, buyer_id);

-- 4. config (tune with UPDATE, no redeploy). SQL reads only 'candidates'; the TS engine reads the rest.
insert into public.feed_config (key, value) values ('discover', $j${
  "page_size":30,"session_items":90,"rebuild_when_remaining":10,"max_rebuilds":2,
  "weights":{"campus":0.25,"quality":0.25,"fresh":0.20,"novelty":0.15,"interest":0.10,"trending":0.05},
  "listing_weights":{"campus":0.28,"quality":0.22,"fresh":0.18,"novelty":0.10,"interest":0.10,"avail":0.12},
  "fresh_halflife_h":{"post":48,"listing":120},
  "interest":{"scale":2.5,"cap":0.6,"creator_scale":4.0},
  "campus":{"cross_floor":0.22,"cross_quality_gain":0.35,"inst_affinity_weight":0.6,"neutral":0.5},
  "novelty":{"expo_scale":25,"topic_w":0.35,"creator_w":0.25,"unseen_w":0.2,"emerging_w":0.2},
  "trending":{"scale":4,"min_age_h":6},
  "penalty":{"consumed":0.55,"engaged":0.8,"disc_seen":0.35,"disc_seen_decay_h":72,"neg":0.6},
  "ctr":{"prior_rate":0.25,"prior_strength":15,"blend":0.3},
  "listing":{"prior_rate":0.4,"prior_strength":10,"inquiry_unit":4,"save_unit":3,"open_unit":1,"like_unit":1,"squash":1.5},
  "candidates":{
    "campus_limit":50,"campus_days":30,"fresh_limit":40,"fresh_hours":72,
    "quality_limit":50,"quality_days":30,"emerging_limit":30,"emerging_days":14,"emerging_cap":15,
    "cross_limit":30,"cross_days":30,"explore_limit":30,"explore_days":45,
    "listing_limit":30,"listing_days":45,"scan_limit":1500
  },
  "compose":{
    "columns":3,"max_author_per_page":2,"min_author_gap":4,"topic_max_share":0.34,
    "dup_gap":12,"emerging_share":0.2,"emerging_min_slot":3,"fresh_floor_share":0.25,
    "first_screen":9,"first_screen_max_listings":1,
    "listing_first_slot":5,"listing_every":8,"listing_max_per_page":4,"listing_min_gap":5,"listing_min_score":0.2,
    "max_run_format":4
  }
}$j$::jsonb) on conflict (key) do nothing;

-- a Discover tap is a weak interest signal; the real verdict is the full-screen consume
update public.feed_config
   set value = jsonb_set(value, '{discover_open}', '0.2'::jsonb), updated_at = now()
 where key = 'delta' and not (value ? 'discover_open');

-- 5. candidate pool: ONE bounded rpc per build -------------------------------------------------
create or replace function public.discover_candidate_pool(
  p_viewer bigint, p_seed text, p_filter text default 'for_you', p_cfg jsonb default null)
returns table (
  post_id bigint, author_id bigint, kind text, subtype text, listing_type text,
  age_hours real, inst bigint, is_video boolean, duration_s int, topics text[], srcs text[],
  interest_strength real, author_followers int, is_following boolean, creator_score real,
  impressions int, views int, completions int, rewatches int, skips int, likes int, comments int,
  saves int, shares int, reposts int, follows_from int, negatives int, delivered int,
  disc_impressions int, disc_opens int, disc_delivered int,
  disc_seen int, disc_seen_hours real, feed_best smallint, feed_acts int,
  likes_24h int, comments_24h int, saves_24h int,
  caption_fp text, price_minor bigint, inquiries int, list_opens int
) language plpgsql stable as $$
#variable_conflict use_column
declare
  cfg jsonb := coalesce(p_cfg, public.feed_cfg());
  c jsonb := coalesce(cfg->'discover'->'candidates', '{}'::jsonb);
  a jsonb := coalesce(cfg->'affinity', '{}'::jsonb);
  hl numeric := coalesce((a->>'halflife_days')::numeric, 21);
  min_t numeric := coalesce((a->>'min_topic_score')::numeric, 1.5);
  v_inst bigint;
  v_lo boolean := (p_filter = 'marketplace');
  n_campus int := coalesce((c->>'campus_limit')::int, 50);
  d_campus int := coalesce((c->>'campus_days')::int, 30);
  n_fresh int := coalesce((c->>'fresh_limit')::int, 40);
  h_fresh int := coalesce((c->>'fresh_hours')::int, 72);
  n_quality int := coalesce((c->>'quality_limit')::int, 50);
  d_quality int := coalesce((c->>'quality_days')::int, 30);
  n_emerg int := coalesce((c->>'emerging_limit')::int, 30);
  d_emerg int := coalesce((c->>'emerging_days')::int, 14);
  cap_emerg int := coalesce((c->>'emerging_cap')::int, 15);
  n_cross int := coalesce((c->>'cross_limit')::int, 30);
  d_cross int := coalesce((c->>'cross_days')::int, 30);
  n_explore int := coalesce((c->>'explore_limit')::int, 30);
  d_explore int := coalesce((c->>'explore_days')::int, 45);
  n_listing int := coalesce((c->>'listing_limit')::int, 30);
  d_listing int := coalesce((c->>'listing_days')::int, 45);
  v_scan int := coalesce((c->>'scan_limit')::int, 1500);
  v_maxdays int;
begin
  v_maxdays := greatest(d_campus, d_quality, d_cross, d_explore, d_listing, d_emerg);
  if v_lo then n_listing := n_listing * 3; end if;
  select u.institution_id into v_inst from public.users u where u.id = p_viewer;

  return query
  with recent as materialized (
    -- cheap bound first: newest N eligible posts, before any per-row visibility work
    select e.id, e.author_id, e.type::text as kind, e.created_at, e.visibility, e.public_since,
           e.institution_id as post_inst, coalesce(e.institution_id, e.author_institution_id) as inst
      from public.feed_eligible_posts e
     where e.created_at > now() - make_interval(days => v_maxdays)
       and e.author_id <> p_viewer
       and (not v_lo or e.type = 'listing')
     order by e.created_at desc
     limit v_scan
  ), base as materialized (
    select r.id, r.author_id, r.kind, r.created_at, r.inst,
           coalesce(fs.impressions, 0) + coalesce(ds.impressions, 0) as expo,
           ((coalesce(fs.likes,0) + 2*coalesce(fs.comments,0) + 3*coalesce(fs.saves,0)
             + 2*coalesce(fs.shares,0) + coalesce(fs.reposts,0) + 0.3*coalesce(fs.views,0) + 1)::numeric
            / (coalesce(fs.impressions, 0) + 20)) as q
      from recent r
      left join public.feed_post_stats fs on fs.post_id = r.id
      left join public.discover_post_stats ds on ds.post_id = r.id
     where public.feed_visible_to(p_viewer, r.author_id, r.visibility, r.public_since, r.post_inst)
       and not exists (select 1 from public.user_creator_hides h
                        where h.user_id = p_viewer and h.creator_id = r.author_id)
       and not exists (select 1 from public.feed_exposures x
                        where x.user_id = p_viewer and x.post_id = r.id and x.negative)
       and (r.kind <> 'listing' or exists (
              select 1 from public.listing_details ld
               where ld.post_id = r.id and coalesce(ld.quantity, 1) > 0
                 and ld.accepting_orders is distinct from false))
  ), liked as (
    select a2.topic from public.user_topic_affinity a2
     where a2.user_id = p_viewer and (a2.topic like '#%' or a2.topic like 'cat:%')
       and public.feed_decayed(a2.score, a2.updated_at, hl) >= min_t
  ), src as (
    select 'campus'::text as s, x.id as pid from (
      select b.id from base b
       where v_inst is not null and b.inst = v_inst and (v_lo or b.kind = 'post')
         and b.created_at > now() - make_interval(days => d_campus)
       order by b.created_at desc limit n_campus) x
    union all
    select 'fresh', x.id from (
      select b.id from base b
       where (v_lo or b.kind = 'post') and b.created_at > now() - make_interval(hours => h_fresh)
       order by b.expo asc, b.created_at desc limit n_fresh) x
    union all
    select 'quality', x.id from (
      select b.id from base b
       where (v_lo or b.kind = 'post') and b.created_at > now() - make_interval(days => d_quality)
       order by b.q desc, b.created_at desc limit n_quality) x
    union all
    select 'emerging', x.id from (
      select b.id from base b
       where (v_lo or b.kind = 'post') and b.expo < cap_emerg
         and b.created_at > now() - make_interval(days => d_emerg)
       order by md5(b.id::text || p_seed) limit n_emerg) x
    union all
    select 'cross', x.id from (
      select b.id from base b
       where (v_lo or b.kind = 'post') and (v_inst is null or b.inst is distinct from v_inst)
         and b.created_at > now() - make_interval(days => d_cross)
       order by b.q desc, b.created_at desc limit n_cross) x
    union all
    select 'outside', x.id from (
      select b.id from base b
       where (v_lo or b.kind = 'post') and b.created_at > now() - make_interval(days => d_explore)
         and not exists (select 1 from public.feed_post_topic t join liked l on l.topic = t.topic
                          where t.post_id = b.id)
       order by md5(b.id::text || p_seed) limit n_explore) x
    union all
    select 'listing', x.id from (
      select b.id from base b
       where b.kind = 'listing' and b.created_at > now() - make_interval(days => d_listing)
       order by (case when v_inst is not null and b.inst = v_inst then 0 else 1 end), b.created_at desc
       limit n_listing) x
  ), agg as (
    select s.pid, array_agg(distinct s.s order by s.s) as srcs from src s group by s.pid
  )
  select e.id, e.author_id, e.type::text, p.subtype::text, p.listing_type::text,
         (extract(epoch from (now() - e.created_at::timestamptz)) / 3600.0)::real,
         coalesce(e.institution_id, e.author_institution_id),
         (coalesce(p.video_key, '') <> ''
            or exists (select 1 from public.post_media m where m.post_id = e.id and m.media_type = 'video')),
         greatest(coalesce((select max(m.duration_seconds) from public.post_media m
                             where m.post_id = e.id and m.media_type = 'video'), 0), p.duration_seconds)::int,
         (select coalesce(array_agg(distinct t.topic), '{}'::text[])
            from public.feed_post_topic t where t.post_id = e.id),
         g.srcs,
         0::real,
         (select count(*) from public.follows f where f.following_id = e.author_id)::int,
         exists (select 1 from public.follows f where f.follower_id = p_viewer and f.following_id = e.author_id),
         coalesce((select public.feed_decayed(ca.score, ca.updated_at, hl)
                     from public.user_creator_affinity ca
                    where ca.user_id = p_viewer and ca.creator_id = e.author_id), 0)::real,
         coalesce(st.impressions, 0), coalesce(st.views, 0), coalesce(st.completions, 0),
         coalesce(st.rewatches, 0), coalesce(st.skips, 0), coalesce(st.likes, 0), coalesce(st.comments, 0),
         coalesce(st.saves, 0), coalesce(st.shares, 0), coalesce(st.reposts, 0),
         coalesce(st.follows_from, 0), coalesce(st.negatives, 0), coalesce(st.delivered, 0),
         coalesce(ds.impressions, 0), coalesce(ds.opens, 0), coalesce(ds.delivered, 0),
         coalesce(de.seen_count, 0)::int,
         (extract(epoch from (now() - de.last_seen_at)) / 3600.0)::real,
         coalesce(fx.best_outcome, 0)::smallint,
         coalesce(fx.acts, 0)::int,
         (select count(*) from public.post_likes pl
           where pl.post_id = e.id and pl.user_id <> e.author_id
             and pl.created_at > now() - interval '24 hours')::int,
         (select count(distinct cm.user_id) from public.comments cm
           where cm.post_id = e.id and cm.deleted_at is null and cm.user_id <> e.author_id
             and cm.created_at > now() - interval '24 hours')::int,
         (select count(*) from public.bookmarks bk
           where bk.post_id = e.id and bk.user_id <> e.author_id
             and bk.created_at > now() - interval '24 hours')::int,
         (select case when length(n.t) >= 8 then md5(n.t) end
            from (select regexp_replace(lower(coalesce(p.caption, '')), '[^a-z0-9]+', '', 'g') as t) n),
         ld.price_minor,
         (case when e.type = 'listing' then
            (select count(distinct li.buyer_id) from public.listing_inquiries li
              where li.post_id = e.id and li.buyer_id <> e.author_id) else 0 end)::int,
         (case when e.type = 'listing' then
            (select count(*) from public.feed_exposures fo
              where fo.post_id = e.id and fo.user_id <> e.author_id and (fo.acts::int & 256) <> 0) else 0 end)::int
    from agg g
    join public.feed_eligible_posts e on e.id = g.pid
    join public.posts p on p.id = e.id
    left join public.listing_details ld on ld.post_id = e.id
    left join public.feed_post_stats st on st.post_id = e.id
    left join public.discover_post_stats ds on ds.post_id = e.id
    left join public.feed_exposures fx on fx.user_id = p_viewer and fx.post_id = e.id
    left join public.discover_exposures de on de.user_id = p_viewer and de.post_id = e.id;
end $$;

-- 6. event ingest: meaningful tile impressions + opens. Own idempotency via feed_events (user,event_id).
create or replace function public.discover_ingest_events(p_user bigint, p_events jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  e jsonb;
  v_kind text; v_event uuid; v_post bigint; v_session uuid; v_src text; v_slot int;
  v_author bigint; v_type text; v_inserted bigint;
  o_seen smallint; o_open smallint; d_imp int; d_open int;
  v_accepted int := 0; v_dups int := 0; v_rejected int := 0; v_recent int;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return jsonb_build_object('accepted',0,'duplicates',0,'rejected',0,'error','bad_payload');
  end if;
  if jsonb_array_length(p_events) > 60 then
    return jsonb_build_object('accepted',0,'duplicates',0,'rejected',0,'error','batch_too_large');
  end if;
  select count(*) into v_recent from feed_events
   where user_id = p_user and surface = 'discover' and created_at > now() - interval '1 minute';
  if v_recent >= 300 then
    return jsonb_build_object('accepted',0,'duplicates',0,'rejected',0,'error','rate_limited');
  end if;

  for e in select value from jsonb_array_elements(p_events) loop
    begin
      v_kind := e->>'kind';
      if v_kind is null or v_kind not in ('impression', 'open') then
        v_rejected := v_rejected + 1; continue;
      end if;
      v_event   := (e->>'event_id')::uuid;
      v_post    := (e->>'post_id')::bigint;
      v_session := nullif(e->>'session_id', '')::uuid;
      v_src     := left(e->>'src', 24);
      v_slot    := least(greatest(coalesce((e->>'slot')::numeric, 0), 0), 500)::int;

      select fe.author_id, fe.type::text into v_author, v_type
        from feed_eligible_posts fe
       where fe.id = v_post
         and feed_visible_to(p_user, fe.author_id, fe.visibility, fe.public_since, fe.institution_id);
      if not found or v_author = p_user then v_rejected := v_rejected + 1; continue; end if;

      insert into feed_events (user_id, event_id, kind, origin, post_id, session_id, surface, src, slot)
      values (p_user, v_event, v_kind, 'client', v_post, v_session, 'discover', v_src, v_slot)
      on conflict (user_id, event_id) do nothing
      returning id into v_inserted;
      if v_inserted is null then v_dups := v_dups + 1; continue; end if;

      insert into discover_exposures (user_id, post_id, src) values (p_user, v_post, v_src)
      on conflict (user_id, post_id) do nothing;
      select x.seen_count, x.open_count into o_seen, o_open
        from discover_exposures x where x.user_id = p_user and x.post_id = v_post for update;

      update discover_exposures x set
        seen_count   = case when v_kind = 'impression'
                            then least(x.seen_count + 1, 32000)::smallint
                            else greatest(x.seen_count, 1)::smallint end,  -- an open implies it was seen
        last_seen_at = now(),
        opened_at    = case when v_kind = 'open' then coalesce(x.opened_at, now()) else x.opened_at end,
        open_count   = case when v_kind = 'open' then least(x.open_count + 1, 32000)::smallint else x.open_count end,
        src          = coalesce(x.src, v_src)
      where x.user_id = p_user and x.post_id = v_post;

      d_imp  := (o_seen = 0)::int;                             -- unique-user transitions only
      d_open := (v_kind = 'open' and o_open = 0)::int;
      if d_imp > 0 or d_open > 0 then
        insert into discover_post_stats as s (post_id, impressions, opens)
        values (v_post, d_imp, d_open)
        on conflict (post_id) do update set
          impressions = s.impressions + d_imp, opens = s.opens + d_open, updated_at = now();
      end if;

      -- first open of a regular post: mild interest signal. Listings are covered by listing_open.
      if d_open > 0 and v_type = 'post' then
        perform feed_apply_signal(p_user, v_post, 'discover_open');
      end if;

      v_accepted := v_accepted + 1;
    exception when others then
      v_rejected := v_rejected + 1;
    end;
  end loop;

  return jsonb_build_object('accepted', v_accepted, 'duplicates', v_dups, 'rejected', v_rejected);
end $$;

-- 7. delivery counter + retention
create or replace function public.discover_mark_delivered(p_ids bigint[]) returns void
language sql as $$
  insert into public.discover_post_stats as s (post_id, delivered)
  select distinct x, 1 from unnest(p_ids) x
   where exists (select 1 from public.posts p where p.id = x)
  on conflict (post_id) do update set delivered = s.delivered + 1, updated_at = now()
$$;

create or replace function public.discover_purge() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from discover_exposures where last_seen_at < now() - interval '45 days';
end $$;
select cron.schedule('discover-purge', '37 3 * * *', $c$ select public.discover_purge(); $c$);

-- 8. lock down: service role only
do $$ declare t text; begin
  foreach t in array array['discover_exposures','discover_post_stats'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like 'discover\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

commit;
