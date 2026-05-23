-- 0020_team_invites.sql
-- Team page surface: add the 'viewer' role for read-only managers and a
-- manager_invites table mirroring the staff_invites pattern but for the
-- email-pool (manager) population.
--
-- venue_members already covers owner / manager (now "editor") membership;
-- 'viewer' is added to the same enum so the existing RLS path keeps
-- working with no schema split.

-- =========================
-- Enum: add 'viewer' to member_role
-- =========================
alter type public.member_role add value if not exists 'viewer';

-- =========================
-- manager_invites
-- =========================
-- Pending manager invitations created by an owner. The token lives on the
-- accept-invite link the inviter sends out (or that lands via the
-- Supabase invite email). When a logged-in manager calls
-- manager-accept-invite with the token, we materialise a venue_members
-- row at the stored role and mark the invite claimed.
create table public.manager_invites (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references public.venues(id) on delete cascade,
  email       text not null,
  role        public.member_role not null default 'manager',
  token       text not null unique,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '14 days'),
  claimed_at  timestamptz,
  claimed_by  uuid references auth.users(id) on delete set null
);

create index manager_invites_venue_idx on public.manager_invites (venue_id);
create index manager_invites_token_idx on public.manager_invites (token);
create index manager_invites_email_idx on public.manager_invites (lower(email));

-- =========================
-- staff_invites: optional channel hint (whatsapp | sms)
-- =========================
-- The Twilio integration is days away; in the meantime store the channel
-- the manager picked so we can swap from mock to real send without
-- another migration. Existing rows default to whatsapp.
alter table public.staff_invites
  add column if not exists channel text not null default 'whatsapp'
    check (channel in ('whatsapp', 'sms'));

-- =========================
-- RLS: manager_invites
-- =========================
alter table public.manager_invites enable row level security;

-- Inviter + any venue_members of the target venue can read.
create policy manager_invites_select_creator
  on public.manager_invites
  for select
  using (created_by = auth.uid());

create policy manager_invites_select_by_venue_member
  on public.manager_invites
  for select
  using (
    exists (
      select 1
      from public.venue_members vm
      where vm.venue_id = manager_invites.venue_id
        and vm.manager_id = auth.uid()
    )
  );

-- All writes via Edge Functions running with the service role — no
-- direct client write path. (No insert/update/delete policies = denied
-- for anon + authenticated.)
