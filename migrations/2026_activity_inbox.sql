-- Anaija activity inbox: aggregation in Postgres, push via outbox. Atomic.
begin;

-- 0. things production is missing --------------------------------------------
alter table public.follows add column if not exists notify_posts boolean not null default false;
create index if not exists follows_notify_idx on public.follows (following_id) where notify_posts;
alter table public.notification_preferences add column if not exists hide_message_preview boolean not null default false;

-- 1. extend the (empty) activity tables ---------------------------------------
alter table public.activity_items
  add column if not exists dismissed_at timestamptz,
  add column if not exists last_push_at timestamptz,
  add column if not exists last_payload jsonb not null default '{}'::jsonb,
  add column if not exists last_comment_id bigint;
create index if not exists activity_items_unread_idx on public.activity_items (recipient_id)
  where read_at is null and retracted_at is null and dismissed_at is null;
create index if not exists activity_events_comment_idx on public.activity_events (comment_id)
  where comment_id is not null and retracted_at is null;
create index if not exists activity_events_content_idx on public.activity_events (content_id)
  where content_id is not null and retracted_at is null;

-- 2. new tables ---------------------------------------------------------------
create table if not exists public.activity_policy (
  kind text primary key,
  merge boolean not null default true,
  window_secs int not null default 0,
  max_life_secs int not null default 0,
  restore_secs int not null default 0,
  push_mode text not null default 'each' check (push_mode in ('each','item','none')),
  push_cooldown_secs int not null default 0
);
insert into public.activity_policy (kind, merge, window_secs, max_life_secs, restore_secs, push_mode, push_cooldown_secs) values
  ('like',        true,  21600, 86400,  2592000, 'item', 1800),
  ('story_like',  true,  10800, 86400,  2592000, 'item', 1800),
  ('story_reply', true,  21600, 86400,  0,       'none', 0),
  ('comment',     true,  600,   3600,   0,       'item', 0),
  ('reply',       true,  600,   3600,   0,       'item', 0),
  ('mention',     false, 0,     0,      0,       'each', 0),
  ('follow',      true,  43200, 172800, 604800,  'item', 3600),
  ('follow_back', true,  43200, 172800, 604800,  'item', 3600),
  ('repost',      true,  21600, 86400,  2592000, 'item', 1800),
  ('inquiry',     false, 0,     0,      0,       'each', 0),
  ('post_new',    false, 0,     0,      0,       'each', 0),
  ('milestone',   false, 0,     0,      0,       'each', 0),
  ('system',      false, 0,     0,      0,       'each', 0)
on conflict (kind) do nothing;

create table if not exists public.push_outbox (
  id bigint generated always as identity primary key,
  recipient_id bigint not null references public.users(id) on delete cascade,
  kind text not null,
  item_id bigint references public.activity_items(id) on delete cascade,
  event_id bigint references public.activity_events(id) on delete set null,
  conversation_id bigint,
  message_id bigint,
  collapse_key text not null,
  status text not null default 'pending' check (status in ('pending','sending','sent','suppressed','retry','dead')),
  attempts int not null default 0,
  reason text,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists push_outbox_due_idx on public.push_outbox (status, next_attempt_at)
  where status in ('pending','retry','sending');
create index if not exists push_outbox_created_idx on public.push_outbox (created_at);

create table if not exists public.user_activity_topics (
  user_id bigint primary key references public.users(id) on delete cascade,
  topic uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists public.activity_errors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  fn text, error text, detail jsonb
);

-- 3. core functions -----------------------------------------------------------
create or replace function public.activity_log_error(p_fn text, p_err text, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.activity_errors (fn, error, detail) values (p_fn, p_err, p_detail);
$$;

create or replace function public.activity_recount(p_item bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_live int; v_actors int; v_targets int; v_first timestamptz; v_last timestamptz;
  v_ap bigint[]; v_tp bigint[]; v_payload jsonb; v_comment bigint;
begin
  if p_item is null then return; end if;

  select count(*), count(distinct actor_id), count(distinct target_id), min(occurred_at), max(occurred_at)
    into v_live, v_actors, v_targets, v_first, v_last
    from activity_events where item_id = p_item and retracted_at is null;

  select coalesce(array_agg(a.actor_id order by a.m desc), '{}') into v_ap from (
    select actor_id, max(occurred_at) as m from activity_events
     where item_id = p_item and retracted_at is null and actor_id is not null
     group by actor_id order by m desc limit 5) a;

  select coalesce(array_agg(t.target_id order by t.m desc), '{}') into v_tp from (
    select target_id, max(occurred_at) as m from activity_events
     where item_id = p_item and retracted_at is null and target_id is not null
     group by target_id order by m desc limit 5) t;

  select payload, comment_id into v_payload, v_comment from activity_events
   where item_id = p_item and retracted_at is null order by occurred_at desc, id desc limit 1;

  update activity_items set
    event_count = v_live, actor_count = v_actors, target_count = v_targets,
    actors_preview = v_ap, targets_preview = v_tp,
    first_event_at = coalesce(v_first, first_event_at),
    last_event_at = coalesce(v_last, last_event_at),
    last_payload = coalesce(v_payload, last_payload),
    last_comment_id = v_comment,
    retracted_at = case when v_live = 0 then coalesce(retracted_at, now()) else null end,
    closed_at = case when v_live = 0 then coalesce(closed_at, now()) else closed_at end
  where id = p_item;
end $$;

create or replace function public.activity_record(
  p_recipient bigint, p_actor bigint, p_kind text, p_group_key text, p_dedupe text,
  p_target_kind text default null, p_target_id bigint default null, p_content_id bigint default null,
  p_comment_id bigint default null, p_payload jsonb default '{}'::jsonb,
  p_expires timestamptz default null, p_push boolean default true, p_now timestamptz default now()
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  pol activity_policy%rowtype;
  ev activity_events%rowtype;
  it activity_items%rowtype;
  v_event bigint; v_item bigint; v_new boolean := false; v_pushed bigint; v_topic uuid;
begin
  if p_recipient is null or p_recipient = p_actor then return null; end if;

  if p_actor is not null and exists (
    select 1 from user_blocks
     where (blocker_id = p_recipient and blocked_id = p_actor)
        or (blocker_id = p_actor and blocked_id = p_recipient)
  ) then return null; end if;

  select * into pol from activity_policy where kind = p_kind;
  if not found then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_recipient::text || '|' || p_group_key, 0));

  insert into activity_events (recipient_id, actor_id, kind, target_kind, target_id, content_id,
                               comment_id, payload, dedupe_key, occurred_at)
  values (p_recipient, p_actor, p_kind, p_target_kind, p_target_id, p_content_id,
          p_comment_id, coalesce(p_payload, '{}'::jsonb), p_dedupe, p_now)
  on conflict (dedupe_key) do nothing
  returning id into v_event;

  if v_event is null then
    select * into ev from activity_events where dedupe_key = p_dedupe for update;
    if ev.retracted_at is null then
      return ev.item_id;                                   -- true duplicate
    end if;
    if ev.item_id is not null and pol.restore_secs > 0
       and p_now - ev.retracted_at <= make_interval(secs => pol.restore_secs) then
      update activity_events set retracted_at = null where id = ev.id;
      perform activity_recount(ev.item_id);                -- silent restore: no re-badge, no push
      return ev.item_id;
    end if;
    update activity_events set retracted_at = null, item_id = null, occurred_at = p_now,
           actor_id = p_actor, payload = coalesce(p_payload, '{}'::jsonb)
     where id = ev.id;
    v_event := ev.id;
  end if;

  select * into it from activity_items
   where recipient_id = p_recipient and group_key = p_group_key
     and closed_at is null and retracted_at is null
   for update;
  if found then
    if pol.merge and it.read_at is null and it.dismissed_at is null
       and p_now - it.last_event_at <= make_interval(secs => pol.window_secs)
       and p_now - it.first_event_at <= make_interval(secs => pol.max_life_secs) then
      v_item := it.id;
    else
      update activity_items set closed_at = p_now where id = it.id;
    end if;
  end if;

  if v_item is null then
    insert into activity_items (recipient_id, kind, group_key, target_kind, target_id, content_id,
        actor_count, event_count, target_count, actors_preview, targets_preview,
        first_event_at, last_event_at, closed_at, expires_at, last_payload, last_comment_id)
    values (p_recipient, p_kind, p_group_key, p_target_kind, p_target_id, p_content_id,
        0, 0, 0, '{}', '{}', p_now, p_now,
        case when pol.merge then null else p_now end, p_expires,
        coalesce(p_payload, '{}'::jsonb), p_comment_id)
    returning id into v_item;
    v_new := true;
  end if;

  update activity_events set item_id = v_item where id = v_event;
  perform activity_recount(v_item);
  if not v_new then
    update activity_items set seen_at = null where id = v_item;   -- new activity re-badges
  end if;

  if p_push and pol.push_mode <> 'none' then
    if pol.push_mode = 'each' then
      insert into push_outbox (recipient_id, kind, item_id, event_id, collapse_key)
      values (p_recipient, p_kind, v_item, v_event, 'ev:' || v_event);
    else
      update activity_items set last_push_at = p_now
       where id = v_item
         and (last_push_at is null or p_now - last_push_at >= make_interval(secs => pol.push_cooldown_secs))
      returning id into v_pushed;
      if v_pushed is not null then
        insert into push_outbox (recipient_id, kind, item_id, event_id, collapse_key)
        values (p_recipient, p_kind, v_item, v_event, 'item:' || v_item);
      end if;
    end if;
  end if;

  begin
    select topic into v_topic from user_activity_topics where user_id = p_recipient;
    if v_topic is not null then
      perform realtime.send(jsonb_build_object('kind', p_kind), 'activity_changed', 'activity:' || v_topic::text, false);
    end if;
  exception when others then null;
  end;

  return v_item;
end $$;

create or replace function public.activity_retract_key(p_dedupe text)
returns void language plpgsql security definer set search_path = public as $$
declare v_item bigint;
begin
  update activity_events set retracted_at = now()
   where dedupe_key = p_dedupe and retracted_at is null returning item_id into v_item;
  if v_item is not null then perform activity_recount(v_item); end if;
end $$;

create or replace function public.activity_retract_comment(p_comment bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_items bigint[]; i bigint;
begin
  with u as (update activity_events set retracted_at = now()
              where comment_id = p_comment and retracted_at is null returning item_id)
  select coalesce(array_agg(distinct item_id) filter (where item_id is not null), '{}') into v_items from u;
  foreach i in array v_items loop perform activity_recount(i); end loop;
end $$;

create or replace function public.activity_retract_content(p_content bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_items bigint[]; i bigint;
begin
  with u as (update activity_events set retracted_at = now()
              where content_id = p_content and retracted_at is null returning item_id)
  select coalesce(array_agg(distinct item_id) filter (where item_id is not null), '{}') into v_items from u;
  foreach i in array v_items loop perform activity_recount(i); end loop;
end $$;

create or replace function public.activity_retract_pair(a bigint, b bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_items bigint[]; i bigint;
begin
  with u as (update activity_events set retracted_at = now()
              where retracted_at is null
                and ((recipient_id = a and actor_id = b) or (recipient_id = b and actor_id = a))
              returning item_id)
  select coalesce(array_agg(distinct item_id) filter (where item_id is not null), '{}') into v_items from u;
  foreach i in array v_items loop perform activity_recount(i); end loop;
end $$;

create or replace function public.activity_mention_ids(p_text text, p_author bigint)
returns setof bigint language sql stable security definer set search_path = public as $$
  select distinct u.id
    from regexp_matches(coalesce(p_text, ''), '@([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)', 'g') as rm(g)
    join users u on lower(u.username) = lower((rm.g)[1])
   where u.is_active and u.id <> p_author and length((rm.g)[1]) between 2 and 30
   limit 5;
$$;

create or replace function public.activity_purge()
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from activity_items where last_event_at < now() - interval '90 days';
  delete from activity_events where occurred_at < now() - interval '90 days';
  delete from push_outbox where created_at < now() - interval '30 days';
  delete from activity_errors where at < now() - interval '30 days';
end $$;

-- 4. triggers: a bug here logs to activity_errors, it NEVER fails the user's action -----
create or replace function public.trg_activity_like() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record; v_kind text; v_tk text; v_cnt int;
begin
  begin
    if TG_OP = 'INSERT' then
      select user_id, type, is_active, expires_at into p from posts where id = NEW.post_id;
      if p.user_id is null or p.is_active is not true then return null; end if;
      v_kind := case when p.type = 'story' then 'story_like' else 'like' end;
      v_tk := case p.type when 'story' then 'story' when 'listing' then 'listing' else 'post' end;
      perform activity_record(
        p_recipient => p.user_id, p_actor => NEW.user_id, p_kind => v_kind,
        p_group_key => v_kind || ':' || NEW.post_id,
        p_dedupe => 'like:' || NEW.user_id || ':' || NEW.post_id,
        p_target_kind => v_tk, p_target_id => NEW.post_id, p_content_id => NEW.post_id,
        p_expires => p.expires_at);
      if p.type <> 'story' then
        select count(*) into v_cnt from post_likes where post_id = NEW.post_id;
        if v_cnt = any (array[10, 50, 100, 250, 500, 1000, 2500, 5000, 10000]) then
          perform activity_record(
            p_recipient => p.user_id, p_actor => null, p_kind => 'milestone',
            p_group_key => 'milestone:likes:' || NEW.post_id || ':' || v_cnt,
            p_dedupe => 'milestone:likes:' || NEW.post_id || ':' || v_cnt,
            p_target_kind => v_tk, p_target_id => NEW.post_id, p_content_id => NEW.post_id,
            p_payload => jsonb_build_object('metric', 'likes', 'n', v_cnt));
        end if;
      end if;
    elsif TG_OP = 'DELETE' then
      perform activity_retract_key('like:' || OLD.user_id || ':' || OLD.post_id);
    end if;
  exception when others then
    perform activity_log_error('trg_activity_like', sqlerrm, jsonb_build_object('op', TG_OP));
  end;
  return null;
end $$;

create or replace function public.trg_activity_follow() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_kind text; v_cnt int;
begin
  begin
    if TG_OP = 'INSERT' then
      v_kind := case when exists (select 1 from follows
                                   where follower_id = NEW.following_id and following_id = NEW.follower_id)
                     then 'follow_back' else 'follow' end;
      perform activity_record(
        p_recipient => NEW.following_id, p_actor => NEW.follower_id, p_kind => v_kind,
        p_group_key => v_kind,
        p_dedupe => 'follow:' || NEW.follower_id || ':' || NEW.following_id,
        p_target_kind => 'user', p_target_id => NEW.following_id);
      select count(*) into v_cnt from follows where following_id = NEW.following_id;
      if v_cnt = any (array[10, 50, 100, 250, 500, 1000, 5000]) then
        perform activity_record(
          p_recipient => NEW.following_id, p_actor => null, p_kind => 'milestone',
          p_group_key => 'milestone:followers:' || NEW.following_id || ':' || v_cnt,
          p_dedupe => 'milestone:followers:' || NEW.following_id || ':' || v_cnt,
          p_target_kind => 'user', p_target_id => NEW.following_id,
          p_payload => jsonb_build_object('metric', 'followers', 'n', v_cnt));
      end if;
    elsif TG_OP = 'DELETE' then
      perform activity_retract_key('follow:' || OLD.follower_id || ':' || OLD.following_id);
    end if;
  exception when others then
    perform activity_log_error('trg_activity_follow', sqlerrm, jsonb_build_object('op', TG_OP));
  end;
  return null;
end $$;

create or replace function public.trg_activity_comment() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record; par bigint; v_tk text; v_ids bigint[] := '{}'; m bigint;
begin
  begin
    if TG_OP = 'INSERT' then
      if NEW.deleted_at is not null then return null; end if;
      select user_id, type, visibility, is_active into p from posts where id = NEW.post_id;
      if p.user_id is null or p.is_active is not true then return null; end if;
      v_tk := case when p.type = 'listing' then 'listing' else 'post' end;

      if NEW.parent_id is not null then
        select user_id into par from comments where id = NEW.parent_id;
        if par is not null and par <> NEW.user_id then
          perform activity_record(
            p_recipient => par, p_actor => NEW.user_id, p_kind => 'reply',
            p_group_key => 'reply:' || NEW.parent_id || ':' || NEW.user_id,
            p_dedupe => 'reply:' || NEW.id || ':' || par,
            p_target_kind => 'comment', p_target_id => NEW.parent_id, p_content_id => NEW.post_id,
            p_comment_id => NEW.id, p_payload => jsonb_build_object('preview', left(NEW.body, 160)));
          v_ids := v_ids || par;
        end if;
      end if;

      if p.user_id <> NEW.user_id and not (p.user_id = any (v_ids)) then
        perform activity_record(
          p_recipient => p.user_id, p_actor => NEW.user_id, p_kind => 'comment',
          p_group_key => 'comment:' || NEW.post_id || ':' || NEW.user_id,
          p_dedupe => 'comment:' || NEW.id || ':' || p.user_id,
          p_target_kind => v_tk, p_target_id => NEW.post_id, p_content_id => NEW.post_id,
          p_comment_id => NEW.id, p_payload => jsonb_build_object('preview', left(NEW.body, 160)));
        v_ids := v_ids || p.user_id;
      end if;

      if coalesce(p.visibility, 'public') = 'public' then
        for m in select activity_mention_ids(NEW.body, NEW.user_id) loop
          if not (m = any (v_ids)) then
            perform activity_record(
              p_recipient => m, p_actor => NEW.user_id, p_kind => 'mention',
              p_group_key => 'mention:comment:' || NEW.id || ':' || m,
              p_dedupe => 'mention:comment:' || NEW.id || ':' || m,
              p_target_kind => 'comment', p_target_id => NEW.id, p_content_id => NEW.post_id,
              p_comment_id => NEW.id,
              p_payload => jsonb_build_object('where', 'comment', 'preview', left(NEW.body, 160)));
          end if;
        end loop;
      end if;
    elsif TG_OP = 'UPDATE' then
      if NEW.deleted_at is not null and OLD.deleted_at is null then
        perform activity_retract_comment(NEW.id);
      end if;
    elsif TG_OP = 'DELETE' then
      perform activity_retract_comment(OLD.id);
    end if;
  exception when others then
    perform activity_log_error('trg_activity_comment', sqlerrm, jsonb_build_object('op', TG_OP));
  end;
  return null;
end $$;

create or replace function public.trg_activity_repost() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  begin
    if TG_OP = 'INSERT' then
      select user_id, is_active into p from posts where id = NEW.post_id;
      if p.user_id is null or p.is_active is not true then return null; end if;
      perform activity_record(
        p_recipient => p.user_id, p_actor => NEW.user_id, p_kind => 'repost',
        p_group_key => 'repost:' || NEW.post_id,
        p_dedupe => 'repost:' || NEW.user_id || ':' || NEW.post_id,
        p_target_kind => 'post', p_target_id => NEW.post_id, p_content_id => NEW.post_id);
    elsif TG_OP = 'DELETE' then
      perform activity_retract_key('repost:' || OLD.user_id || ':' || OLD.post_id);
    end if;
  exception when others then
    perform activity_log_error('trg_activity_repost', sqlerrm, jsonb_build_object('op', TG_OP));
  end;
  return null;
end $$;

create or replace function public.trg_activity_inquiry() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform activity_record(
      p_recipient => NEW.seller_id, p_actor => NEW.buyer_id, p_kind => 'inquiry',
      p_group_key => 'inquiry:' || NEW.id, p_dedupe => 'inquiry:' || NEW.id,
      p_target_kind => 'listing', p_target_id => NEW.post_id, p_content_id => NEW.post_id,
      p_payload => jsonb_build_object('message', left(coalesce(NEW.message, ''), 160),
                                      'conversation_id', NEW.conversation_id));
  exception when others then
    perform activity_log_error('trg_activity_inquiry', sqlerrm, '{}'::jsonb);
  end;
  return null;
end $$;

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

create or replace function public.trg_activity_block() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform activity_retract_pair(NEW.blocker_id, NEW.blocked_id);
  exception when others then
    perform activity_log_error('trg_activity_block', sqlerrm, '{}'::jsonb);
  end;
  return null;
end $$;

create or replace function public.trg_activity_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare r bigint; sp record;
begin
  begin
    -- the inquiry opener (listing_share) is covered by the inquiry item + push
    if NEW.type <> 'listing_share' then
      for r in select cp.user_id from conversation_participants cp
                where cp.conversation_id = NEW.conversation_id and cp.user_id <> NEW.sender_id
                  and cp.is_muted is false and cp.request_status <> 'declined' loop
        insert into push_outbox (recipient_id, kind, conversation_id, message_id, collapse_key)
        values (r, 'message', NEW.conversation_id, NEW.id, 'chat:' || NEW.conversation_id);
      end loop;
    end if;

    if NEW.type = 'post_share' and NEW.shared_post_id is not null then
      select user_id, type, expires_at, is_active into sp from posts where id = NEW.shared_post_id;
      if sp.type = 'story' and sp.is_active is true and sp.user_id <> NEW.sender_id
         and exists (select 1 from conversation_participants
                      where conversation_id = NEW.conversation_id and user_id = sp.user_id) then
        perform activity_record(
          p_recipient => sp.user_id, p_actor => NEW.sender_id, p_kind => 'story_reply',
          p_group_key => 'story_reply:' || NEW.shared_post_id,
          p_dedupe => 'story_reply:' || NEW.id,
          p_target_kind => 'story', p_target_id => NEW.shared_post_id, p_content_id => NEW.shared_post_id,
          p_payload => jsonb_build_object('preview', left(coalesce(NEW.body, ''), 160),
                                          'conversation_id', NEW.conversation_id),
          p_expires => sp.expires_at, p_push => false);
      end if;
    end if;
  exception when others then
    perform activity_log_error('trg_activity_message', sqlerrm, '{}'::jsonb);
  end;
  return null;
end $$;

drop trigger if exists activity_on_like on public.post_likes;
create trigger activity_on_like after insert or delete on public.post_likes
  for each row execute function public.trg_activity_like();
drop trigger if exists activity_on_follow on public.follows;
create trigger activity_on_follow after insert or delete on public.follows
  for each row execute function public.trg_activity_follow();
drop trigger if exists activity_on_comment on public.comments;
create trigger activity_on_comment after insert or update of deleted_at or delete on public.comments
  for each row execute function public.trg_activity_comment();
drop trigger if exists activity_on_repost on public.reposts;
create trigger activity_on_repost after insert or delete on public.reposts
  for each row execute function public.trg_activity_repost();
drop trigger if exists activity_on_inquiry on public.listing_inquiries;
create trigger activity_on_inquiry after insert on public.listing_inquiries
  for each row execute function public.trg_activity_inquiry();
drop trigger if exists activity_on_post on public.posts;
create trigger activity_on_post after insert or update of is_active, deleted_at, processing_status on public.posts
  for each row execute function public.trg_activity_post();
drop trigger if exists activity_on_block on public.user_blocks;
create trigger activity_on_block after insert on public.user_blocks
  for each row execute function public.trg_activity_block();
drop trigger if exists activity_on_message on public.messages;
create trigger activity_on_message after insert on public.messages
  for each row execute function public.trg_activity_message();

-- 5. push webhook for the outbox (no secret needed: dispatch is idempotent) -------
drop trigger if exists "activity-dispatch" on public.push_outbox;
create trigger "activity-dispatch" after insert on public.push_outbox
  for each row execute function supabase_functions.http_request(
    'https://eqwcndxdbfljsjxsduid.supabase.co/functions/v1/activity/dispatch',
    'POST', '{"Content-type":"application/json"}', '{}', '5000');

-- 6. cut over from the legacy pipeline ---------------------------------------------
-- order matters: drop the old webhook BEFORE touching rows, or the bulk update below
-- would fire a push for every legacy row.
drop trigger if exists "notifications-dispatch" on public.notifications;

create or replace function public.trg_legacy_notifications_read() returns trigger
language plpgsql as $$ begin NEW.read_at := coalesce(NEW.read_at, now()); return NEW; end $$;
drop trigger if exists legacy_notifications_born_read on public.notifications;
create trigger legacy_notifications_born_read before insert or update on public.notifications
  for each row execute function public.trg_legacy_notifications_read();
update public.notifications set read_at = now() where read_at is null;

-- 7. lock it down ---------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['activity_policy','push_outbox','user_activity_topics',
                           'activity_errors','activity_items','activity_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'activity\_%' or p.proname like 'trg\_activity\_%'
                   or p.proname = 'trg_legacy_notifications_read') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

commit;
