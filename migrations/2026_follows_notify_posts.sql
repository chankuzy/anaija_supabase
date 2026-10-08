alter table public.follows
  add column if not exists notify_posts boolean not null default false;

create index if not exists follows_notify_idx
  on public.follows (following_id) where notify_posts;
