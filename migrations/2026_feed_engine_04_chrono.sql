-- Anaija Feed Engine · migration 04 · chronological pools for the Following and Campus scopes
-- Same eligibility + visibility + block rules as the ranked pool; only the ordering differs.
begin;

create or replace function public.feed_chrono_pool(p_viewer bigint, p_scope text, p_limit int)
returns table (post_id bigint, author_id bigint, kind text, created_at timestamp)
language sql stable as $$
  select e.id, e.author_id, e.type::text, e.created_at
    from public.feed_eligible_posts e
   where p_viewer is not null
     and e.author_id <> p_viewer
     and public.feed_visible_to(p_viewer, e.author_id, e.visibility, e.public_since, e.institution_id)
     and not exists (select 1 from public.user_creator_hides h
                      where h.user_id = p_viewer and h.creator_id = e.author_id)
     and not exists (select 1 from public.feed_exposures x
                      where x.user_id = p_viewer and x.post_id = e.id and x.negative)
     and case p_scope
           when 'following' then exists (
             select 1 from public.follows f
              where f.follower_id = p_viewer and f.following_id = e.author_id)
           when 'campus' then coalesce(e.institution_id, e.author_institution_id) is not null
             and coalesce(e.institution_id, e.author_institution_id) =
                 (select u.institution_id from public.users u where u.id = p_viewer)
           else false end
   order by e.created_at desc, e.id desc
   limit least(greatest(p_limit, 1), 200)
$$;

revoke all on function public.feed_chrono_pool(bigint, text, int) from public, anon, authenticated;
grant execute on function public.feed_chrono_pool(bigint, text, int) to service_role;

commit;
