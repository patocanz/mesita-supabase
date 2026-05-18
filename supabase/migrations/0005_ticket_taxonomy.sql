-- 0005_ticket_taxonomy.sql
-- Move tickets from the single-flow "cashback at the table" model to the
-- ten-type taxonomy that powers Mesita's coupon layer:
--
--   Formal (cashback):
--     1. none
--     2. p_c              Payment → Cashback
--     3. s_p_sf_c         Story → Payment → Story-Fallback → Cashback
--     4. r_p_c            Reservation → Payment → Cashback
--     5. r_s_p_sf_c       Reservation → Story → Payment → Story-Fallback → Cashback
--   Informal (instant discount, cash off-rail):
--     1. none
--     2. dp               Discounted-Payment
--     3. s_dp_sf          Story → Discounted-Payment → Story-Fallback (vulnerable)
--     4. r_dp             Reservation → Discounted-Payment
--     5. r_s_dp_sf        Reservation → Story → Discounted-Payment → Story-Fallback (vulnerable)
--
-- Key shape changes:
--   - venues gain a `fiscal_type` enum (formal | informal). It pins the
--     coupon mechanic; it is not optional and not user-toggleable per ticket.
--   - tickets gain `kind` (the 10-type enum), `story_status` (the lifecycle
--     of the IG-story bonus), discount fields (informal mechanic), and
--     reservation fields (the AI-booking layer that any non-"none" flow
--     starting with R uses).
--   - Two new ticket statuses round out the lifecycle:
--       * `revealed`        — informal flow: discount has been shown to the
--                             waiter and applied at the bill. Mesita stays out
--                             of the cash flow from here.
--       * `awaiting_story`  — formal flow: payment cleared, story verification
--                             still pending. Cashback hasn't landed yet.

-- ── New enums ────────────────────────────────────────────────────────────

create type public.venue_fiscal_type as enum ('formal', 'informal');

create type public.ticket_kind as enum (
  'none',
  -- formal cashback flows
  'p_c',
  's_p_sf_c',
  'r_p_c',
  'r_s_p_sf_c',
  -- informal discount flows
  'dp',
  's_dp_sf',
  'r_dp',
  'r_s_dp_sf'
);

create type public.story_status as enum (
  'not_required',
  'pending',         -- guest is expected to post + upload a screenshot
  'submitted',       -- guest uploaded; waiting on AI / waiter
  'ai_verified',     -- AI matched the @mention or location tag
  'ai_rejected',     -- AI couldn't match — flows to waiter fallback
  'waiter_verified', -- waiter approved manually
  'waiter_rejected'  -- waiter rejected manually (terminal)
);

create type public.reservation_status as enum (
  'pending',     -- AI agent dispatched; awaiting response from the venue
  'confirmed',   -- venue confirmed the table
  'declined',    -- venue couldn't accommodate
  'no_show',     -- guest didn't arrive (set post-hoc by venue/auto-detect)
  'cancelled'    -- guest cancelled before the visit
);

-- Extend ticket_status with the two new lifecycle nodes. (PG14+ supports
-- adding enum values in a single statement; we use IF NOT EXISTS so the
-- migration is idempotent in dev resets.)
alter type public.ticket_status add value if not exists 'revealed';
alter type public.ticket_status add value if not exists 'awaiting_story';

-- ── Venues: fiscal type ──────────────────────────────────────────────────

alter table public.venues
  add column fiscal_type public.venue_fiscal_type not null default 'formal';

comment on column public.venues.fiscal_type is
  'Pins the coupon mechanic for this venue. Formal → cashback via Stripe + Mesita wallet. Informal → instant discount applied to the cash bill, Mesita stays out of the payment flow. Not user-toggleable per ticket; this is the venue''s fiscal posture.';

-- ── Tickets: taxonomy + story + discount + reservation ──────────────────

alter table public.tickets
  -- Kind: which of the 10 flows this ticket represents.
  add column kind public.ticket_kind not null default 'p_c',

  -- Story: lifecycle of the IG-story bonus. NULL-equivalent is
  -- not_required, used by flows that don't require a story.
  add column story_status public.story_status not null default 'not_required',
  add column story_screenshot_url text,
  add column story_submitted_at timestamptz,
  add column story_verified_at timestamptz,
  add column story_verified_by uuid references public.managers(id) on delete set null,
  add column story_reject_reason text,

  -- Discount mechanic (informal). Snapshot the rate + cents at reveal time
  -- so the receipt is reproducible even if the venue rate changes later.
  add column discount_percent smallint check (discount_percent is null or (discount_percent between 0 and 100)),
  add column discount_cents integer check (discount_cents is null or discount_cents >= 0),
  add column revealed_at timestamptz,

  -- Reservation layer (R-prefixed flows).
  add column reservation_status public.reservation_status,
  add column reservation_at timestamptz,
  add column reservation_party_size smallint check (reservation_party_size is null or reservation_party_size > 0),
  add column reservation_channel text check (reservation_channel is null or reservation_channel in ('voice', 'whatsapp', 'instagram_dm', 'web_form', 'email')),
  add column reservation_notes text;

comment on column public.tickets.kind is
  'Which of the 10 ticket flows this row represents. Drives the step timeline shown to the guest and the gating logic on cashback / discount.';
comment on column public.tickets.story_status is
  'Lifecycle of the IG-story bonus. Not_required for flows that don''t need a story; pending → submitted → (ai|waiter)_verified/rejected for the rest.';
comment on column public.tickets.discount_cents is
  'For informal flows only. The instant discount applied at the bill, snapshotted at reveal time. Formal flows use cashback_cents.';

-- Helpful indexes for the new query shapes.
create index tickets_story_status_idx on public.tickets (story_status)
  where story_status in ('submitted', 'ai_rejected');
create index tickets_reservation_idx on public.tickets (reservation_at)
  where reservation_at is not null;

-- ── Sanity: tickets created before this migration were all cashback ─────
-- All existing rows pre-date this taxonomy. They were originally created
-- as the equivalent of the new `p_c` kind, and the `kind` column above
-- defaults to `p_c`, so nothing to backfill. Their story_status defaults
-- to `not_required` (the column is NOT NULL DEFAULT), which is the right
-- shape for the legacy "no story" flow.
