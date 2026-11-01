-- Anaija Communities · migration 01 · core
-- communities, roles + designations, requests, invites, bans, library, chat mirror, reports, post-leak guards
begin;

do $$ begin
  if to_regclass('public.communities') is null or to_regclass('public.community_members') is null
     or to_regclass('public.conversations') is null or to_regclass('public.conversation_participants') is null
     or to_regclass('public.posts') is null or to_regclass('public.users') is null then
    raise exception 'Communities preflight failed: base tables are missing';
  end if;
end $$;

-- 1. communities ---------------------------------------------------------------------------
alter table public.communities
  add column if not exists cover_key text,
  add column if not exists category text not null default 'other',
  add column if not exists faculty text,
  add column if not exists department text,
  add column if not exists level text,
  add column if not exists course_code text,
  add column if not exists academic_session text,
  add column if not exists discoverability text not null default 'listed',
  add column if not exists join_policy text not null default 'open',
  add column if not exists read_policy text not null default 'public_preview',
  add column if not exists permissions jsonb not null default
    '{"post":"member","chat":"member","invite":"moderator","session":"moderator","announce":"moderator","library":"moderator"}'::jsonb,
  add column if not exists rules jsonb not null default '[]'::jsonb,
  add column if not exists links jsonb not null default '[]'::jsonb,
  add column if not exists status text not null default 'active',
  add column if not exists archived_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists realtime_key uuid not null default gen_random_uuid(),
  add column if not exists chat_conversation_id bigint references public.conversations(id) on delete set null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'communities_category_chk') then
    alter table public.communities add constraint communities_category_chk
      check (category in ('class','department','faculty','campus','creator','interest','professional','seller','other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'communities_discoverability_chk') then
    alter table public.communities add constraint communities_discoverability_chk check (discoverability in ('listed','unlisted'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'communities_join_policy_chk') then
    alter table public.communities add constraint communities_join_policy_chk check (join_policy in ('open','request','invite'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'communities_read_policy_chk') then
    alter table public.communities add constraint communities_read_policy_chk check (read_policy in ('public_preview','members_only'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'communities_status_chk') then
    alter table public.communities add constraint communities_status_chk check (status in ('active','archived','suspended'));
  end if;
end $$;

create index if not exists communities_discover_idx
  on public.communities (members_count desc, id desc)
  where is_active and status = 'active' and discoverability = 'listed';
create index if not exists communities_institution_idx on public.communities (institution_id) where institution_id is not null;

-- 2. chat conversation linked to a community ------------------------------------------------
alter table public.conversations
  add column if not exists community_id bigint references public.communities(id) on delete cascade;
create unique index if not exists conversations_one_per_community
  on public.conversations (community_id) where community_id is not null;

create or replace function public.trg_community_bootstrap() returns trigger
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  insert into conversations (type, title, avatar_key, community_id, is_active, last_message_at)
  values ('group', NEW.name, NEW.avatar_key, NEW.id, true, now())
  returning id into v;
  update communities set chat_conversation_id = v where id = NEW.id;
  return null;
end $$;

drop trigger if exists community_bootstrap on public.communities;
create trigger community_bootstrap after insert on public.communities
  for each row execute function public.trg_community_bootstrap();

do $$ declare c record; v bigint; begin
  for c in select id, name, avatar_key from public.communities where chat_conversation_id is null loop
    insert into public.conversations (type, title, avatar_key, community_id, is_active, last_message_at)
    values ('group', c.name, c.avatar_key, c.id, true, now()) returning id into v;
    update public.communities set chat_conversation_id = v where id = c.id;
  end loop;
end $$;

-- 3. members: roles, prefs ------------------------------------------------------------------
update public.community_members set role = 'member' where role is null or role not in ('owner','admin','moderator','member');

alter table public.community_members
  add column if not exists joined_via text not null default 'direct',
  add column if not exists chat_notify text not null default 'mentions',
  add column if not exists announce_notify boolean not null default true,
  add column if not exists muted_until timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'community_members_role_chk') then
    alter table public.community_members add constraint community_members_role_chk
      check (role in ('owner','admin','moderator','member'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'community_members_chat_notify_chk') then
    alter table public.community_members add constraint community_members_chat_notify_chk
      check (chat_notify in ('all','mentions','none'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'community_members_joined_via_chk') then
    alter table public.community_members add constraint community_members_joined_via_chk
      check (joined_via in ('direct','request','invite','creator'));
  end if;
end $$;

insert into public.community_members (community_id, user_id, role, joined_via)
select c.id, c.creator_id, 'owner', 'creator' from public.communities c
on conflict (community_id, user_id) do update set role = 'owner';

create unique index if not exists community_members_one_owner on public.community_members (community_id) where role = 'owner';
create index if not exists community_members_user_idx on public.community_members (user_id, community_id);
create index if not exists community_members_staff_idx on public.community_members (community_id) where role <> 'member';

-- counts + chat membership mirror (after the backfills above, so nothing double-fires)
create or replace function public.trg_community_members_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    update communities set members_count = members_count + 1 where id = NEW.community_id;
  elsif TG_OP = 'DELETE' then
    update communities set members_count = greatest(0, members_count - 1) where id = OLD.community_id;
  end if;
  return null;
end $$;

create or replace function public.trg_community_chat_mirror() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_conv bigint;
begin
  if TG_OP = 'INSERT' then
    select chat_conversation_id into v_conv from communities where id = NEW.community_id;
    if v_conv is not null then
      insert into conversation_participants (conversation_id, user_id, role, unread_count, request_status, is_muted, last_read_at)
      select v_conv, NEW.user_id, case when NEW.role in ('owner','admin') then 'admin' else 'member' end,
             0, 'accepted', (NEW.chat_notify <> 'all'), now()
       where not exists (select 1 from conversation_participants p where p.conversation_id = v_conv and p.user_id = NEW.user_id);
    end if;
  elsif TG_OP = 'DELETE' then
    delete from conversation_participants
     where user_id = OLD.user_id
       and conversation_id = (select chat_conversation_id from communities where id = OLD.community_id);
  end if;
  return null;
end $$;

insert into public.conversation_participants (conversation_id, user_id, role, unread_count, request_status, is_muted, last_read_at)
select c.chat_conversation_id, m.user_id, case when m.role in ('owner','admin') then 'admin' else 'member' end,
       0, 'accepted', (m.chat_notify <> 'all'), now()
  from public.community_members m
  join public.communities c on c.id = m.community_id
 where c.chat_conversation_id is not null
   and not exists (select 1 from public.conversation_participants p
                    where p.conversation_id = c.chat_conversation_id and p.user_id = m.user_id);

update public.communities c set members_count = (select count(*) from public.community_members m where m.community_id = c.id);

drop trigger if exists community_members_count on public.community_members;
create trigger community_members_count after insert or delete on public.community_members
  for each row execute function public.trg_community_members_count();
drop trigger if exists community_chat_mirror on public.community_members;
create trigger community_chat_mirror after insert or delete on public.community_members
  for each row execute function public.trg_community_chat_mirror();

-- 4. designations (visible titles; never implicit admin power) -------------------------------
create table if not exists public.community_designations (
  id bigint generated always as identity primary key,
  community_id bigint not null references public.communities(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('class_rep','course_rep','dept_exec','contributor')),
  scope_label text,
  can_announce boolean not null default false,
  granted_by bigint references public.users(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by bigint references public.users(id)
);
create unique index if not exists community_designations_active_uniq
  on public.community_designations (community_id, user_id, kind, coalesce(scope_label, '')) where revoked_at is null;
create index if not exists community_designations_user_idx
  on public.community_designations (community_id, user_id) where revoked_at is null;

-- 5. join requests, invites, bans, moderation log -----------------------------------------------
create table if not exists public.community_join_requests (
  id bigint generated always as identity primary key,
  community_id bigint not null references public.communities(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  message text check (message is null or char_length(message) <= 300),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  decided_by bigint references public.users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists community_join_requests_pending_uniq
  on public.community_join_requests (community_id, user_id) where status = 'pending';
create index if not exists community_join_requests_queue_idx
  on public.community_join_requests (community_id, created_at desc) where status = 'pending';

create table if not exists public.community_invites (
  id bigint generated always as identity primary key,
  community_id bigint not null references public.communities(id) on delete cascade,
  token text not null unique,
  label text,
  created_by bigint not null references public.users(id),
  max_uses int check (max_uses is null or max_uses > 0),
  uses int not null default 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists community_invites_community_idx on public.community_invites (community_id, created_at desc);

create table if not exists public.community_bans (
  community_id bigint not null references public.communities(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  banned_by bigint references public.users(id),
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (community_id, user_id)
);

create table if not exists public.community_mod_log (
  id bigint generated always as identity primary key,
  community_id bigint not null references public.communities(id) on delete cascade,
  actor_id bigint references public.users(id),
  action text not null,
  target_user_id bigint,
  target_kind text,
  target_id bigint,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists community_mod_log_idx on public.community_mod_log (community_id, id desc);

-- 6. library ---------------------------------------------------------------------------------
create table if not exists public.community_collections (
  id bigint generated always as identity primary key,
  community_id bigint not null references public.communities(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  description text,
  sort_order int not null default 0,
  created_by bigint references public.users(id),
  created_at timestamptz not null default now()
);
create index if not exists community_collections_idx on public.community_collections (community_id, sort_order, id);

create table if not exists public.library_resources (
  id bigint generated always as identity primary key,
  community_id bigint not null references public.communities(id) on delete cascade,
  post_id bigint not null unique references public.posts(id) on delete cascade,
  uploader_id bigint not null references public.users(id),
  title text not null check (char_length(title) between 1 and 120),
  description text check (description is null or char_length(description) <= 500),
  doc_type text not null default 'other'
    check (doc_type in ('past_question','lecture_note','slides','textbook','assignment','syllabus','project','other')),
  course_code text,
  academic_session text,
  subject text,
  collection_id bigint references public.community_collections(id) on delete set null,
  is_active boolean not null default true,
  removed_by bigint references public.users(id),
  created_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    to_tsvector('simple'::regconfig,
      coalesce(title, '') || ' ' || coalesce(course_code, '') || ' ' || coalesce(subject, '') || ' ' ||
      coalesce(description, '') || ' ' || coalesce(academic_session, ''))
  ) stored
);
create index if not exists library_resources_list_idx on public.library_resources (community_id, id desc) where is_active;
create index if not exists library_resources_course_idx on public.library_resources (community_id, course_code) where is_active;
create index if not exists library_resources_collection_idx on public.library_resources (collection_id) where is_active;
create index if not exists library_resources_fts_idx on public.library_resources using gin (search_vector);

-- 7. reports (community moderation queue; the existing `reports` table stays app feedback) ----------
create table if not exists public.content_reports (
  id bigint generated always as identity primary key,
  reporter_id bigint not null references public.users(id) on delete cascade,
  community_id bigint references public.communities(id) on delete cascade,
  target_kind text not null check (target_kind in ('post','comment','message','session_post','resource','community','user')),
  target_id bigint not null,
  reason text not null check (reason in ('spam','harassment','hate','sexual','violence','misinformation','privacy','other')),
  details text check (details is null or char_length(details) <= 500),
  status text not null default 'open' check (status in ('open','actioned','dismissed')),
  handled_by bigint references public.users(id),
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (reporter_id, target_kind, target_id)
);
create index if not exists content_reports_queue_idx on public.content_reports (community_id, status, created_at desc);

-- 8. posts: community scoping + leak guards ------------------------------------------------------
alter table public.posts add column if not exists community_feed boolean not null default true;
create index if not exists posts_community_idx on public.posts (community_id, id desc) where community_id is not null;

create or replace function public.trg_posts_community_private() returns trigger
language plpgsql as $$
begin
  if NEW.community_id is not null then
    NEW.visibility := 'private';
    NEW.public_since := null;
  end if;
  return NEW;
end $$;

drop trigger if exists posts_community_private on public.posts;
create trigger posts_community_private before insert or update of community_id, visibility on public.posts
  for each row execute function public.trg_posts_community_private();

update public.posts set visibility = 'private', public_since = null
 where community_id is not null and (visibility <> 'private' or public_since is not null);

-- followers must never get "new post" alerts for community or private posts
create or replace function public.trg_activity_post() returns trigger
language plpgsql security definer set search_path = public as $$
declare r bigint; v_tk text;
begin
  begin
    if TG_OP = 'UPDATE' and OLD.is_active is true and OLD.deleted_at is null
       and (NEW.is_active is not true or NEW.deleted_at is not null) then
      perform activity_retract_content(NEW.id);
      return null;
    end if;

    if NEW.community_id is not null or NEW.visibility = 'private' then
      return null;
    end if;

    if NEW.type in ('post', 'listing') and NEW.is_active is true and NEW.deleted_at is null
       and NEW.processing_status = 'ready'
       and (TG_OP = 'INSERT' or OLD.processing_status is distinct from 'ready') then
      v_tk := case when NEW.type = 'listing' then 'listing' else 'post' end;
      for r in select f.follower_id from follows f
                where f.following_id = NEW.user_id and f.notify_posts limit 500 loop
        perform activity_record(
          p_recipient => r, p_actor => NEW.user_id, p_kind => 'post_new',
          p_group_key => 'post_new:' || NEW.id || ':' || r,
          p_dedupe => 'post_new:' || NEW.id || ':' || r,
          p_target_kind => v_tk, p_target_id => NEW.id, p_content_id => NEW.id);
      end loop;
      if coalesce(NEW.visibility, 'public') = 'public' and NEW.caption is not null then
        for r in select activity_mention_ids(NEW.caption, NEW.user_id) loop
          perform activity_record(
            p_recipient => r, p_actor => NEW.user_id, p_kind => 'mention',
            p_group_key => 'mention:post:' || NEW.id || ':' || r,
            p_dedupe => 'mention:post:' || NEW.id || ':' || r,
            p_target_kind => v_tk, p_target_id => NEW.id, p_content_id => NEW.id,
            p_payload => jsonb_build_object('where', 'post', 'preview', left(NEW.caption, 160)));
        end loop;
      end if;
    end if;
  exception when others then
    perform activity_log_error('trg_activity_post', sqlerrm, jsonb_build_object('op', TG_OP));
  end;
  return null;
end $$;

-- 9. membership functions (single transaction each; the API checks roles, these check state) --------
create or replace function public.community_join_open(p_community bigint, p_user bigint) returns text
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select id, join_policy, status, is_active into c from communities where id = p_community for share;
  if not found or c.is_active is not true or c.status <> 'active' then return 'not_found'; end if;
  if exists (select 1 from community_bans b where b.community_id = p_community and b.user_id = p_user
              and (b.expires_at is null or b.expires_at > now())) then return 'banned'; end if;
  if exists (select 1 from community_members where community_id = p_community and user_id = p_user) then return 'already_member'; end if;
  if c.join_policy = 'request' then return 'needs_request'; end if;
  if c.join_policy = 'invite' then return 'invite_only'; end if;
  insert into community_members (community_id, user_id, role, joined_via)
  values (p_community, p_user, 'member', 'direct') on conflict do nothing;
  return 'joined';
end $$;

create or replace function public.community_request_join(p_community bigint, p_user bigint, p_message text) returns text
language plpgsql security definer set search_path = public as $$
declare c record; v bigint;
begin
  select id, join_policy, status, is_active into c from communities where id = p_community for share;
  if not found or c.is_active is not true or c.status <> 'active' then return 'not_found'; end if;
  if exists (select 1 from community_bans b where b.community_id = p_community and b.user_id = p_user
              and (b.expires_at is null or b.expires_at > now())) then return 'banned'; end if;
  if exists (select 1 from community_members where community_id = p_community and user_id = p_user) then return 'already_member'; end if;
  if c.join_policy <> 'request' then return 'not_requestable'; end if;
  insert into community_join_requests (community_id, user_id, message)
  values (p_community, p_user, nullif(left(coalesce(p_message, ''), 300), ''))
  on conflict do nothing returning id into v;
  return case when v is null then 'already_requested' else 'requested' end;
end $$;

create or replace function public.community_decide_request(p_request bigint, p_actor bigint, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from community_join_requests where id = p_request for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if r.status <> 'pending' then
    return jsonb_build_object('result', 'already_decided', 'community_id', r.community_id, 'user_id', r.user_id);
  end if;
  if p_approve then
    if exists (select 1 from community_bans b where b.community_id = r.community_id and b.user_id = r.user_id
                and (b.expires_at is null or b.expires_at > now())) then
      update community_join_requests set status = 'rejected', decided_by = p_actor, decided_at = now() where id = p_request;
      return jsonb_build_object('result', 'banned', 'community_id', r.community_id, 'user_id', r.user_id);
    end if;
    insert into community_members (community_id, user_id, role, joined_via)
    values (r.community_id, r.user_id, 'member', 'request') on conflict do nothing;
  end if;
  update community_join_requests
     set status = case when p_approve then 'approved' else 'rejected' end, decided_by = p_actor, decided_at = now()
   where id = p_request;
  return jsonb_build_object('result', case when p_approve then 'approved' else 'rejected' end,
                            'community_id', r.community_id, 'user_id', r.user_id);
end $$;

create or replace function public.community_redeem_invite(p_token text, p_user bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i record; c record;
begin
  select * into i from community_invites where token = p_token for update;
  if not found or i.revoked_at is not null then return jsonb_build_object('result', 'invalid'); end if;
  select id, slug, name, status, is_active into c from communities where id = i.community_id;
  if not found or c.is_active is not true or c.status <> 'active' then return jsonb_build_object('result', 'invalid'); end if;
  if i.expires_at is not null and i.expires_at <= now() then
    return jsonb_build_object('result', 'expired', 'slug', c.slug);
  end if;
  if exists (select 1 from community_bans b where b.community_id = c.id and b.user_id = p_user
              and (b.expires_at is null or b.expires_at > now())) then
    return jsonb_build_object('result', 'banned', 'slug', c.slug);
  end if;
  if exists (select 1 from community_members where community_id = c.id and user_id = p_user) then
    return jsonb_build_object('result', 'already_member', 'community_id', c.id, 'slug', c.slug);
  end if;
  if i.max_uses is not null and i.uses >= i.max_uses then
    return jsonb_build_object('result', 'exhausted', 'slug', c.slug);
  end if;
  insert into community_members (community_id, user_id, role, joined_via)
  values (c.id, p_user, 'member', 'invite') on conflict do nothing;
  update community_invites set uses = uses + 1 where id = i.id;
  update community_join_requests set status = 'cancelled'
   where community_id = c.id and user_id = p_user and status = 'pending';
  return jsonb_build_object('result', 'joined', 'community_id', c.id, 'slug', c.slug);
end $$;

-- bulk unread bump for community chat (one statement instead of one update per member)
create or replace function public.community_chat_bump(p_conversation bigint, p_sender bigint) returns void
language sql security definer set search_path = public as $$
  update conversation_participants set unread_count = unread_count + 1
   where conversation_id = p_conversation and user_id <> p_sender
$$;

-- 10. lock down ----------------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['communities','community_members','community_designations','community_join_requests',
                           'community_invites','community_bans','community_mod_log','community_collections',
                           'library_resources','content_reports'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to service_role;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'community\_%' or p.proname like 'trg\_community\_%' or p.proname like 'trg\_posts\_community%') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

commit;
