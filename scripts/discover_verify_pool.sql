-- One row of JSON. Every *_leak must be 0.
with v as (
  select u.id from public.users u
   where u.is_active and u.deleted_at is null and u.institution_id is not null
   order by (select count(*) from public.feed_exposures x where x.user_id = u.id) desc, u.id limit 1
), fy as materialized (
  select p.* from public.discover_candidate_pool((select id from v), 'verify-seed', 'for_you') p
), mk as materialized (
  select p.* from public.discover_candidate_pool((select id from v), 'verify-seed', 'marketplace') p
)
select jsonb_build_object(
  'viewer', (select id from v),
  'for_you_total', (select count(*) from fy),
  'for_you_by_kind', (select coalesce(jsonb_object_agg(kind, n), '{}') from (select kind, count(*) n from fy group by 1) t),
  'for_you_by_src', (select coalesce(jsonb_object_agg(s, n), '{}') from (select s, count(*) n from fy, unnest(srcs) s group by 1) t),
  'own_posts_leak', (select count(*) from fy where author_id = (select id from v)),
  'ineligible_leak', (select count(*) from fy f where not exists (select 1 from public.feed_eligible_posts e where e.id = f.post_id)),
  'invisible_leak', (select count(*) from fy f where not exists (
      select 1 from public.feed_eligible_posts e where e.id = f.post_id
         and public.feed_visible_to((select id from v), e.author_id, e.visibility, e.public_since, e.institution_id))),
  'negative_leak', (select count(*) from fy f where exists (
      select 1 from public.feed_exposures x where x.user_id = (select id from v) and x.post_id = f.post_id and x.negative)),
  'unavailable_listing_leak', (select count(*) from fy f join public.listing_details ld on ld.post_id = f.post_id
      where ld.status <> 'available' or coalesce(ld.quantity, 1) <= 0 or ld.accepting_orders is false),
  'story_leak', (select count(*) from fy f join public.posts p on p.id = f.post_id where p.type not in ('post','listing') or p.expires_at is not null),
  'distinct_authors', (select count(distinct author_id) from fy),
  'marketplace_total', (select count(*) from mk),
  'marketplace_non_listing', (select count(*) from mk where kind <> 'listing')
) as report;
