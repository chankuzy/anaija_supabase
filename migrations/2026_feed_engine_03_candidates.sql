-- Anaija Feed Engine · migration 03 · candidate generation + ranking config
-- Requires 01 + 02. Additive (views/functions/config only).
begin;

-- 1. post -> topic view (same normalization as feed_apply_signal) ---------------------------
-- NOTE: computed on the fly over the candidate window. When 30-day eligible posts exceed ~20k,
-- replace with a maintained post_topics table (see docs/feed-engine/PROGRESS.md).
create or replace view public.feed_post_topic as
select p.id as post_id, '#' || lower(ltrim(h.t, '#')) as topic
  from public.posts p
  cross join lateral jsonb_array_elements_text(
       case when jsonb_typeof(p.hashtags::jsonb) = 'array' then p.hashtags::jsonb else '[]'::jsonb end) as h(t)
 where length(ltrim(h.t, '#')) between 2 and 40
union all
select pc.post_id, 'cat:' || pc.category_id from public.post_categories pc
union all
select p.id, 'sub:' || p.subtype from public.posts p where p.subtype is not null;

-- 2. config ------------------------------------------------------------------------------------
insert into public.feed_config (key, value) values
('candidates', $j${
  "followed_limit":40,"followed_days":21,
  "institution_limit":40,"institution_days":21,
  "interest_limit":40,"interest_days":45,
  "creator_limit":30,"creator_days":30,
  "fresh_limit":30,"fresh_hours":96,
  "wide_limit":30,"wide_days":30,
  "listing_limit":12,"listing_days":30,
  "explore_limit":12,"explore_days":45,
  "seen_days":14,"consumed_days":60,
  "relax":{"seen_days":2}
}$j$::jsonb),
('rank', $j${
  "auth":   {"follow":0.22,"interest":0.20,"creator":0.12,"campus":0.10,"format":0.04,"quality":0.16,"fresh":0.14,"discovery":0.10,"small":0.04,"neg":0.30,"sat":0.06},
  "guest":  {"follow":0,"interest":0,"creator":0,"campus":0,"format":0,"quality":0.42,"fresh":0.28,"discovery":0.20,"small":0.06,"neg":0.30,"sat":0.08},
  "listing":{"follow":0.12,"interest":0.22,"creator":0.06,"campus":0.28,"format":0,"quality":0.08,"fresh":0.20,"discovery":0.06,"small":0.02,"neg":0.30,"sat":0.06},
  "fresh_halflife_h":{"post":36,"listing":96},
  "interest_scale":2.5,"creator_scale":4.0,
  "topic_prefix_weight":{"#":1.0,"cat:":1.0,"sub:":0.4},
  "small_followers_scale":30,
  "format_baseline":0.3333,"format_gain":1.5,
  "inst_affinity_weight":0.6,
  "discovery_relevance_floor":0.35
}$j$::jsonb),
('quality', $j${
  "unit":{"view":1,"complete":1,"rewatch":1,"like":2,"comment":3,"save":3,"share":3,"follow":4},
  "neg_unit":{"skip":0.6,"negative":4},
  "prior_rate":0.8,"prior_strength":8,"squash":1.5
}$j$::jsonb),
('dist', $j${
  "seed_cap":10,"expand_cap":60,"saturation_cap":300,
  "promote_q":0.38,"demote_q":0.18,
  "boost_seed":0.9,"boost_promote":0.6,"penalty_demote":-0.8
}$j$::jsonb),
('compose', $j${
  "page_size":15,"session_items":60,
  "first_n_familiar":3,
  "max_author_per_page":2,"min_author_gap":4,"max_run_format":3,
  "explore_share":0.15,"explore_min_slot":4,
  "wide_share":0.20,
  "listing_max_per_page":1,"listing_min_gap":10,"listing_min_score":0.18,"listing_min_slot":4,
  "min_pool_relax":30,"caught_up_min_items":5,
  "rebuild_when_remaining":6,"max_rebuilds":3,
  "suggest":{"first_after":[12,18],"next_after":[20,30],"max_per_session":2,
             "group_size":3,"min_group":2,"min_score":0.35}
}$j$::jsonb)
on conflict (key) do nothing;

-- 3. seen / repetition filter --------------------------------------------------------------------
create or replace function public.feed_not_seen(
  p_viewer bigint, p_post bigint, p_seen_days int, p_consumed_days int
) returns boolean language sql stable as $$
  select p_viewer is null or not exists (
    select 1 from public.feed_exposures x
     where x.user_id = p_viewer and x.post_id = p_post
       and ( x.negative
          or (x.acts >> 1) <> 0
          or (x.best_outcome >= 3 and x.last_seen_at > now() - make_interval(days => p_consumed_days))
          or (x.seen_count > 0 and x.last_seen_at > now() - make_interval(days => p_seen_days)) ))
$$;

-- 4. shared base: eligible + visible + unseen + not hidden, inside a time window -----------------
create or replace function public.feed_pool_base(p_viewer bigint, p_days int, p_seen int, p_cons int)
returns table (post_id bigint, author_id bigint, kind text, created_at timestamp, inst bigint)
language sql stable as $$
  select e.id, e.author_id, e.type::text, e.created_at,
         coalesce(e.institution_id, e.author_institution_id)
    from public.feed_eligible_posts e
   where e.created_at > now() - make_interval(days => p_days)
     and (p_viewer is null or e.author_id <> p_viewer)
     and public.feed_visible_to(p_viewer, e.author_id, e.visibility, e.public_since, e.institution_id)
     and public.feed_not_seen(p_viewer, e.id, p_seen, p_cons)
     and (p_viewer is null or not exists (
            select 1 from public.user_creator_hides h
             where h.user_id = p_viewer and h.creator_id = e.author_id))
$$;

-- 5. candidate sources (each bounded, each tagged) --------------------------------------------------
create or replace function public.feed_src_followed(p_viewer bigint, p_limit int, p_days int, p_seen int, p_cons int)
returns table (post_id bigint, strength real) language sql stable as $$
  select b.post_id, 1::real
    from public.feed_pool_base(p_viewer, p_days, p_seen, p_cons) b
    join public.follows f on f.follower_id = p_viewer and f.following_id = b.author_id
   where p_viewer is not null
   order by b.created_at desc limit p_limit
$$;

create or replace function public.feed_src_institution(p_viewer bigint, p_limit int, p_days int, p_seen int, p_cons int)
returns table (post_id bigint, strength real) language sql stable as $$
  select b.post_id, 1::real
    from public.feed_pool_base(p_viewer, p_days, p_seen, p_cons) b
    join public.users u on u.id = p_viewer
   where p_viewer is not null and u.institution_id is not null and b.inst = u.institution_id
   order by b.created_at desc limit p_limit
$$;

create or replace function public.feed_src_interest(
  p_viewer bigint, p_limit int, p_days int, p_seen int, p_cons int, p_min numeric, p_halflife numeric)
returns table (post_id bigint, strength real) language sql stable as $$
  with mine as (
    select a.topic, public.feed_decayed(a.score, a.updated_at, p_halflife) as s
      from public.user_topic_affinity a
     where a.user_id = p_viewer
       and (a.topic like '#%' or a.topic like 'cat:%' or a.topic like 'sub:%')
  ), liked as (
    select topic, s * (case when topic like 'sub:%' then 0.5 else 1.0 end) as w
      from mine where s >= p_min
  )
  select b.post_id, sum(l.w)::real
    from liked l
    join public.feed_post_topic pt on pt.topic = l.topic
    join public.feed_pool_base(p_viewer, p_days, p_seen, p_cons) b on b.post_id = pt.post_id
   where p_viewer is not null
   group by b.post_id, b.created_at
   order by sum(l.w) desc, b.created_at desc
   limit p_limit
$$;

create or replace function public.feed_src_creator(
  p_viewer bigint, p_limit int, p_days int, p_seen int, p_cons int, p_min numeric, p_halflife numeric)
returns table (post_id bigint, strength real) language sql stable as $$
  with fav as (
    select a.creator_id, public.feed_decayed(a.score, a.updated_at, p_halflife) as s
      from public.user_creator_affinity a where a.user_id = p_viewer
  )
  select b.post_id, f.s::real
    from public.feed_pool_base(p_viewer, p_days, p_seen, p_cons) b
    join fav f on f.creator_id = b.author_id
   where p_viewer is not null and f.s >= p_min
   order by f.s desc, b.created_at desc limit p_limit
$$;

-- fresh/emerging: least-exposed new posts first, regardless of author size
create or replace function public.feed_src_fresh(p_viewer bigint, p_limit int, p_hours int, p_seen int, p_cons int)
returns table (post_id bigint, strength real) language sql stable as $$
  select b.post_id, (1.0 / (1 + coalesce(s.impressions, 0)))::real
    from public.feed_pool_base(p_viewer, greatest(1, ceil(p_hours / 24.0)::int), p_seen, p_cons) b
    left join public.feed_post_stats s on s.post_id = b.post_id
   where b.created_at > now() - make_interval(hours => p_hours)
   order by coalesce(s.impressions, 0) asc, b.created_at desc
   limit p_limit
$$;

-- wide: other campuses (or everything, for guests / viewers without an institution)
create or replace function public.feed_src_wide(p_viewer bigint, p_limit int, p_days int, p_seen int, p_cons int)
returns table (post_id bigint, strength real) language sql stable as $$
  select b.post_id,
         ((coalesce(s.likes,0) + 2*coalesce(s.comments,0) + 3*coalesce(s.saves,0)
           + 2*coalesce(s.shares,0) + 1)::numeric / (coalesce(s.impressions,0) + 20))::real
    from public.feed_pool_base(p_viewer, p_days, p_seen, p_cons) b
    left join public.feed_post_stats s on s.post_id = b.post_id
   where b.kind = 'post'
     and ( p_viewer is null
        or (select u.institution_id from public.users u where u.id = p_viewer) is null
        or b.inst is distinct from (select u.institution_id from public.users u where u.id = p_viewer) )
   order by 2 desc, b.created_at desc limit p_limit
$$;

create or replace function public.feed_src_listings(p_viewer bigint, p_limit int, p_days int, p_seen int, p_cons int)
returns table (post_id bigint, strength real) language sql stable as $$
  select b.post_id,
         (case when p_viewer is not null and b.inst is not null
                and b.inst = (select u.institution_id from public.users u where u.id = p_viewer)
               then 1 else 0 end)::real
    from public.feed_pool_base(p_viewer, p_days, p_seen, p_cons) b
   where b.kind = 'listing'
   order by 2 desc, b.created_at desc limit p_limit
$$;

-- exploration: seeded shuffle (stable per session), outside the viewer's follow circle
create or replace function public.feed_src_explore(
  p_viewer bigint, p_limit int, p_days int, p_seen int, p_cons int, p_seed text)
returns table (post_id bigint, strength real) language sql stable as $$
  select b.post_id, 1::real
    from public.feed_pool_base(p_viewer, p_days, p_seen, p_cons) b
   where b.kind = 'post'
     and (p_viewer is null or not exists (
            select 1 from public.follows f where f.follower_id = p_viewer and f.following_id = b.author_id))
   order by md5(b.post_id::text || p_seed) limit p_limit
$$;

-- 6. the combiner: ONE rpc per feed build ------------------------------------------------------------
create or replace function public.feed_candidate_pool(p_viewer bigint, p_seed text, p_cfg jsonb default null)
returns table (
  post_id bigint, author_id bigint, kind text, subtype text, listing_type text,
  age_hours real, inst bigint, is_video boolean, duration_s int, topics text[], srcs text[],
  interest_strength real, author_followers int, is_following boolean, creator_score real,
  impressions int, views int, completions int, rewatches int, skips int, likes int, comments int,
  saves int, shares int, reposts int, follows_from int, negatives int, delivered int
) language plpgsql stable as $$
#variable_conflict use_column
declare
  cfg jsonb := coalesce(p_cfg, public.feed_cfg());
  c jsonb := cfg->'candidates';
  a jsonb := cfg->'affinity';
  seen int := (c->>'seen_days')::int;
  cons int := (c->>'consumed_days')::int;
  hl numeric := (a->>'halflife_days')::numeric;
begin
  return query
  with src as (
    select 'followed'::text as s, x.post_id as pid, x.strength as st
      from public.feed_src_followed(p_viewer, (c->>'followed_limit')::int, (c->>'followed_days')::int, seen, cons) x
    union all
    select 'institution', x.post_id, x.strength
      from public.feed_src_institution(p_viewer, (c->>'institution_limit')::int, (c->>'institution_days')::int, seen, cons) x
    union all
    select 'interest', x.post_id, x.strength
      from public.feed_src_interest(p_viewer, (c->>'interest_limit')::int, (c->>'interest_days')::int, seen, cons,
                                    (a->>'min_topic_score')::numeric, hl) x
    union all
    select 'creator', x.post_id, x.strength
      from public.feed_src_creator(p_viewer, (c->>'creator_limit')::int, (c->>'creator_days')::int, seen, cons,
                                   (a->>'min_creator_score')::numeric, hl) x
    union all
    select 'fresh', x.post_id, x.strength
      from public.feed_src_fresh(p_viewer, (c->>'fresh_limit')::int, (c->>'fresh_hours')::int, seen, cons) x
    union all
    select 'wide', x.post_id, x.strength
      from public.feed_src_wide(p_viewer, (c->>'wide_limit')::int, (c->>'wide_days')::int, seen, cons) x
    union all
    select 'listing', x.post_id, x.strength
      from public.feed_src_listings(p_viewer, (c->>'listing_limit')::int, (c->>'listing_days')::int, seen, cons) x
    union all
    select 'explore', x.post_id, x.strength
      from public.feed_src_explore(p_viewer, (c->>'explore_limit')::int, (c->>'explore_days')::int, seen, cons, p_seed) x
  ), agg as (
    select s.pid,
           array_agg(distinct s.s order by s.s) as srcs,
           coalesce(max(s.st) filter (where s.s = 'interest'), 0)::real as istr
      from src s group by s.pid
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
         g.srcs, g.istr,
         (select count(*) from public.follows f where f.following_id = e.author_id)::int,
         (p_viewer is not null and exists (
            select 1 from public.follows f where f.follower_id = p_viewer and f.following_id = e.author_id)),
         coalesce((select public.feed_decayed(ca.score, ca.updated_at, hl)
                     from public.user_creator_affinity ca
                    where ca.user_id = p_viewer and ca.creator_id = e.author_id), 0)::real,
         coalesce(st.impressions, 0), coalesce(st.views, 0), coalesce(st.completions, 0),
         coalesce(st.rewatches, 0), coalesce(st.skips, 0), coalesce(st.likes, 0), coalesce(st.comments, 0),
         coalesce(st.saves, 0), coalesce(st.shares, 0), coalesce(st.reposts, 0),
         coalesce(st.follows_from, 0), coalesce(st.negatives, 0), coalesce(st.delivered, 0)
    from agg g
    join public.feed_eligible_posts e on e.id = g.pid
    join public.posts p on p.id = e.id
    left join public.feed_post_stats st on st.post_id = e.id;
end $$;

-- 7. viewer profile for the scorer (decayed at read time) ------------------------------------------------
create or replace function public.feed_user_profile(p_viewer bigint) returns jsonb
language sql stable as $$
  with hl as (select (public.feed_cfg()->'affinity'->>'halflife_days')::numeric as v),
  t as (
    select a.topic, public.feed_decayed(a.score, a.updated_at, hl.v) as s
      from public.user_topic_affinity a, hl where a.user_id = p_viewer),
  tt as (select topic, s from t where abs(s) >= 0.3 order by abs(s) desc limit 150),
  c as (
    select a.creator_id, public.feed_decayed(a.score, a.updated_at, hl.v) as s
      from public.user_creator_affinity a, hl where a.user_id = p_viewer),
  cc as (select creator_id, s from c where abs(s) >= 0.3 order by abs(s) desc limit 100)
  select jsonb_build_object(
    'user_id', p_viewer,
    'institution_id', (select u.institution_id from public.users u where u.id = p_viewer),
    'following', (select count(*) from public.follows f where f.follower_id = p_viewer),
    'consumed_total', (select count(*) from public.feed_exposures x
                        where x.user_id = p_viewer and x.best_outcome >= 3),
    'topics', coalesce((select jsonb_agg(jsonb_build_object('t', topic, 's', round(s::numeric, 3))
                                         order by abs(s) desc) from tt), '[]'::jsonb),
    'creators', coalesce((select jsonb_agg(jsonb_build_object('id', creator_id, 's', round(s::numeric, 3))
                                           order by abs(s) desc) from cc), '[]'::jsonb),
    'hides', coalesce((select jsonb_agg(h.creator_id) from public.user_creator_hides h
                        where h.user_id = p_viewer), '[]'::jsonb))
$$;

-- 8. delivery counter (authenticated deliveries only; guests never burn a post's budget) -----------------
create or replace function public.feed_mark_delivered(p_ids bigint[]) returns void
language sql as $$
  insert into public.feed_post_stats as s (post_id, delivered)
  select distinct x, 1 from unnest(p_ids) x
   where exists (select 1 from public.posts p where p.id = x)
  on conflict (post_id) do update set delivered = s.delivered + 1, updated_at = now()
$$;

-- 9. lock down -----------------------------------------------------------------------------------------------
revoke all on public.feed_post_topic from anon, authenticated;
grant select on public.feed_post_topic to service_role;

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

commit;
