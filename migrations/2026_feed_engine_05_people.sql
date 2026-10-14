-- Phase 6: people recommendation candidates. Returns EVIDENCE only; scoring lives in _shared/feed/people.ts.
begin;

insert into public.feed_config (key, value) values
('people', $j${"limit":40,"window_days":30,"dismiss_days":60,"cooldown_days":3,"fatigue_shown":4,"fatigue_days":14,
  "small_followers":25,"min_score":0.15,"jitter":0.02,
  "weights":{"mutual":0.30,"interest":0.24,"campus":0.14,"emerging":0.10,"quality":0.10,"activity":0.06,"wide":0.06}}$j$::jsonb)
on conflict (key) do nothing;

create index if not exists follows_following_follower_idx on public.follows (following_id, follower_id);
create index if not exists follows_follower_following_idx on public.follows (follower_id, following_id);

create or replace function public.feed_people_candidates(p_viewer bigint)
returns table (
  uid bigint, reasons text[], mutuals int, shared_topics int, creator_aff real,
  followers int, age_days real, posts_30d int, positives int
) language plpgsql stable as $$
#variable_conflict use_column
declare
  cfg jsonb := public.feed_cfg();
  pc jsonb := coalesce(cfg->'people', '{}'::jsonb);
  a jsonb := cfg->'affinity';
  win int := coalesce((pc->>'window_days')::int, 30);
  dismiss_d int := coalesce((pc->>'dismiss_days')::int, 60);
  cool_d int := coalesce((pc->>'cooldown_days')::int, 3);
  fat_n int := coalesce((pc->>'fatigue_shown')::int, 4);
  fat_d int := coalesce((pc->>'fatigue_days')::int, 14);
  small int := coalesce((pc->>'small_followers')::int, 25);
  lim int := coalesce((pc->>'limit')::int, 40);
  hl numeric := (a->>'halflife_days')::numeric;
  min_c numeric := (a->>'min_creator_score')::numeric;
  min_t numeric := (a->>'min_topic_score')::numeric;
  my_inst bigint;
begin
  select u.institution_id into my_inst from public.users u where u.id = p_viewer;

  return query
  with act as (  -- authors with at least one eligible post this viewer may see
    select e.author_id as uid, count(*)::int as n,
           coalesce(sum(st.completions + st.likes + st.saves + st.follows_from), 0)::int as pos
      from public.feed_eligible_posts e
      left join public.feed_post_stats st on st.post_id = e.id
     where e.created_at > now() - make_interval(days => win)
       and e.author_id <> p_viewer
       and public.feed_visible_to(p_viewer, e.author_id, e.visibility, e.public_since, e.institution_id)
     group by e.author_id
  ), base as (
    select u.id as uid, coalesce(u.institution_id, 0) as inst, u.created_at, a2.n, a2.pos
      from act a2 join public.users u on u.id = a2.uid
     where u.is_active and u.deleted_at is null and u.profile_completed
       and not exists (select 1 from public.follows f where f.follower_id = p_viewer and f.following_id = u.id)
       and not exists (select 1 from public.user_blocks b
                        where (b.blocker_id = p_viewer and b.blocked_id = u.id)
                           or (b.blocker_id = u.id and b.blocked_id = p_viewer))
       and not exists (select 1 from public.user_creator_hides h where h.user_id = p_viewer and h.creator_id = u.id)
       and not exists (select 1 from public.people_suggestions ps
                        where ps.user_id = p_viewer and ps.target_id = u.id
                          and ( ps.dismissed_at > now() - make_interval(days => dismiss_d)
                             or ps.last_shown_at > now() - make_interval(days => cool_d)
                             or (ps.shown_count >= fat_n and ps.opened_at is null
                                 and ps.last_shown_at > now() - make_interval(days => fat_d)) ))
  ), mut as (  -- people I follow who follow the candidate
    select f2.following_id as uid, count(*)::int as m
      from public.follows f1
      join public.follows f2 on f2.follower_id = f1.following_id
     where f1.follower_id = p_viewer and f2.following_id in (select uid from base)
     group by f2.following_id
  ), caff as (  -- creators the viewer keeps engaging with but does not follow
    select x.creator_id as uid, public.feed_decayed(x.score, x.updated_at, hl) as s
      from public.user_creator_affinity x
     where x.user_id = p_viewer and x.creator_id in (select uid from base)
  ), vt as (
    select x.topic from public.user_topic_affinity x
     where x.user_id = p_viewer and public.feed_decayed(x.score, x.updated_at, hl) >= min_t
       and (x.topic like '#%' or x.topic like 'cat:%')
  ), stp as (
    select e.author_id as uid, count(distinct t.topic)::int as n
      from public.feed_eligible_posts e
      join public.feed_post_topic t on t.post_id = e.id
      join vt on vt.topic = t.topic
     where e.author_id in (select uid from base) and e.created_at > now() - make_interval(days => win)
     group by e.author_id
  ), fol as (
    select f.following_id as uid, count(*)::int as n from public.follows f
     where f.following_id in (select uid from base) group by f.following_id
  )
  select x.uid, x.reasons, x.m, x.stn, x.ca, x.fo, x.age, x.n, x.pos
    from (
      select b.uid,
             array_remove(array[
               case when my_inst is not null and b.inst = my_inst then 'same_campus' end,
               case when coalesce(mut.m, 0) >= 1 then 'mutual' end,
               case when coalesce(caff.s, 0) >= min_c or coalesce(stp.n, 0) >= 2 then 'similar_interests' end,
               case when coalesce(fol.n, 0) <= small and b.n >= 2 and b.pos >= 1 then 'emerging' end,
               case when (my_inst is null or b.inst <> my_inst) and b.pos >= 1 then 'wide' end
             ], null) as reasons,
             coalesce(mut.m, 0)::int as m, coalesce(stp.n, 0)::int as stn,
             coalesce(caff.s, 0)::real as ca, coalesce(fol.n, 0)::int as fo,
             coalesce(extract(epoch from (now() - b.created_at::timestamptz)) / 86400.0, 0)::real as age,
             b.n as n, b.pos as pos
        from base b
        left join mut  on mut.uid  = b.uid
        left join caff on caff.uid = b.uid
        left join stp  on stp.uid  = b.uid
        left join fol  on fol.uid  = b.uid
    ) x
   where cardinality(x.reasons) > 0
   order by (x.m * 3 + x.stn + least(x.pos, 10)) desc, x.uid
   limit lim;
end $$;

revoke all on function public.feed_people_candidates(bigint) from public, anon, authenticated;
grant execute on function public.feed_people_candidates(bigint) to service_role;
commit;
