-- Anaija Platform · migration 01 · official accounts, staff RBAC, audit, platform-owned communities
-- Nothing is activated here: provisioning functions create inactive, hidden identities.
begin;

do $$ begin
  if to_regclass('public.users') is null or to_regclass('public.communities') is null
     or to_regprocedure('public.community_create(bigint,jsonb)') is null then
    raise exception 'Platform preflight failed: base tables or community_create are missing';
  end if;
end $$;

-- 1. users: account type + 'platform' provider ---------------------------------------------
alter table public.users add column if not exists account_type text not null default 'person';
do $$ declare c record; begin
  if not exists (select 1 from pg_constraint where conname = 'users_account_type_chk') then
    alter table public.users add constraint users_account_type_chk check (account_type in ('person','official'));
  end if;
  for c in select conname from pg_constraint
            where conrelid = 'public.users'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%provider%' loop
    execute format('alter table public.users drop constraint %I', c.conname);
  end loop;
  alter table public.users add constraint users_provider_chk
    check (provider::text in ('phone','google','facebook','platform'));
end $$;
create index if not exists users_official_idx on public.users (id) where account_type = 'official';

-- 2. reserved usernames (people can never claim brand or authority handles) -------------------
create table if not exists public.reserved_usernames (name text primary key check (name = lower(name)));
insert into public.reserved_usernames (name) values
  ('admin'),('administrator'),('support'),('help'),('official'),('staff'),('team'),('security'),
  ('moderator'),('mod'),('root'),('system'),('news'),('updates'),('campus'),('business')
on conflict do nothing;

create or replace function public.trg_users_reserved_username() returns trigger
language plpgsql as $$
begin
  if NEW.username is null or NEW.account_type <> 'person' then return NEW; end if;
  if TG_OP = 'UPDATE' and NEW.username is not distinct from OLD.username then return NEW; end if;
  if lower(NEW.username) ~ '^anaija'
     or exists (select 1 from public.reserved_usernames r where r.name = lower(NEW.username)) then
    raise exception 'username_reserved' using errcode = '23514';
  end if;
  return NEW;
end $$;
drop trigger if exists users_reserved_username on public.users;
create trigger users_reserved_username before insert or update of username, account_type on public.users
  for each row execute function public.trg_users_reserved_username();

-- 3. staff, account admins, audit --------------------------------------------------------------
create table if not exists public.platform_staff (
  user_id bigint primary key references public.users(id),
  role text not null check (role in ('super_admin','comms_admin','editor','moderator','analyst')),
  granted_by bigint references public.users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.platform_accounts (
  user_id bigint primary key references public.users(id),
  account_key text not null unique check (account_key ~ '^[a-z0-9_]{2,30}$'),
  status text not null default 'provisioned' check (status in ('provisioned','active','suspended')),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  suspended_at timestamptz
);

create table if not exists public.platform_account_admins (
  account_user_id bigint not null references public.platform_accounts(user_id),
  staff_user_id bigint not null references public.platform_staff(user_id),
  can_publish boolean not null default true,
  can_manage boolean not null default false,
  granted_by bigint references public.users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (account_user_id, staff_user_id)
);

create table if not exists public.platform_audit_log (
  id bigint generated always as identity primary key,
  actor_id bigint references public.users(id),
  action text not null,
  target_kind text,
  target_id bigint,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists platform_audit_idx on public.platform_audit_log (created_at desc, id desc);
create index if not exists platform_audit_target_idx on public.platform_audit_log (target_kind, target_id);

create or replace function public.trg_platform_audit_immutable() returns trigger
language plpgsql as $$ begin raise exception 'platform_audit_log is append-only'; end $$;
drop trigger if exists platform_audit_immutable on public.platform_audit_log;
create trigger platform_audit_immutable before update or delete on public.platform_audit_log
  for each row execute function public.trg_platform_audit_immutable();

-- 4. platform-owned communities ------------------------------------------------------------------
alter table public.communities
  add column if not exists is_platform_owned boolean not null default false,
  add column if not exists platform_key text;
create unique index if not exists communities_platform_key_uniq on public.communities (platform_key) where platform_key is not null;

-- 5. provisioning (service-role only; run deliberately) -----------------------------------------------
create or replace function public.platform_provision_account(
  p_key text, p_username text, p_name text, p_bio text default null, p_adopt bigint default null, p_actor bigint default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if p_key !~ '^[a-z0-9_]{2,30}$' then raise exception 'bad account key'; end if;
  if exists (select 1 from platform_accounts where account_key = p_key) then raise exception 'account already provisioned'; end if;
  if p_adopt is not null then
    update users set account_type = 'official', provider = 'platform', provider_id = null,
           phone = null, email = null, password = null, phone_verified_at = null, email_verified_at = null,
           username = p_username, name = p_name, bio = coalesce(p_bio, bio),
           is_active = false, profile_completed = true, updated_at = now()
     where id = p_adopt returning id into v;
    if v is null then raise exception 'user % not found', p_adopt; end if;
    delete from personal_access_tokens where tokenable_id = v and tokenable_type = 'App\Models\User';
    delete from user_devices where user_id = v;
  else
    insert into users (name, username, bio, provider, account_type, is_active, profile_completed, created_at, updated_at)
    values (p_name, p_username, p_bio, 'platform', 'official', false, true, now(), now())
    returning id into v;
  end if;
  insert into platform_accounts (user_id, account_key) values (v, p_key);
  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (p_actor, 'account.provision', 'user', v, jsonb_build_object('key', p_key, 'adopted', p_adopt is not null));
  return v;
end $$;

create or replace function public.platform_set_account_status(p_key text, p_status text, p_actor bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if p_status not in ('provisioned','active','suspended') then raise exception 'bad status'; end if;
  update platform_accounts set status = p_status,
         activated_at = case when p_status = 'active' then coalesce(activated_at, now()) else activated_at end,
         suspended_at = case when p_status = 'suspended' then now() else null end
   where account_key = p_key returning user_id into v;
  if v is null then raise exception 'unknown account %', p_key; end if;
  update users set is_active = (p_status = 'active'), updated_at = now() where id = v;
  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (p_actor, 'account.status', 'user', v, jsonb_build_object('key', p_key, 'status', p_status));
end $$;

create or replace function public.platform_provision_community(p_key text, p_preset text, p_owner_key text, p_actor bigint default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint; o bigint; cfg jsonb;
begin
  select user_id into o from platform_accounts where account_key = p_owner_key;
  if o is null then raise exception 'unknown owner account %', p_owner_key; end if;
  if exists (select 1 from communities where platform_key = p_key) then raise exception 'community already provisioned'; end if;
  cfg := case p_preset
    when 'hq' then jsonb_build_object('name','Anaija HQ','slug','anaija-hq',
      'description','Official announcements, product news and service notices from Anaija.',
      'join_policy','open','read_policy','public_preview',
      'permissions','{"post":"admin","chat":"admin","invite":"admin","session":"admin","announce":"admin","library":"admin"}'::jsonb)
    when 'commons' then jsonb_build_object('name','Anaija Commons','slug','anaija-commons',
      'description','Talk with the Anaija team and each other: ideas, feedback, showcases and polls.',
      'join_policy','open','read_policy','public_preview')
    when 'academy' then jsonb_build_object('name','Anaija Academy','slug','anaija-academy',
      'description','Guides, creator education, marketplace tips and digital safety.',
      'join_policy','open','read_policy','public_preview',
      'permissions','{"post":"admin","chat":"member","invite":"admin","session":"admin","announce":"admin","library":"admin"}'::jsonb)
    else null end;
  if cfg is null then raise exception 'unknown preset %', p_preset; end if;
  v := community_create(o, cfg || '{"category":"other","discoverability":"unlisted"}'::jsonb);
  update communities set is_platform_owned = true, platform_key = p_key where id = v;
  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (p_actor, 'community.provision', 'community', v, jsonb_build_object('key', p_key, 'preset', p_preset));
  return v;
end $$;

create or replace function public.platform_set_community_listing(p_key text, p_listed boolean, p_actor bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  update communities set discoverability = case when p_listed then 'listed' else 'unlisted' end, updated_at = now()
   where platform_key = p_key returning id into v;
  if v is null then raise exception 'unknown community %', p_key; end if;
  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (p_actor, 'community.listing', 'community', v, jsonb_build_object('key', p_key, 'listed', p_listed));
end $$;

-- 6. lock down ----------------------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['reserved_usernames','platform_staff','platform_accounts','platform_account_admins','platform_audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to service_role;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'platform\_%' or p.proname like 'trg\_platform\_%' or p.proname = 'trg_users_reserved_username') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

commit;
