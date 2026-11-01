-- Anaija Platform · migration 02 · Content Studio
begin;

do $$ begin
  if to_regclass('public.platform_accounts') is null or to_regclass('public.posts') is null then
    raise exception 'Platform preflight failed: run migration 01 first';
  end if;
end $$;

create table if not exists public.platform_content (
  id bigint generated always as identity primary key,
  account_user_id bigint not null references public.platform_accounts(user_id),
  status text not null default 'draft' check (status in ('draft','scheduled','publishing','published','archived')),
  payload jsonb not null default '{}'::jsonb,           -- createPost() input shape
  request_id uuid not null default gen_random_uuid(),   -- becomes posts.client_request_id: retries never duplicate
  scheduled_at timestamptz,
  post_id bigint references public.posts(id),
  published_at timestamptz,
  published_by bigint references public.users(id),      -- null = the scheduler
  created_by bigint not null references public.users(id),
  updated_by bigint references public.users(id),
  attempts int not null default 0,
  last_error text,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_content_sched_chk check (status <> 'scheduled' or scheduled_at is not null)
);
create index if not exists platform_content_acct_idx on public.platform_content (account_user_id, status, id desc);
create index if not exists platform_content_due_idx on public.platform_content (scheduled_at) where status = 'scheduled';
create index if not exists platform_content_post_idx on public.platform_content (post_id) where post_id is not null;

-- Atomic claim for the publisher: due scheduled items, plus items stuck in 'publishing' for 5+ minutes.
create or replace function public.platform_content_claim_due(p_limit int default 10)
returns setof public.platform_content
language sql security definer set search_path = public as $$
  update public.platform_content c
     set status = 'publishing', claimed_at = now(), updated_at = now()
   where c.id in (
     select id from public.platform_content
      where (status = 'scheduled' and scheduled_at <= now())
         or (status = 'publishing' and claimed_at < now() - interval '5 minutes')
      order by id
      limit greatest(1, least(p_limit, 25))
      for update skip locked)
  returning c.*;
$$;

alter table public.platform_content enable row level security;
revoke all on public.platform_content from anon, authenticated;
grant select, insert, update, delete on public.platform_content to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on function public.platform_content_claim_due(int) from public, anon, authenticated;
grant execute on function public.platform_content_claim_due(int) to service_role;

commit;
