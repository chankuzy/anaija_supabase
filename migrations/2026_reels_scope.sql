-- Reels scope (already applied in prod; recorded here so the repo matches).
-- Reel = standalone post (type='post') that is a video, or images carrying playable audio.
-- Listings, stories, silent images and carousels are never reels.
begin;

create or replace function public.feed_is_reel(p_post_id bigint)
returns boolean language sql stable as $$
  select exists (
    select 1
      from public.posts p
     where p.id = p_post_id
       and p.type = 'post'
       and p.expires_at is null
       and (
         coalesce(p.video_key, '') <> ''
         or exists (select 1 from public.post_media m
                     where m.post_id = p.id and m.media_type = 'video' and m.purged_at is null)
         or (
           p.audio_asset_id is not null
           and coalesce((p.audio_config->>'enabled')::boolean, true)
           and exists (select 1 from public.audio_assets a where a.id = p.audio_asset_id)
           and exists (select 1 from public.post_media m
                        where m.post_id = p.id and m.media_type = 'image' and m.purged_at is null)
         )
       )
  )
$$;

create or replace function public.feed_candidate_pool_reels(p_viewer bigint, p_seed text, p_cfg jsonb default null)
returns table (
  post_id bigint, author_id bigint, kind text, subtype text, listing_type text,
  age_hours real, inst bigint, is_video boolean, duration_s int, topics text[], srcs text[],
  interest_strength real, author_followers int, is_following boolean, creator_score real,
  impressions int, views int, completions int, rewatches int, skips int, likes int, comments int,
  saves int, shares int, reposts int, follows_from int, negatives int, delivered int
) language sql stable as $$
  select c.* from public.feed_candidate_pool(p_viewer, p_seed, p_cfg) c
   where public.feed_is_reel(c.post_id)
$$;

revoke all on function public.feed_is_reel(bigint) from public, anon, authenticated;
revoke all on function public.feed_candidate_pool_reels(bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.feed_is_reel(bigint) to service_role;
grant execute on function public.feed_candidate_pool_reels(bigint, text, jsonb) to service_role;

commit;
