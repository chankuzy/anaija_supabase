alter table public.posts add column if not exists client_request_id uuid;
create unique index if not exists posts_user_client_request_uidx
  on public.posts (user_id, client_request_id)
  where client_request_id is not null;
