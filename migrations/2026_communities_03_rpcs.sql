-- Anaija Communities · migration 03 · community_create, community_ban, posts.community_pinned_at
-- The API calls these but no earlier migration defines them. Idempotent.
begin;

alter table public.posts add column if not exists community_pinned_at timestamptz;
create index if not exists posts_community_pinned_idx
  on public.posts (community_id, community_pinned_at desc) where community_pinned_at is not null;

drop function if exists public.community_create(bigint, jsonb);
create function public.community_create(p_creator bigint, p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  insert into communities (
    creator_id, name, slug, description, avatar_key, cover_key, category, institution_id,
    faculty, department, level, course_code, academic_session,
    discoverability, join_policy, read_policy, permissions, rules, links
  ) values (
    p_creator, p->>'name', p->>'slug', p->>'description', p->>'avatar_key', p->>'cover_key',
    coalesce(p->>'category', 'other'), nullif(p->>'institution_id', '')::bigint,
    p->>'faculty', p->>'department', p->>'level', p->>'course_code', p->>'academic_session',
    coalesce(p->>'discoverability', 'listed'), coalesce(p->>'join_policy', 'open'),
    coalesce(p->>'read_policy', 'public_preview'),
    coalesce(p->'permissions',
      '{"post":"member","chat":"member","invite":"moderator","session":"moderator","announce":"moderator","library":"moderator"}'::jsonb),
    coalesce(p->'rules', '[]'::jsonb), coalesce(p->'links', '[]'::jsonb)
  ) returning id into v;
  -- the bootstrap trigger has already created the chat conversation; the member mirror adds the owner to it
  insert into community_members (community_id, user_id, role, joined_via)
  values (v, p_creator, 'owner', 'creator')
  on conflict (community_id, user_id) do update set role = 'owner';
  return v;
end $$;

drop function if exists public.community_ban(bigint, bigint, bigint, text, timestamptz);
create function public.community_ban(p_community bigint, p_user bigint, p_actor bigint, p_reason text, p_expires timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from community_members where community_id = p_community and user_id = p_user and role = 'owner') then
    raise exception 'owner cannot be banned';
  end if;
  insert into community_bans (community_id, user_id, banned_by, reason, expires_at)
  values (p_community, p_user, p_actor, nullif(p_reason, ''), p_expires)
  on conflict (community_id, user_id) do update
    set banned_by = excluded.banned_by, reason = excluded.reason, expires_at = excluded.expires_at, created_at = now();
  update community_designations set revoked_at = now(), revoked_by = p_actor
   where community_id = p_community and user_id = p_user and revoked_at is null;
  update community_join_requests set status = 'cancelled'
   where community_id = p_community and user_id = p_user and status = 'pending';
  delete from community_members where community_id = p_community and user_id = p_user;
  insert into community_mod_log (community_id, actor_id, action, target_user_id, target_kind, note)
  values (p_community, p_actor, 'ban', p_user, 'user', left(coalesce(p_reason, ''), 200));
end $$;

revoke all on function public.community_create(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.community_ban(bigint, bigint, bigint, text, timestamptz) from public, anon, authenticated;
grant execute on function public.community_create(bigint, jsonb) to service_role;
grant execute on function public.community_ban(bigint, bigint, bigint, text, timestamptz) to service_role;

commit;
