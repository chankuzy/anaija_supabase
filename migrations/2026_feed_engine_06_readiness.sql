-- Feed readiness report: aggregate-only (no per-user data). Service-role only.
create or replace function public.feed_readiness()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_min   int := coalesce((feed_cfg()->'compose'->>'min_pool_relax')::int, 30);
  r       jsonb;
  v_flags jsonb := '[]'::jsonb;
  g_elig  int;
begin
  with e as (
    select fe.*,
           (fe.visibility = 'public' and fe.public_since is not null) as is_guest,
           (exists (select 1 from posts p where p.id = fe.id and coalesce(p.video_key, '') <> '')
            or exists (select 1 from post_media m
                        where m.post_id = fe.id and m.media_type = 'video' and m.purged_at is null)) as has_video
      from feed_eligible_posts fe
  ),
  g as (select * from e where is_guest)
  select jsonb_build_object(
    'generated_at', now(),
    'eligible_total', (select count(*) from e),
    'guest', jsonb_build_object(
      'eligible',            (select count(*) from g),
      'fresh_48h',           (select count(*) from g where created_at > now() - interval '48 hours'),
      'fresh_7d',            (select count(*) from g where created_at > now() - interval '7 days'),
      'distinct_authors',    (select count(distinct author_id) from g),
      'distinct_authors_7d', (select count(distinct author_id) from g where created_at > now() - interval '7 days'),
      'listings',            (select count(*) from g where type = 'listing'),
      'video',               (select count(*) from g where type = 'post' and has_video),
      'image',               (select count(*) from g where type = 'post' and not has_video),
      'top_author_share',    (select coalesce(round(max(c)::numeric / nullif(sum(c), 0), 3), 0)
                                from (select count(*) c from g group by author_id) t)
    ),
    'by_visibility', (select coalesce(jsonb_object_agg(visibility, n), '{}'::jsonb)
                        from (select visibility, count(*) n from e group by 1) t),
    'campuses', (select coalesce(jsonb_agg(jsonb_build_object('institution_id', institution_id, 'eligible', n)
                                           order by n desc), '[]'::jsonb)
                   from (select institution_id, count(*) n from e
                          where institution_id is not null group by 1 order by n desc limit 10) t),
    'no_institution', (select count(*) from e where institution_id is null),
    'low_inventory_threshold', v_min
  ) into r;

  g_elig := (r->'guest'->>'eligible')::int;
  if g_elig = 0 then v_flags := v_flags || '"zero_guest_inventory"'::jsonb; end if;
  if g_elig < v_min then v_flags := v_flags || '"low_guest_inventory"'::jsonb; end if;
  if (r->'guest'->>'fresh_7d')::int = 0 then v_flags := v_flags || '"no_fresh_content_7d"'::jsonb; end if;
  if (r->'guest'->>'distinct_authors')::int < 5 then v_flags := v_flags || '"low_creator_diversity"'::jsonb; end if;
  if (r->'guest'->>'top_author_share')::numeric > 0.35 then v_flags := v_flags || '"creator_concentration"'::jsonb; end if;
  if (r->'guest'->>'listings')::int = 0 then v_flags := v_flags || '"no_guest_listings"'::jsonb; end if;
  if (r->'guest'->>'video')::int = 0 or (r->'guest'->>'image')::int = 0 then
    v_flags := v_flags || '"low_format_diversity"'::jsonb;
  end if;

  return r || jsonb_build_object('flags', v_flags);
end $$;

revoke all on function public.feed_readiness() from public, anon, authenticated;
grant execute on function public.feed_readiness() to service_role;
