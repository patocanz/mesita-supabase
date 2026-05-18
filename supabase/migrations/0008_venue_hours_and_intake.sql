-- 0008_venue_hours_and_intake.sql
-- Two related changes that together close the "create venue" intake gap:
--
--   1. venues.hours (jsonb) — the full weekly schedule normalised from
--      Google's regularOpeningHours.periods. We keep closes_at as well; it
--      stays useful as a denormalised "is this place open late?" signal for
--      list/sort, and back-compat for the existing card UI.
--
--   2. New enum values that let the intake function publish a venue in a
--      hidden, unclaimed state instead of immediately going live:
--        • venue_status += 'pending_review'  — created from a placeId by a
--          caller who isn't yet verified as the venue's manager. Public
--          read RLS (status in ('active', 'lead')) intentionally excludes
--          it; manager-list-units (service role) still surfaces it to the
--          creator.
--        • listing_type += 'unclaimed'       — the row exists for catalog
--          completeness but no manager has been verified as its operator.
--          manager-create-ticket already gates ticket creation on
--          listing_type = 'partner', so 'unclaimed' venues correctly can't
--          issue tickets.
--
-- No backfill: existing rows keep their current status/listing_type. RLS
-- policy unchanged on purpose — adding 'pending_review' to the public
-- filter would defeat the security improvement.

-- ── Hours column ─────────────────────────────────────────────────────────
alter table public.venues
  add column hours jsonb;

comment on column public.venues.hours is
  'Normalised weekly hours from Google Places regularOpeningHours.periods. Shape: { "monday": [{"open":"HH:MM","close":"HH:MM"}], ... } using lowercase English day keys. Multiple ranges per day for split shifts. Closed days omit the key. closes_at remains as a denormalised "latest close today" signal.';

-- ── Enum value additions ────────────────────────────────────────────────
-- PG 12+: ALTER TYPE ADD VALUE is fine inside a transaction as long as
-- the new value isn't *used* in the same transaction. We don't use them
-- here; the edge function does.
alter type public.venue_status add value if not exists 'pending_review';
alter type public.listing_type add value if not exists 'unclaimed';
