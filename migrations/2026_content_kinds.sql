-- Structured kinds: poll, document, article (publication), announcement.
-- Ordinary posts (type='post') told apart by posts.subtype; payload lives in posts.content.
begin;

alter table public.posts add column if not exists content jsonb;
create index if not exists posts_structured_subtype_idx
  on public.posts (subtype, created_at desc) where content is not null;

create table if not exists public.poll_votes (
  post_id    bigint not null references public.posts(id) on delete cascade,
  user_id    bigint not null references public.users(id) on delete cascade,
  option_id  smallint not null check (option_id >= 0),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, option_id)
);
create index if not exists poll_votes_user_idx on public.poll_votes (user_id, post_id);

-- Who may publish announcements, and under which identity. Granted by an admin (SQL), never by the client.
create table if not exists public.publisher_grants (
  id             bigserial primary key,
  user_id        bigint not null references public.users(id) on delete cascade,
  display_name   text not null,
  publisher_type text not null default 'organisation'
                 check (publisher_type in ('institution','department','organisation','staff')),
  institution_id bigint references public.institutions(id),
  can_announce   boolean not null default true,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists publisher_grants_user_idx
  on public.publisher_grants (user_id) where can_announce and revoked_at is null;

alter table public.poll_votes enable row level security;
alter table public.publisher_grants enable row level security;

create or replace function public.poll_tally(p_posts bigint[])
returns table (post_id bigint, option_id smallint, votes bigint)
language sql stable as $$
  select v.post_id, v.option_id, count(*)::bigint
    from public.poll_votes v
   where v.post_id = any(p_posts)
   group by v.post_id, v.option_id
$$;
revoke all on function public.poll_tally(bigint[]) from public, anon, authenticated;
grant execute on function public.poll_tally(bigint[]) to service_role;

commit;
