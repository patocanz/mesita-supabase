-- 0010_auth_roles.sql
-- Auth identity model for Mesita.
--
-- Two populations on auth.users, distinguished by app_metadata.role:
--
--   role = 'guest'   → phone OTP (B2C diner)
--   role = 'staff'   → phone OTP (validator on WhatsApp / web), same auth
--                      pool as guests, role flips on invite-accept
--   role = 'manager' → email + password (B2B venue owner)
--   role = 'admin'   → email + password, @canzeco.com only, MFA mandatory
--
-- One human can have at most one guest/staff auth.user (phone canonical).
-- A venue owner who also dines holds TWO accounts (manager email + guest
-- phone). venue_roles ties auth.users to a venue with a role, replacing
-- the older venue_members for staff; venue_members stays for now to keep
-- legacy manager EFs working — managers will migrate to venue_roles in a
-- follow-up.

-- =========================
-- Enum: venue_role
-- =========================
-- Mirrors the spec's ('staff','manager'). 'manager' is included so a future
-- cleanup can fold venue_members into venue_roles without another enum
-- migration.
create type public.venue_role as enum ('staff', 'manager');

-- =========================
-- venue_roles
-- =========================
-- One row per (user_id, venue_id). Points directly at auth.users so it
-- covers both the phone-pool (staff) and the email-pool (manager) without
-- a join through managers/guests.
create table public.venue_roles (
  user_id     uuid not null references auth.users(id) on delete cascade,
  venue_id    uuid not null references public.venues(id) on delete cascade,
  role        public.venue_role not null,
  invited_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (user_id, venue_id)
);

create index venue_roles_venue_idx on public.venue_roles (venue_id);
create index venue_roles_user_idx  on public.venue_roles (user_id);

-- =========================
-- staff_invites
-- =========================
-- Pending staff invitations created by a manager. The token lives on the
-- invite link the manager sends out. When a logged-in user (already
-- authed via guest OTP) calls staff-accept-invite with the token, we
-- materialise a venue_roles row and flip their app_metadata.role.
create table public.staff_invites (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references public.venues(id) on delete cascade,
  token       text not null unique,
  -- Optional pre-bind: if the manager already knows the staff's E.164
  -- phone, store it here so the EF can verify the redeemer matches.
  phone       text,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '14 days'),
  claimed_at  timestamptz,
  claimed_by  uuid references auth.users(id) on delete set null
);

create index staff_invites_venue_idx on public.staff_invites (venue_id);
create index staff_invites_token_idx on public.staff_invites (token);

-- =========================
-- RLS: venue_roles
-- =========================
alter table public.venue_roles enable row level security;

-- Users can see their own venue_roles rows. Managers can see roles in
-- venues they own (via venue_members membership at any role).
create policy venue_roles_select_own
  on public.venue_roles
  for select
  using (user_id = auth.uid());

create policy venue_roles_select_by_venue_member
  on public.venue_roles
  for select
  using (
    exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = venue_roles.venue_id
        and vm.manager_id = auth.uid()
    )
  );

-- All writes go through Edge Functions running with the service role —
-- no direct client write path on this table. (No insert/update/delete
-- policies = denied for anon + authenticated.)

-- =========================
-- RLS: staff_invites
-- =========================
alter table public.staff_invites enable row level security;

-- Manager that created the invite + manager that owns the venue can read.
create policy staff_invites_select_creator
  on public.staff_invites
  for select
  using (created_by = auth.uid());

create policy staff_invites_select_by_venue_member
  on public.staff_invites
  for select
  using (
    exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = staff_invites.venue_id
        and vm.manager_id = auth.uid()
    )
  );

-- Writes via Edge Functions only.

-- =========================
-- RLS: guests (hardening)
-- =========================
-- guests.id already references auth.users(id). Tighten access so a
-- guest only sees their own row.
alter table public.guests enable row level security;

drop policy if exists guests_select_self on public.guests;
create policy guests_select_self
  on public.guests
  for select
  using (id = auth.uid());

-- All writes via EFs.

-- =========================
-- RLS: managers (hardening)
-- =========================
alter table public.managers enable row level security;

drop policy if exists managers_select_self on public.managers;
create policy managers_select_self
  on public.managers
  for select
  using (id = auth.uid());

-- =========================
-- Helper: claim-based role check
-- =========================
-- Reads app_metadata.role from the JWT. Lets RLS policies + EFs do a
-- single-call check without hitting auth.users every time.
--
-- search_path is locked down per Supabase security advisor — otherwise
-- a user-defined function on the search path could shadow `auth.jwt()`.
create or replace function public.jwt_role()
returns text
language sql
stable
set search_path = pg_catalog, public, auth
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
$$;

-- =========================
-- Token helper for staff invites
-- =========================
-- Returns a URL-safe random token. The trigger sets it on insert if the
-- caller didn't pass one (Edge Functions usually do, but this keeps the
-- column non-null in any case). search_path locked down for the same
-- reason as jwt_role().
create or replace function public.generate_invite_token()
returns text
language sql
volatile
set search_path = pg_catalog, extensions
as $$
  select replace(encode(gen_random_bytes(18), 'base64'), '/', '_');
$$;
