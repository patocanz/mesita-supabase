-- 0030 — split full_name into first_name + last_name on the two identity
-- tables (consumers + businesses).
--
-- Mesita ships reservations + automated outreach to venues, which need
-- the first AND last name as separate fields (the venue's host system
-- usually keys on "last name + party size"). Keeping full_name around
-- as a legacy/derived field means EFs that only consume full_name (the
-- discover surfaces, the find-consumer search, tickets) keep working.
-- New writes set all three (first, last, full); reads can use either
-- shape.
--
-- Columns are nullable on purpose — existing rows have full_name set
-- but no structured first/last, and we don't want to backfill a guess
-- (most full_name values are first names only, but some are full).
-- The next time the user touches their profile, the onboarding form
-- captures both fields properly.

alter table public.consumers
  add column if not exists first_name text,
  add column if not exists last_name  text;

alter table public.businesses
  add column if not exists first_name text,
  add column if not exists last_name  text;

comment on column public.consumers.first_name is
  'Structured first name. Captured at onboarding; combined with last_name to populate full_name. Used by reservation outreach.';
comment on column public.consumers.last_name is
  'Structured last name. Captured at onboarding; combined with first_name to populate full_name. Used by reservation outreach.';
comment on column public.businesses.first_name is
  'Structured first name for the business owner / signer. Used on contracts + invoices.';
comment on column public.businesses.last_name is
  'Structured last name for the business owner / signer. Used on contracts + invoices.';
