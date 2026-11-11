-- =====================================================================
-- Family Car Maintenance (Pride) - Supabase PostgreSQL setup
-- Run ONCE in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- Safe to re-run: it never deletes or overwrites existing records.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------

create table if not exists public.family_members (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  email        text not null,
  display_name text,
  role         text not null default 'member' check (role in ('admin', 'member')),
  created_at   timestamptz not null default now()
);

create table if not exists public.family_invites (
  email      text primary key check (email = lower(email)),
  role       text not null default 'member' check (role in ('admin', 'member')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.vehicles (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  current_mileage integer not null default 0 check (current_mileage between 0 and 9999999),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id) on delete set null
);

-- Checklist catalog: the standard schedule + custom tasks added by the family.
create table if not exists public.maintenance_tasks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 200),
  interval_km integer check (interval_km is null or interval_km > 0),   -- null = no schedule
  is_custom   boolean not null default false,
  sort_order  integer not null default 1000,
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create unique index if not exists maintenance_tasks_title_uq on public.maintenance_tasks (lower(title));

-- Service History: one row per visit to a repair shop / service.
create table if not exists public.service_visits (
  id             uuid primary key default gen_random_uuid(),
  vehicle_id     uuid not null references public.vehicles (id),
  service_date   date not null,
  mileage        integer not null check (mileage between 0 and 9999999),
  shop_name      text check (char_length(shop_name) <= 200),
  parts_replaced text check (char_length(parts_replaced) <= 5000),
  total_cost     numeric(14,2) check (total_cost is null or total_cost >= 0),
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists service_visits_date_idx on public.service_visits (service_date desc, mileage desc);

-- Which checklist tasks were completed in a visit (multiple selection).
create table if not exists public.visit_tasks (
  visit_id uuid not null references public.service_visits (id) on delete cascade,
  task_id  uuid not null references public.maintenance_tasks (id),
  primary key (visit_id, task_id)
);

-- Multiple notes per visit, each with its author and time (append-only).
create table if not exists public.visit_notes (
  id         uuid primary key default gen_random_uuid(),
  visit_id   uuid not null references public.service_visits (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 5000),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists visit_notes_visit_idx on public.visit_notes (visit_id, created_at);

-- ---------------------------------------------------------------------
-- 2. SEED DATA (configuration only: the vehicle and the standard schedule)
-- ---------------------------------------------------------------------

insert into public.vehicles (name, current_mileage)
select 'پراید', 0
where not exists (select 1 from public.vehicles);

insert into public.maintenance_tasks (title, interval_km, is_custom, sort_order) values
  ('تعویض روغن موتور',                                   5000,  false, 10),
  ('تعویض فیلتر روغن',                                   5000,  false, 11),
  ('بازدید سطح روغن ترمز',                               5000,  false, 12),
  ('بازدید سطح روغن هیدرولیک فرمان',                     5000,  false, 13),
  ('تعویض فیلتر هوا',                                    10000, false, 20),
  ('بازدید فشار باد لاستیک‌ها',                          10000, false, 21),
  ('بازدید لنت و دیسک ترمز',                             10000, false, 22),
  ('تعویض فیلتر بنزین',                                  20000, false, 30),
  ('بازدید سیستم تعلیق و جلوبندی',                       20000, false, 31),
  ('بازدید بلبرینگ چرخ‌ها، سیبک‌ها و کمک‌فنرها',         20000, false, 32),
  ('تعویض تسمه تایمینگ',                                 40000, false, 40),
  ('تعویض روغن گیربکس دستی',                             40000, false, 41)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 3. HELPER FUNCTIONS
-- ---------------------------------------------------------------------

create or replace function public.is_family_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.family_members where user_id = auth.uid());
$$;

create or replace function public.is_family_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.family_members where user_id = auth.uid() and role = 'admin');
$$;

revoke all on function public.is_family_member() from public, anon;
revoke all on function public.is_family_admin()  from public, anon;
grant execute on function public.is_family_member() to authenticated;
grant execute on function public.is_family_admin()  to authenticated;

-- ---------------------------------------------------------------------
-- 4. TRIGGERS
-- ---------------------------------------------------------------------

-- Membership is granted only for a CONFIRMED email that was invited,
-- or for the very first account (becomes admin).
create or replace function public.handle_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  inv    public.family_invites%rowtype;
  v_name text;
begin
  if new.email is null or new.email_confirmed_at is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(424242);

  if exists (select 1 from public.family_members where user_id = new.id) then
    return new;
  end if;

  v_name := coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1));
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

-- Never leave the family without an admin.
create or replace function public.protect_last_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin'
     and (tg_op = 'DELETE' or new.role <> 'admin')
     and not exists (select 1 from public.family_members where role = 'admin' and user_id <> old.user_id) then
    raise exception 'خانواده باید حداقل یک مدیر داشته باشد.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists protect_last_admin_trg on public.family_members;
create trigger protect_last_admin_trg
  before update of role or delete on public.family_members
  for each row execute function public.protect_last_admin();

-- Audit columns can't be spoofed by clients.
create or replace function public.touch_row()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'UPDATE' and tg_table_name = 'service_visits' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists touch_visits_trg on public.service_visits;
create trigger touch_visits_trg before insert or update on public.service_visits
  for each row execute function public.touch_row();

drop trigger if exists touch_vehicles_trg on public.vehicles;
create trigger touch_vehicles_trg before update on public.vehicles
  for each row execute function public.touch_row();

-- ---------------------------------------------------------------------
-- 5. RPC: save a service visit atomically (visit + tasks + note + mileage)
--    SECURITY INVOKER: Row Level Security applies to every statement.
-- ---------------------------------------------------------------------
create or replace function public.save_service_visit(
  p_visit_id   uuid,
  p_vehicle_id uuid,
  p_date       date,
  p_mileage    integer,
  p_shop       text,
  p_parts      text,
  p_cost       numeric,
  p_task_ids   uuid[],
  p_note       text
) returns uuid
language plpgsql
as $$
declare
  v_id uuid;
  v_tasks uuid[] := coalesce(p_task_ids, '{}');
begin
  if p_visit_id is null then
    insert into public.service_visits (vehicle_id, service_date, mileage, shop_name, parts_replaced, total_cost)
    values (p_vehicle_id, p_date, p_mileage, nullif(btrim(p_shop), ''), nullif(btrim(p_parts), ''), p_cost)
    returning id into v_id;
  else
    update public.service_visits
       set service_date = p_date,
           mileage = p_mileage,
           shop_name = nullif(btrim(p_shop), ''),
           parts_replaced = nullif(btrim(p_parts), ''),
           total_cost = p_cost
     where id = p_visit_id
     returning id into v_id;
    if v_id is null then
      raise exception 'رکورد پیدا نشد یا اجازه ویرایش ندارید.';
    end if;
  end if;

  delete from public.visit_tasks where visit_id = v_id and task_id <> all (v_tasks);
  insert into public.visit_tasks (visit_id, task_id)
    select v_id, t from unnest(v_tasks) as t
  on conflict do nothing;

  if p_note is not null and btrim(p_note) <> '' then
    insert into public.visit_notes (visit_id, body) values (v_id, btrim(p_note));
  end if;

  update public.vehicles
     set current_mileage = greatest(current_mileage, p_mileage)
   where id = p_vehicle_id;

  return v_id;
end;
$$;

revoke all on function public.save_service_visit(uuid, uuid, date, integer, text, text, numeric, uuid[], text) from public, anon;
grant execute on function public.save_service_visit(uuid, uuid, date, integer, text, text, numeric, uuid[], text) to authenticated;

-- Admin-only invitations.
create or replace function public.invite_member(p_email text, p_role text default 'member')
returns text language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  v_user  auth.users%rowtype;
begin
  if not public.is_family_admin() then
    raise exception 'فقط مدیر می‌تواند عضو دعوت کند.';
  end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'ایمیل معتبر وارد کنید.';
  end if;
  if p_role not in ('admin', 'member') then
    raise exception 'نقش نامعتبر است.';
  end if;

  select * into v_user from auth.users
   where lower(email) = v_email and email_confirmed_at is not null limit 1;

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
-- 6. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.family_members   enable row level security;
alter table public.family_invites   enable row level security;
alter table public.vehicles         enable row level security;
alter table public.maintenance_tasks enable row level security;
alter table public.service_visits   enable row level security;
alter table public.visit_tasks      enable row level security;
alter table public.visit_notes      enable row level security;

do $$
declare r record;
begin  -- drop old policies so the script can be re-run
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public'
             and tablename in ('family_members','family_invites','vehicles','maintenance_tasks',
                               'service_visits','visit_tasks','visit_notes')
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- family_members / family_invites
create policy fm_select on public.family_members for select to authenticated using (public.is_family_member());
create policy fm_update on public.family_members for update to authenticated
  using (public.is_family_admin()) with check (public.is_family_admin());
create policy fm_delete on public.family_members for delete to authenticated using (public.is_family_admin());

create policy fi_select on public.family_invites for select to authenticated using (public.is_family_admin());
create policy fi_delete on public.family_invites for delete to authenticated using (public.is_family_admin());

-- vehicles: members read + update mileage (no insert/delete from the app)
create policy veh_select on public.vehicles for select to authenticated using (public.is_family_member());
create policy veh_update on public.vehicles for update to authenticated
  using (public.is_family_member()) with check (public.is_family_member());

-- checklist catalog: members read and add custom tasks only
create policy task_select on public.maintenance_tasks for select to authenticated using (public.is_family_member());
create policy task_insert on public.maintenance_tasks for insert to authenticated
  with check (public.is_family_member() and is_custom and created_by = auth.uid());

-- service history: members read/add/edit. There is NO delete policy: records are never deleted by the app.
create policy sv_select on public.service_visits for select to authenticated using (public.is_family_member());
create policy sv_insert on public.service_visits for insert to authenticated
  with check (public.is_family_member() and created_by = auth.uid());
create policy sv_update on public.service_visits for update to authenticated
  using (public.is_family_member()) with check (public.is_family_member());

create policy vt_select on public.visit_tasks for select to authenticated using (public.is_family_member());
create policy vt_insert on public.visit_tasks for insert to authenticated with check (public.is_family_member());
create policy vt_delete on public.visit_tasks for delete to authenticated using (public.is_family_member());

create policy vn_select on public.visit_notes for select to authenticated using (public.is_family_member());
create policy vn_insert on public.visit_notes for insert to authenticated
  with check (public.is_family_member() and created_by = auth.uid());

-- ---------------------------------------------------------------------
-- 7. PRIVILEGES (anonymous visitors get nothing)
-- ---------------------------------------------------------------------
revoke all on public.family_members, public.family_invites, public.vehicles, public.maintenance_tasks,
              public.service_visits, public.visit_tasks, public.visit_notes
  from anon, authenticated;

grant select, delete on public.family_members to authenticated;
grant update (role)  on public.family_members to authenticated;
grant select, delete on public.family_invites to authenticated;
grant select                           on public.vehicles to authenticated;
grant update (current_mileage)         on public.vehicles to authenticated;
grant select, insert                   on public.maintenance_tasks to authenticated;
grant select, insert                   on public.service_visits to authenticated;
grant update (service_date, mileage, shop_name, parts_replaced, total_cost)
                                       on public.service_visits to authenticated;
grant select, insert, delete           on public.visit_tasks to authenticated;
grant select, insert                   on public.visit_notes to authenticated;

-- ---------------------------------------------------------------------
-- 8. REALTIME
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['vehicles','maintenance_tasks','service_visits','visit_tasks','visit_notes','family_members']
  loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
