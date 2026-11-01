-- Anaija Moments · migration 01 · shared foundation
-- moments + typed child tables, entries, reactions, votes, war sides/items/answers, reminders, blocks, reports,
-- lifecycle tick (pg_cron), war scoring, notification policy.
-- Privacy rule: moments.creator_id and moment_entries.author_id are read server-side only and NEVER returned by any endpoint.
begin;

do $$ begin
  if to_regclass('public.communities') is null or to_regclass('public.community_members') is null
     or to_regclass('public.community_designations') is null or to_regclass('public.users') is null
     or to_regclass('public.activity_policy') is null
     or to_regprocedure('public.community_notify(bigint,bigint,text,text,text,bigint,jsonb,boolean)') is null then
    raise exception 'Moments preflight failed: run Communities migrations 01-03 and the activity inbox migrations first';
  end if;
end $$;

-- 1. community-level Moment permissions ----------------------------------------------------------------
-- per type: off | member | moderator | admin.  dept_war_official: representative | moderator | admin
alter table public.communities add column if not exists moment_settings jsonb not null default
  '{"hot_seat":"member","verdict":"member","one_question":"member","confession_drop":"member","dept_war":"member","dept_war_official":"representative"}'::jsonb;

-- 2. moments (shared lifecycle) --------------------------------------------------------------------------
-- status: draft (war awaiting acceptance) | scheduled | active | closed | completed | cancelled
--   hot_seat:        active -> closed (questions closed, host may still answer) -> completed
--   confession_drop: active (collecting) -> closed (awaiting / running reveal) -> completed
--   verdict, one_question, dept_war: active -> completed
create table if not exists public.moments (
  id bigint generated always as identity primary key,
  code text not null unique,
  community_id bigint not null references public.communities(id) on delete cascade,
  creator_id bigint not null references public.users(id),
  type text not null check (type in ('hot_seat','verdict','confession_drop','dept_war','one_question')),
  status text not null default 'active' check (status in ('draft','scheduled','active','closed','completed','cancelled')),
  title text not null check (char_length(title) between 1 and 200),
  body text check (body is null or char_length(body) <= 600),
  anonymous boolean not null default false,
  allow_anonymous_entries boolean not null default true,
  allow_preview boolean not null default true,
  is_official boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  ended_at timestamptz,
  ended_by bigint references public.users(id),
  cancel_reason text,
  soon_notified_at timestamptz,
  realtime_key uuid not null default gen_random_uuid(),
  participants_count int not null default 0,
  entries_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, type)
);
create index if not exists moments_community_idx on public.moments (community_id, id desc);
create index if not exists moments_status_idx on public.moments (community_id, status, id desc);
create index if not exists moments_tick_idx on public.moments (status, starts_at, ends_at) where status in ('draft','scheduled','active','closed');

-- 3. typed configuration (composite FK keeps each row tied to the right moment type) -----------------
create table if not exists public.moment_hot_seats (
  moment_id bigint primary key,
  type text not null default 'hot_seat' check (type = 'hot_seat'),
  submissions_closed_at timestamptz,
  answer_until timestamptz not null,
  foreign key (moment_id, type) references public.moments(id, type) on delete cascade
);

create table if not exists public.moment_confession_drops (
  moment_id bigint primary key,
  type text not null default 'confession_drop' check (type = 'confession_drop'),
  reveal_at timestamptz not null,
  reveal_mode text not null default 'sequential' check (reveal_mode in ('all','sequential','manual')),
  reveal_interval_secs int not null default 20 check (reveal_interval_secs between 5 and 3600),
  max_per_user int not null default 3 check (max_per_user between 1 and 10),
  reveal_notified_at timestamptz,
  foreign key (moment_id, type) references public.moments(id, type) on delete cascade
);

create table if not exists public.moment_options (
  moment_id bigint not null,
  type text not null default 'verdict' check (type = 'verdict'),
  idx smallint not null check (idx between 0 and 9),
  label text not null check (char_length(label) between 1 and 80),
  votes_count int not null default 0,
  primary key (moment_id, idx),
  foreign key (moment_id, type) references public.moments(id, type) on delete cascade
);

create table if not exists public.moment_votes (
  moment_id bigint not null,
  user_id bigint not null references public.users(id) on delete cascade,
  option_idx smallint not null,
  side_community_id bigint references public.communities(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (moment_id, user_id),            -- one vote per account, enforced by the database
  foreign key (moment_id, option_idx) references public.moment_options(moment_id, idx) on delete cascade
);

create table if not exists public.moment_war_config (
  moment_id bigint primary key,
  type text not null default 'dept_war' check (type = 'dept_war'),
  challenge_type text not null check (challenge_type in ('trivia','riddle','campus_knowledge','creative','voting')),
  points_per_item int not null default 10 check (points_per_item between 1 and 100),
  min_participants int not null default 3 check (min_participants between 1 and 50),
  invite_expires_at timestamptz,
  message text check (message is null or char_length(message) <= 300),
  winner_community_id bigint references public.communities(id),
  results jsonb,
  foreign key (moment_id, type) references public.moments(id, type) on delete cascade
);

create table if not exists public.moment_war_sides (
  moment_id bigint not null references public.moments(id) on delete cascade,
  community_id bigint not null references public.communities(id) on delete cascade,
  side text not null check (side in ('challenger','challenged')),
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  proposed_by bigint references public.users(id),
  decided_by bigint references public.users(id),
  decided_at timestamptz,
  primary key (moment_id, community_id)
);
create unique index if not exists moment_war_sides_one_per_role on public.moment_war_sides (moment_id, side);
create index if not exists moment_war_sides_community_idx on public.moment_war_sides (community_id, status);

-- correct answers live here and are never returned before the war completes
create table if not exists public.moment_war_items (
  id bigint generated always as identity primary key,
  moment_id bigint not null references public.moments(id) on delete cascade,
  idx smallint not null check (idx between 0 and 29),
  kind text not null check (kind in ('choice','text')),
  prompt text not null check (char_length(prompt) between 1 and 300),
  choices text[],
  correct_idx smallint,
  accepted text[],
  unique (moment_id, idx),
  check (
    (kind = 'choice' and choices is not null and coalesce(array_length(choices, 1), 0) between 2 and 6
       and correct_idx is not null and correct_idx between 0 and coalesce(array_length(choices, 1), 1) - 1)
    or (kind = 'text' and accepted is not null and coalesce(array_length(accepted, 1), 0) >= 1)
  )
);

create table if not exists public.moment_war_answers (
  item_id bigint not null references public.moment_war_items(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  community_id bigint not null references public.communities(id) on delete cascade,
  choice_idx smallint,
  answer_text text check (answer_text is null or char_length(answer_text) <= 120),
  correct boolean not null,
  created_at timestamptz not null default now(),
  primary key (item_id, user_id)               -- one answer per item per account
);
create index if not exists moment_war_answers_side_idx on public.moment_war_answers (community_id);

-- 4. participants, aliases, entries, reactions ------------------------------------------------------------
create table if not exists public.moment_participants (
  moment_id bigint not null references public.moments(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  side_community_id bigint references public.communities(id) on delete set null,
  joined_at timestamptz not null default now(),
  primary key (moment_id, user_id)
);
create index if not exists moment_participants_user_idx on public.moment_participants (user_id, moment_id);

create table if not exists public.moment_aliases (
  moment_id bigint not null references public.moments(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  alias_no int not null,
  created_at timestamptz not null default now(),
  primary key (moment_id, user_id),
  unique (moment_id, alias_no)
);

-- kinds: question (hot_seat) | comment (verdict, confession, war) | confession | response (one_question) | submission (war)
create table if not exists public.moment_entries (
  id bigint generated always as identity primary key,
  moment_id bigint not null references public.moments(id) on delete cascade,
  parent_id bigint references public.moment_entries(id) on delete cascade,
  kind text not null check (kind in ('question','comment','confession','response','submission')),
  author_id bigint not null references public.users(id) on delete cascade,   -- NEVER returned
  side_community_id bigint references public.communities(id) on delete set null,
  is_anonymous boolean not null default true,
  alias_no int,
  body text not null check (char_length(body) between 1 and 1500),
  answer text check (answer is null or char_length(answer) <= 1500),
  answered_at timestamptz,
  status text not null default 'visible'
    check (status in ('pending','visible','approved','answered','skipped','dismissed','rejected','removed')),
  flags text[] not null default '{}',
  reveal_at timestamptz,
  upvotes_count int not null default 0,
  reactions_count int not null default 0,
  replies_count int not null default 0,
  client_key text check (client_key is null or char_length(client_key) <= 64),
  moderated_by bigint references public.users(id),
  moderated_at timestamptz,
  moderation_note text,
  created_at timestamptz not null default now(),
  check (not is_anonymous or alias_no is not null)
);
create index if not exists moment_entries_feed_idx on public.moment_entries (moment_id, id desc)
  where parent_id is null and status in ('visible','approved','answered','skipped');
create index if not exists moment_entries_top_idx on public.moment_entries (moment_id, upvotes_count desc, id desc)
  where kind = 'question' and status = 'visible';
create index if not exists moment_entries_replies_idx on public.moment_entries (parent_id, id) where parent_id is not null;
create index if not exists moment_entries_rate_idx on public.moment_entries (moment_id, author_id, created_at desc);
create index if not exists moment_entries_queue_idx on public.moment_entries (moment_id, id) where status = 'pending';
create index if not exists moment_entries_reveal_idx on public.moment_entries (moment_id, reveal_at)
  where kind = 'confession' and status = 'approved';
create unique index if not exists moment_entries_idem on public.moment_entries (moment_id, author_id, client_key)
  where client_key is not null;

create table if not exists public.moment_reactions (
  entry_id bigint not null references public.moment_entries(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  kind text not null default 'like' check (kind in ('like','fire','laugh','wow','sad','upvote')),
  created_at timestamptz not null default now(),
  primary key (entry_id, user_id)
);

-- 5. reminders, blocks, reports ----------------------------------------------------------------------------
create table if not exists public.moment_reminders (
  moment_id bigint not null references public.moments(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (moment_id, user_id)
);

create table if not exists public.moment_blocks (
  moment_id bigint not null references public.moments(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  blocked_by bigint references public.users(id),
  reason text,
  created_at timestamptz not null default now(),
  primary key (moment_id, user_id)
);

create table if not exists public.moment_reports (
  id bigint generated always as identity primary key,
  moment_id bigint not null references public.moments(id) on delete cascade,
  entry_id bigint references public.moment_entries(id) on delete cascade,
  reporter_id bigint not null references public.users(id) on delete cascade,
  reason text not null check (reason in ('spam','harassment','hate','sexual','violence','misinformation','privacy','other')),
  details text check (details is null or char_length(details) <= 500),
  status text not null default 'open' check (status in ('open','actioned','dismissed')),
  handled_by bigint references public.users(id),
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists moment_reports_entry_uniq on public.moment_reports (reporter_id, entry_id) where entry_id is not null;
create unique index if not exists moment_reports_moment_uniq on public.moment_reports (reporter_id, moment_id) where entry_id is null;
create index if not exists moment_reports_queue_idx on public.moment_reports (moment_id, status, created_at desc);

-- 6. alias + participation --------------------------------------------------------------------------------------
create or replace function public.moment_alias(p_moment bigint, p_user bigint) returns int
language plpgsql security definer set search_path = public as $$
declare v int; n int := 0;
begin
  select alias_no into v from moment_aliases where moment_id = p_moment and user_id = p_user;
  if found then return v; end if;
  perform pg_advisory_xact_lock(hashtextextended('moment_alias|' || p_moment::text, 0));
  select alias_no into v from moment_aliases where moment_id = p_moment and user_id = p_user;
  if found then return v; end if;
  loop
    v := 1000 + floor(random() * 99000)::int;
    begin
      insert into moment_aliases (moment_id, user_id, alias_no) values (p_moment, p_user, v);
      exit;
    exception when unique_violation then
      n := n + 1;
      if n > 30 then raise exception 'alias space exhausted'; end if;
    end;
  end loop;
  return v;
end $$;

create or replace function public.moment_touch(p_moment bigint, p_user bigint, p_side bigint default null) returns void
language sql security definer set search_path = public as $$
  insert into moment_participants (moment_id, user_id, side_community_id) values (p_moment, p_user, p_side)
  on conflict (moment_id, user_id) do nothing
$$;

-- 7. counters + guards ---------------------------------------------------------------------------------------------
create or replace function public.trg_moment_participant_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update moments set participants_count = participants_count + 1 where id = NEW.moment_id;
  return null;
end $$;
drop trigger if exists moment_participant_count on public.moment_participants;
create trigger moment_participant_count after insert on public.moment_participants
  for each row execute function public.trg_moment_participant_count();

create or replace function public.trg_moment_entry_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare t text; p record;
begin
  select type into t from moments where id = NEW.moment_id;
  if t is null then raise exception 'moment not found'; end if;
  if not ((t = 'hot_seat' and NEW.kind = 'question')
       or (t = 'verdict' and NEW.kind = 'comment')
       or (t = 'confession_drop' and NEW.kind in ('confession', 'comment'))
       or (t = 'one_question' and NEW.kind = 'response')
       or (t = 'dept_war' and NEW.kind in ('submission', 'comment'))) then
    raise exception 'entry kind % is not allowed in a % moment', NEW.kind, t;
  end if;
  if NEW.parent_id is not null then
    select moment_id, parent_id, kind into p from moment_entries where id = NEW.parent_id;
    if not found or p.moment_id <> NEW.moment_id or p.parent_id is not null then raise exception 'invalid parent'; end if;
    if NEW.kind <> 'comment' then raise exception 'only comments can be replies'; end if;
  elsif t = 'confession_drop' and NEW.kind = 'comment' then
    raise exception 'confession comments must reply to a confession';
  end if;
  return NEW;
end $$;
drop trigger if exists moment_entry_guard on public.moment_entries;
create trigger moment_entry_guard before insert on public.moment_entries
  for each row execute function public.trg_moment_entry_guard();

create or replace function public.trg_moment_entry_counts() returns trigger
language plpgsql security definer set search_path = public as $$
declare was boolean; is_ boolean;
begin
  if TG_OP = 'INSERT' then
    if NEW.parent_id is null and NEW.status in ('visible','approved','answered','skipped') then
      update moments set entries_count = entries_count + 1 where id = NEW.moment_id;
    elsif NEW.parent_id is not null and NEW.status = 'visible' then
      update moment_entries set replies_count = replies_count + 1 where id = NEW.parent_id;
    end if;
  elsif TG_OP = 'UPDATE' then
    if NEW.parent_id is null then
      was := OLD.status in ('visible','approved','answered','skipped');
      is_ := NEW.status in ('visible','approved','answered','skipped');
      if was <> is_ then
        update moments set entries_count = greatest(0, entries_count + case when is_ then 1 else -1 end) where id = NEW.moment_id;
      end if;
    elsif (OLD.status = 'visible') <> (NEW.status = 'visible') then
      update moment_entries set replies_count = greatest(0, replies_count + case when NEW.status = 'visible' then 1 else -1 end)
       where id = NEW.parent_id;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists moment_entry_counts on public.moment_entries;
create trigger moment_entry_counts after insert or update of status on public.moment_entries
  for each row execute function public.trg_moment_entry_counts();

create or replace function public.trg_moment_reaction_counts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.kind = 'upvote' then update moment_entries set upvotes_count = upvotes_count + 1 where id = NEW.entry_id;
    else update moment_entries set reactions_count = reactions_count + 1 where id = NEW.entry_id; end if;
  elsif TG_OP = 'DELETE' then
    if OLD.kind = 'upvote' then update moment_entries set upvotes_count = greatest(0, upvotes_count - 1) where id = OLD.entry_id;
    else update moment_entries set reactions_count = greatest(0, reactions_count - 1) where id = OLD.entry_id; end if;
  end if;
  return null;
end $$;
drop trigger if exists moment_reaction_counts on public.moment_reactions;
create trigger moment_reaction_counts after insert or delete on public.moment_reactions
  for each row execute function public.trg_moment_reaction_counts();

create or replace function public.trg_moment_vote_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update moment_options set votes_count = votes_count + 1 where moment_id = NEW.moment_id and idx = NEW.option_idx;
  return null;
end $$;
drop trigger if exists moment_vote_count on public.moment_votes;
create trigger moment_vote_count after insert on public.moment_votes
  for each row execute function public.trg_moment_vote_count();

-- 8. Department Wars scoring ----------------------------------------------------------------------------------------
-- trivia / riddle / campus_knowledge: correct answers x points / participants of that side.
-- creative / voting: upvotes on the side's submissions / participants of that side (API only lets the OTHER side vote).
create or replace function public.moment_war_standings(p_moment bigint)
returns table (cid bigint, n_participants int, raw_points int, score numeric, eligible boolean)
language plpgsql stable security definer set search_path = public as $$
declare cfg record;
begin
  select challenge_type, points_per_item, min_participants into cfg from moment_war_config where moment_id = p_moment;
  if not found then return; end if;
  if cfg.challenge_type in ('trivia', 'riddle', 'campus_knowledge') then
    return query
      with parts as (
        select p.side_community_id as side, count(*)::int as cnt
          from moment_participants p where p.moment_id = p_moment and p.side_community_id is not null group by 1),
      got as (
        select a.community_id as side, (count(*) filter (where a.correct))::int as hits
          from moment_war_answers a join moment_war_items i on i.id = a.item_id
         where i.moment_id = p_moment group by 1)
      select s.community_id, coalesce(parts.cnt, 0), coalesce(got.hits, 0),
             round(case when coalesce(parts.cnt, 0) = 0 then 0
                        else coalesce(got.hits, 0)::numeric * cfg.points_per_item / parts.cnt end, 2),
             coalesce(parts.cnt, 0) >= cfg.min_participants
        from moment_war_sides s
        left join parts on parts.side = s.community_id
        left join got on got.side = s.community_id
       where s.moment_id = p_moment and s.status = 'accepted';
  else
    return query
      with parts as (
        select p.side_community_id as side, count(*)::int as cnt
          from moment_participants p where p.moment_id = p_moment and p.side_community_id is not null group by 1),
      got as (
        select e.side_community_id as side, coalesce(sum(e.upvotes_count), 0)::int as hits
          from moment_entries e
         where e.moment_id = p_moment and e.kind = 'submission' and e.status = 'visible' group by 1)
      select s.community_id, coalesce(parts.cnt, 0), coalesce(got.hits, 0),
             round(coalesce(got.hits, 0)::numeric / greatest(coalesce(parts.cnt, 0), 1), 2),
             coalesce(parts.cnt, 0) >= cfg.min_participants
        from moment_war_sides s
        left join parts on parts.side = s.community_id
        left join got on got.side = s.community_id
       where s.moment_id = p_moment and s.status = 'accepted';
  end if;
end $$;

-- snapshot the result; a tie on score AND participants is a draw (no winner)
create or replace function public.moment_war_finalise(p_moment bigint) returns void
language plpgsql security definer set search_path = public as $$
declare snap jsonb; win bigint;
begin
  select coalesce(jsonb_agg(jsonb_build_object('community_id', s.cid, 'participants', s.n_participants,
           'raw', s.raw_points, 'score', s.score, 'eligible', s.eligible) order by s.score desc, s.n_participants desc), '[]'::jsonb)
    into snap from moment_war_standings(p_moment) s;
  with r as (
    select s.cid, s.score, s.n_participants,
           row_number() over (order by s.score desc, s.n_participants desc) as rn
      from moment_war_standings(p_moment) s where s.eligible)
  select case when exists (select 1 from r a join r b on b.rn = 2
                            where a.rn = 1 and a.score = b.score and a.n_participants = b.n_participants)
              then null else (select r.cid from r where r.rn = 1) end
    into win;
  update moment_war_config set results = snap, winner_community_id = win where moment_id = p_moment;
end $$;

-- 9. notifications (ride the activity inbox + push outbox; participants and reminder subscribers only) ----------
insert into public.activity_policy (kind, merge, window_secs, max_life_secs, restore_secs, push_mode, push_cooldown_secs) values
  ('moment_live',      false, 0, 0, 0, 'each', 0),
  ('moment_soon',      false, 0, 0, 0, 'each', 0),
  ('moment_reveal',    false, 0, 0, 0, 'each', 0),
  ('moment_ended',     false, 0, 0, 0, 'each', 0),
  ('moment_answer',    false, 0, 0, 0, 'each', 0),
  ('moment_challenge', false, 0, 0, 0, 'each', 0),
  ('moment_mod',       false, 0, 0, 0, 'each', 0)
on conflict (kind) do nothing;

-- never carries the creator: actor is always null, so an anonymous host cannot leak through a notification
create or replace function public.moments_notify(p_moment bigint, p_kind text, p_recipients bigint[]) returns void
language plpgsql security definer set search_path = public as $$
declare m record; r bigint;
begin
  select mo.id, mo.code, mo.type, mo.title, mo.community_id, c.name as cname, c.slug as cslug
    into m from moments mo join communities c on c.id = mo.community_id where mo.id = p_moment;
  if not found then return; end if;
  foreach r in array coalesce(p_recipients, '{}'::bigint[]) loop
    begin
      perform community_notify(r, null, p_kind, p_kind || ':' || m.id || ':' || r, p_kind || ':' || m.id || ':' || r,
        m.community_id,
        jsonb_build_object('community', m.cname, 'slug', m.cslug, 'code', m.code, 'type', m.type, 'title', m.title), true);
    exception when others then
      raise notice 'moments_notify failed for %: %', r, sqlerrm;
    end;
  end loop;
end $$;

-- 10. lifecycle tick (the API also settles lazily on read, so this only has to be roughly on time) -------------------
create or replace function public.moments_tick() returns void
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  -- "starting soon" -> reminder subscribers only
  for m in update moments set soon_notified_at = now()
            where status = 'scheduled' and starts_at is not null and starts_at > now()
              and starts_at <= now() + interval '15 minutes' and soon_notified_at is null
        returning id loop
    perform moments_notify(m.id, 'moment_soon', array(select user_id from moment_reminders where moment_id = m.id limit 500));
  end loop;

  -- scheduled -> active
  for m in update moments set status = 'active', updated_at = now()
            where status = 'scheduled' and starts_at is not null and starts_at <= now()
              and (ends_at is null or ends_at > now())
        returning id loop
    perform moments_notify(m.id, 'moment_live', array(select user_id from moment_reminders where moment_id = m.id limit 500));
  end loop;

  -- a scheduled moment whose window passed without ever going live
  update moments set status = 'completed', ended_at = coalesce(ended_at, ends_at), updated_at = now()
   where status = 'scheduled' and ends_at is not null and ends_at <= now();

  -- hot seat + confession drop: collecting phase ends
  update moments set status = 'closed', updated_at = now()
   where status = 'active' and type in ('hot_seat', 'confession_drop') and ends_at is not null and ends_at <= now();

  -- verdict / one question / war: end of the window completes them
  for m in update moments set status = 'completed', ended_at = coalesce(ended_at, ends_at, now()), updated_at = now()
            where status = 'active' and type in ('verdict', 'one_question', 'dept_war')
              and ends_at is not null and ends_at <= now()
        returning id, type loop
    if m.type = 'dept_war' then perform moment_war_finalise(m.id); end if;
    perform moments_notify(m.id, 'moment_ended', array(select user_id from moment_participants where moment_id = m.id limit 500));
  end loop;

  -- hot seat: answering window over
  for m in update moments mo set status = 'completed', ended_at = coalesce(mo.ended_at, now()), updated_at = now()
             from moment_hot_seats h
            where h.moment_id = mo.id and mo.status = 'closed' and mo.type = 'hot_seat' and h.answer_until <= now()
        returning mo.id loop
    perform moments_notify(m.id, 'moment_ended', array(select user_id from moment_participants where moment_id = m.id limit 500));
  end loop;

  -- unanswered war invitations expire
  update moments mo set status = 'cancelled', cancel_reason = 'The challenge expired.', updated_at = now()
    from moment_war_config w
   where w.moment_id = mo.id and mo.status = 'draft' and mo.type = 'dept_war'
     and w.invite_expires_at is not null and w.invite_expires_at <= now();

  -- confession drops: schedule reveals, notify, complete
  for m in select mo.id, d.reveal_at, d.reveal_mode, d.reveal_interval_secs, d.reveal_notified_at
             from moments mo join moment_confession_drops d on d.moment_id = mo.id
            where mo.type = 'confession_drop' and mo.status = 'closed' and d.reveal_at <= now() loop
    if m.reveal_mode <> 'manual' then
      with ord as (
        select e.id, row_number() over (order by random()) as rn
          from moment_entries e
         where e.moment_id = m.id and e.kind = 'confession' and e.status = 'approved' and e.reveal_at is null)
      update moment_entries e
         set reveal_at = greatest(m.reveal_at, now()) +
             case when m.reveal_mode = 'sequential'
                  then make_interval(secs => ((ord.rn - 1) * m.reveal_interval_secs)::double precision)
                  else interval '0' end
        from ord where e.id = ord.id;
    end if;
    if m.reveal_notified_at is null then
      update moment_confession_drops set reveal_notified_at = now() where moment_id = m.id;
      perform moments_notify(m.id, 'moment_reveal', array(
        select u.user_id from (
          select user_id from moment_participants where moment_id = m.id
          union select user_id from moment_reminders where moment_id = m.id) u limit 500));
    end if;
    update moments set status = 'completed', ended_at = now(), updated_at = now()
     where id = m.id
       and not exists (select 1 from moment_entries e where e.moment_id = m.id and e.kind = 'confession'
                        and e.status = 'approved' and (e.reveal_at is null or e.reveal_at > now()))
       and (m.reveal_at + interval '24 hours' <= now()
            or not exists (select 1 from moment_entries e where e.moment_id = m.id and e.kind = 'confession' and e.status = 'pending'));
    if found then
      perform moments_notify(m.id, 'moment_ended', array(select user_id from moment_participants where moment_id = m.id limit 500));
    end if;
  end loop;
end $$;

do $$ begin
  perform cron.schedule('moments-tick', '* * * * *', $c$ select public.moments_tick(); $c$);
exception when others then
  raise notice 'pg_cron not available, Moments rely on lazy evaluation: %', sqlerrm;
end $$;

-- 11. lock down ------------------------------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['moments','moment_hot_seats','moment_confession_drops','moment_options','moment_votes',
      'moment_war_config','moment_war_sides','moment_war_items','moment_war_answers','moment_participants',
      'moment_aliases','moment_entries','moment_reactions','moment_reminders','moment_blocks','moment_reports'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to service_role;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'moment\_%' or p.proname like 'moments\_%' or p.proname like 'trg\_moment\_%') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

commit;
