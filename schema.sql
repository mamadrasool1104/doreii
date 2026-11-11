-- =====================================================================
-- Family Maintenance Tracker - Supabase PostgreSQL initialization
-- Run once in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------

-- One row per authorized family member. Only people listed here can
-- read or write anything. Rows are created by the trigger below, never
-- directly by the browser.
create table if not exists public.family_members (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  email        text not null,
  display_name text,
  role         text not null default 'member' check (role in ('admin', 'member')),
  created_at   timestamptz not null default now()
);

-- Pending invitations (email addresses that are allowed to join).
create table if not exists public.family_invites (
  email      text primary key check (email = lower(email)),
  role       text not null default 'member' check (role in ('admin', 'member')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- The shared maintenance log.
create table if not exists public.maintenance_records (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (char_length(title) between 1 and 200),
  asset        text check (char_length(asset) <= 200),          -- e.g. "Toyota Corolla", "Boiler"
  category     text not null default 'general'
               check (category in ('general','home','vehicle','appliance','garden','electrical','plumbing','hvac','other')),
  description  text check (char_length(description) <= 5000),
  status       text not null default 'planned'
               check (status in ('planned','in_progress','completed','cancelled')),
  priority     text not null default 'medium'
               check (priority in ('low','medium','high','urgent')),
  due_date     date,
  completed_on date,
  cost         numeric(12,2) check (cost is null or cost >= 0),
  performed_by text check (char_length(performed_by) <= 200),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists maintenance_records_created_idx on public.maintenance_records (created_at desc);
create index if not exists maintenance_records_status_idx  on public.maintenance_records (status);
create index if not exists maintenance_records_due_idx     on public.maintenance_records (due_date);

-- ---------------------------------------------------------------------
-- 2. HELPER FUNCTIONS (SECURITY DEFINER so RLS policies can use them)
-- ---------------------------------------------------------------------

create or replace function public.is_family_member()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.family_members where user_id = auth.uid());
$$;

create or replace function public.is_family_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.family_members
                 where user_id = auth.uid() and role = 'admin');
$$;

revoke all on function public.is_family_member() from public, anon;
revoke all on function public.is_family_admin()  from public, anon;
grant execute on function public.is_family_member() to authenticated;
grant execute on function public.is_family_admin()  to authenticated;

-- ---------------------------------------------------------------------
-- 3. TRIGGERS
-- ---------------------------------------------------------------------

-- 3a. Membership: when an auth user has a CONFIRMED email:
--     * if the email was invited  -> becomes a member (role from invite)
--     * if nobody is a member yet -> becomes the first admin
--     * otherwise                 -> no access (RLS blocks everything)
create or replace function public.handle_auth_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  inv   public.family_invites%rowtype;
  v_name text;
begin
  if new.email is null or new.email_confirmed_at is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(424242);  -- serialize first-admin race

  if exists (select 1 from public.family_members where user_id = new.id) then
    return new;
  end if;

  v_name := coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''),
                     split_part(new.email, '@', 1));

  select * into inv from public.family_invites where email = lower(new.email);

  if found then
    insert into public.family_members (user_id, email, display_name, role)
    values (new.id, lower(new.email), v_name, inv.role);
    delete from public.family_invites where email = inv.email;
  elsif not exists (select 1 from public.family_members) then
    insert into public.family_members (user_id, email, display_name, role)
    values (new.id, lower(new.email), v_name, 'admin');
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.handle_auth_user();

-- 3b. Never leave the family without an admin.
create or replace function public.protect_last_admin()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if old.role = 'admin'
     and (tg_op = 'DELETE' or new.role <> 'admin')
     and not exists (select 1 from public.family_members
                     where role = 'admin' and user_id <> old.user_id) then
    raise exception 'The family must keep at least one admin.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists protect_last_admin_trg on public.family_members;
create trigger protect_last_admin_trg
  before update of role or delete on public.family_members
  for each row execute function public.protect_last_admin();

-- 3c. Keep audit columns honest (clients cannot spoof them).
create or replace function public.touch_record()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists touch_record_trg on public.maintenance_records;
create trigger touch_record_trg
  before insert or update on public.maintenance_records
  for each row execute function public.touch_record();

-- ---------------------------------------------------------------------
-- 4. INVITE RPC (admin only)
-- ---------------------------------------------------------------------
-- If the person already has a confirmed account they are added right
-- away; otherwise an invite is stored and applied when they confirm.
create or replace function public.invite_member(p_email text, p_role text default 'member')
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_user  auth.users%rowtype;
begin
  if not public.is_family_admin() then
    raise exception 'Only admins can invite members.';
  end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Please provide a valid email address.';
  end if;
  if p_role not in ('admin', 'member') then
    raise exception 'Invalid role.';
  end if;

  select * into v_user from auth.users
   where lower(email) = v_email and email_confirmed_at is not null
   limit 1;

  if found then
    insert into public.family_members (user_id, email, display_name, role)
    values (v_user.id, v_email,
            coalesce(nullif(v_user.raw_user_meta_data ->> 'display_name', ''), split_part(v_email, '@', 1)),
            p_role)
    on conflict (user_id) do nothing;
    return 'added';
  end if;

  insert into public.family_invites (email, role, invited_by)
  values (v_email, p_role, auth.uid())
  on conflict (email) do update set role = excluded.role, invited_by = excluded.invited_by;
  return 'invited';
end;
$$;

revoke all on function public.invite_member(text, text) from public, anon;
grant execute on function public.invite_member(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.family_members      enable row level security;
alter table public.family_invites      enable row level security;
alter table public.maintenance_records enable row level security;

-- family_members
drop policy if exists "members can view family"   on public.family_members;
drop policy if exists "admins can change roles"   on public.family_members;
drop policy if exists "admins can remove members" on public.family_members;

create policy "members can view family" on public.family_members
  for select to authenticated using (public.is_family_member());
create policy "admins can change roles" on public.family_members
  for update to authenticated
  using (public.is_family_admin()) with check (public.is_family_admin());
create policy "admins can remove members" on public.family_members
  for delete to authenticated using (public.is_family_admin());

-- family_invites
drop policy if exists "admins view invites"   on public.family_invites;
drop policy if exists "admins delete invites" on public.family_invites;

create policy "admins view invites" on public.family_invites
  for select to authenticated using (public.is_family_admin());
create policy "admins delete invites" on public.family_invites
  for delete to authenticated using (public.is_family_admin());

-- maintenance_records
drop policy if exists "members read records"    on public.maintenance_records;
drop policy if exists "members add records"     on public.maintenance_records;
drop policy if exists "members edit records"    on public.maintenance_records;
drop policy if exists "owner or admin delete"   on public.maintenance_records;

create policy "members read records" on public.maintenance_records
  for select to authenticated using (public.is_family_member());
create policy "members add records" on public.maintenance_records
  for insert to authenticated
  with check (public.is_family_member() and created_by = auth.uid());
create policy "members edit records" on public.maintenance_records
  for update to authenticated
  using (public.is_family_member()) with check (public.is_family_member());
create policy "owner or admin delete" on public.maintenance_records
  for delete to authenticated
  using (public.is_family_member()
         and (created_by = auth.uid() or public.is_family_admin()));

-- ---------------------------------------------------------------------
-- 6. PRIVILEGES (anonymous visitors get nothing)
-- ---------------------------------------------------------------------
revoke all on public.family_members      from anon, authenticated;
revoke all on public.family_invites      from anon, authenticated;
revoke all on public.maintenance_records from anon, authenticated;

grant select, delete          on public.family_members      to authenticated;
grant update (role)           on public.family_members      to authenticated;
grant select, delete          on public.family_invites      to authenticated;
grant select, insert, delete  on public.maintenance_records to authenticated;
grant update (title, asset, category, description, status, priority,
              due_date, completed_on, cost, performed_by)
                              on public.maintenance_records to authenticated;

-- ---------------------------------------------------------------------
-- 7. REALTIME
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'maintenance_records') then
    alter publication supabase_realtime add table public.maintenance_records;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'family_members') then
    alter publication supabase_realtime add table public.family_members;
  end if;
end $$;
