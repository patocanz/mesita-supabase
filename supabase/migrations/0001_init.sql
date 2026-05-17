-- 0001_init.sql
-- Core domain v0 for Mesita: venues, managers, venue_members, guests
-- Includes enums, updated_at trigger, and tight RLS policies.

-- =========================
-- Enums
-- =========================
create type public.venue_status as enum ('lead', 'active', 'paused', 'archived');
create type public.listing_type as enum ('partner', 'web');
create type public.member_role  as enum ('owner', 'manager', 'staff');

-- =========================
-- updated_at trigger helper
-- =========================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =========================
-- venues
-- =========================
create table public.venues (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  google_place_id   text unique,
  slug              text not null unique,
  name              text not null,
  category          text,
  vibe              text,
  price_level       smallint check (price_level between 1 and 4),
  listing_type      public.listing_type not null default 'web',
  status            public.venue_status not null default 'lead',
  lat               numeric(9, 6),
  lng               numeric(9, 6),
  address           text,
  timezone          text,
  closes_at         text,
  phone             text,
  pitch             text,
  story             text,
  cashback_percent  smallint check (cashback_percent between 0 and 100),
  photos            text[] not null default '{}'
);

create trigger venues_set_updated_at
  before update on public.venues
  for each row execute function public.set_updated_at();

create index venues_status_idx        on public.venues (status);
create index venues_listing_type_idx  on public.venues (listing_type);

-- =========================
-- managers (profile bound to auth.users)
-- =========================
create table public.managers (
  id          uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  full_name   text,
  email       text,
  phone       text
);

-- =========================
-- venue_members (manager <-> venue with role)
-- =========================
create table public.venue_members (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references public.venues(id)   on delete cascade,
  manager_id  uuid not null references public.managers(id) on delete cascade,
  role        public.member_role not null default 'manager',
  created_at  timestamptz not null default now(),
  unique (venue_id, manager_id)
);

create index venue_members_venue_idx    on public.venue_members (venue_id);
create index venue_members_manager_idx  on public.venue_members (manager_id);

-- =========================
-- guests (profile bound to auth.users; not used until phone-OTP plan)
-- =========================
create table public.guests (
  id          uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  full_name   text,
  sex         text check (sex in ('male', 'female', 'other')),
  birthday    date,
  country     text,
  phone       text unique,
  avatar_url  text
);

-- =========================
-- Row-level security (tight by default; writes via service role only)
-- =========================
alter table public.venues        enable row level security;
alter table public.managers      enable row level security;
alter table public.venue_members enable row level security;
alter table public.guests        enable row level security;

-- venues: anyone (anon + authenticated) reads rows that are 'active' or 'lead'.
-- Writes happen through Edge Functions / server actions using the service role.
create policy "venues_select_public_visible"
  on public.venues
  for select
  to anon, authenticated
  using (status in ('active', 'lead'));

-- managers: self-read + self-update only.
create policy "managers_select_self"
  on public.managers
  for select
  to authenticated
  using (auth.uid() = id);

create policy "managers_update_self"
  on public.managers
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- venue_members: a manager can see their own memberships.
create policy "venue_members_select_self"
  on public.venue_members
  for select
  to authenticated
  using (manager_id = auth.uid());

-- guests: self-read + self-update only.
create policy "guests_select_self"
  on public.guests
  for select
  to authenticated
  using (auth.uid() = id);

create policy "guests_update_self"
  on public.guests
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);
