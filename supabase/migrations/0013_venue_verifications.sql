-- 0013_venue_verifications.sql
-- Ownership verification for newly-claimed venues.
--
-- Manager flow:
--   1. Manager creates a unit via manager-create-unit. The venue lands
--      in status='pending_verification' with a venue_members owner row
--      so the manager can see the unit (but pages gate on status).
--   2. Manager opens /unit/<id>/verify and submits one of three
--      verification methods. A row in public.venue_verifications is
--      created.
--   3. If public.app_settings.auto_verify_venues = true, the EF that
--      writes the row also immediately decides=approved. Otherwise an
--      admin reviews in admin.mesita.ai/verifications and flips the
--      decision manually.
--   4. On approval, venues.status flips to 'active'. Rejection stores
--      a reason and the manager can submit a fresh request.

-- ─────────────────────────────────────────────────────────────────────
-- Extend venues.status enum with the new pending state
-- ─────────────────────────────────────────────────────────────────────
alter type public.venue_status add value if not exists 'pending_verification';

-- ─────────────────────────────────────────────────────────────────────
-- Single-row app settings table
-- ─────────────────────────────────────────────────────────────────────
-- One global config row. A CHECK constraint pins id=1 so multiple
-- inserts are impossible — there is exactly one row that exists for
-- the lifetime of the project.
create table public.app_settings (
  id                  smallint primary key default 1
                       check (id = 1),
  -- When true, venue_verifications inserts are auto-approved on the
  -- spot (no human in the loop). For v0 we ship this as true so the
  -- end-to-end flow works without an admin clicking each time.
  auto_verify_venues  boolean not null default true,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users(id) on delete set null
);

insert into public.app_settings (id) values (1);

alter table public.app_settings enable row level security;
-- No policies. Reads + writes go through Edge Functions (service role).

create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- venue_verifications
-- ─────────────────────────────────────────────────────────────────────
create type public.verification_method as enum (
  'ai_call',     -- automated phone call to the Google-listed venue phone
  'video',       -- manager pastes a URL to a 1-min walkthrough video
  'postcard'     -- Google-style mailed code (physical letter)
);

create type public.verification_status as enum (
  'pending',
  'approved',
  'rejected'
);

create table public.venue_verifications (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null
                       references public.venues(id) on delete cascade,
  -- The auth.users row of the manager who submitted this request. We
  -- index on this so manager-get-verification can look up "my latest
  -- request for this venue" cheaply.
  requester_id        uuid not null
                       references auth.users(id) on delete cascade,
  method              public.verification_method not null,
  -- Free-form per-method payload. Schema by method:
  --   ai_call:  { phoneCalled: text }            (Google-listed phone copied at submit time)
  --   video:    { videoUrl: text }                (manager paste-in)
  --   postcard: {}                                (no payload, postcard arrives in a few days)
  payload             jsonb not null default '{}'::jsonb,
  -- Fallback contact for the operator (their own email) so an admin
  -- can reach out manually if the verification needs follow-up.
  requester_email     text not null
                       check (requester_email = lower(requester_email)
                              and position('@' in requester_email) > 1),
  status              public.verification_status not null default 'pending',
  -- Set when status flips away from 'pending'.
  decided_at          timestamptz,
  decided_by          uuid references auth.users(id) on delete set null,
  -- "auto" when the auto-approve path ran; "admin" when a super-admin
  -- clicked approve/reject. NULL on pending rows.
  decided_via         text check (decided_via in ('auto', 'admin')),
  reject_reason       text,
  created_at          timestamptz not null default now()
);

create index venue_verifications_venue_idx
  on public.venue_verifications (venue_id, created_at desc);

create index venue_verifications_requester_idx
  on public.venue_verifications (requester_id, created_at desc);

-- Pending rows are the admin queue's hot path.
create index venue_verifications_pending_idx
  on public.venue_verifications (created_at desc)
  where status = 'pending';

alter table public.venue_verifications enable row level security;
-- No policies. EFs read + write via service role.
