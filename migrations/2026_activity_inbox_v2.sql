-- Anaija activity inbox v2: actor-based like merging + live pings for message unread changes.
begin;

create or replace function public.activity_notify(p_user bigint, p_kind text default 'sync')
returns void language plpgsql security definer set search_path = public as $$
declare v_topic uuid;
begin
  select topic into v_topic from user_activity_topics where user_id = p_user;
  if v_topic is not null then
    perform realtime.send(jsonb_build_object('kind', p_kind), 'activity_changed', 'activity:' || v_topic::text, false);
  end if;
exception when others then null;
end $$;

-- Picks the group a like belongs to: the post's own item, else this actor's multi-post
-- item, else promotes this actor's single-post item into a multi-post one, else a new post item.
create or replace function public.activity_like_group(
  p_recipient bigint, p_actor bigint, p_post bigint, p_now timestamptz default now()
) returns text language plpgsql security definer set search_path = public as $$
declare pol activity_policy%rowtype; it activity_items%rowtype;
        v_key text := 'like:' || p_post; v_by text := 'likeby:' || p_actor;
begin
  select * into pol from activity_policy where kind = 'like';
  perform pg_advisory_xact_lock(hashtextextended('likes|' || p_recipient::text, 0));

  if exists (select 1 from activity_items
              where recipient_id = p_recipient and group_key = v_key
                and closed_at is null and retracted_at is null and read_at is null and dismissed_at is null
                and p_now - last_event_at <= make_interval(secs => pol.window_secs)
                and p_now - first_event_at <= make_interval(secs => pol.max_life_secs)) then
    return v_key;
  end if;

  if exists (select 1 from activity_items
              where recipient_id = p_recipient and group_key = v_by
                and closed_at is null and retracted_at is null and read_at is null and dismissed_at is null
                and p_now - last_event_at <= make_interval(secs => pol.window_secs)
                and p_now - first_event_at <= make_interval(secs => pol.max_life_secs)) then
    return v_by;
  end if;

  select * into it from activity_items
   where recipient_id = p_recipient and kind = 'like' and group_key like 'like:%'
     and actor_count = 1 and actors_preview[1] = p_actor and content_id <> p_post
     and closed_at is null and retracted_at is null and read_at is null and dismissed_at is null
     and p_now - last_event_at <= make_interval(secs => pol.window_secs)
     and p_now - first_event_at <= make_interval(secs => pol.max_life_secs)
   order by last_event_at desc limit 1
   for update;
  if found then
    update activity_items set closed_at = p_now
     where recipient_id = p_recipient and group_key = v_by and closed_at is null;
    update activity_items set group_key = v_by where id = it.id;
    return v_by;
  end if;

  return v_key;
end $$;

create or replace function public.trg_activity_like() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record; v_kind text; v_tk text; v_cnt int; v_group text; v_item bigint;
begin
  begin
    if TG_OP = 'INSERT' then
      select user_id, type, is_active, expires_at into p from posts where id = NEW.post_id;
      if p.user_id is null or p.is_active is not true then return null; end if;
      v_kind := case when p.type = 'story' then 'story_like' else 'like' end;
      v_tk := case p.type when 'story' then 'story' when 'listing' then 'listing' else 'post' end;

      if v_kind = 'like' and p.user_id <> NEW.user_id then
        v_group := activity_like_group(p.user_id, NEW.user_id, NEW.post_id);
      else
        v_group := v_kind || ':' || NEW.post_id;
      end if;

      v_item := activity_record(
        p_recipient => p.user_id, p_actor => NEW.user_id, p_kind => v_kind,
        p_group_key => v_group,
        p_dedupe => 'like:' || NEW.user_id || ':' || NEW.post_id,
        p_target_kind => v_tk, p_target_id => NEW.post_id, p_content_id => NEW.post_id,
        p_expires => p.expires_at);

      if v_item is not null and v_group like 'likeby:%' then
        update activity_items set content_id = NEW.post_id, target_id = NEW.post_id where id = v_item;
      end if;

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

-- Message rows are derived from conversation_participants.unread_count (messaging stays the
-- source of truth). Any change to it pings the owner's inbox so the row appears/disappears live.
create or replace function public.trg_activity_unread_ping() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    if NEW.unread_count is distinct from OLD.unread_count then
      perform activity_notify(NEW.user_id, 'message');
    end if;
  exception when others then null;
  end;
  return null;
end $$;

drop trigger if exists activity_on_unread on public.conversation_participants;
create trigger activity_on_unread after update of unread_count on public.conversation_participants
  for each row execute function public.trg_activity_unread_ping();

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'activity\_%' or p.proname like 'trg\_activity\_%') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

commit;
