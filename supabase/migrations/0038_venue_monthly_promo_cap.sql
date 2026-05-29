-- 0038 — monthly promo spend cap per venue.
--
-- The business can bound how much it spends on promos in a calendar month.
-- One venue-level ceiling (not per-tier), denominated in the venue's currency
-- (venues.currency, default MXN). Legal values mirror the picker on the
-- business Promos page: 200 / 500 / 1000 / 2000. Null means no cap.
--
-- smallint is wide enough (2000 << 32767). Nullable with no default so an
-- unconfigured venue reads as "no cap" rather than silently throttling spend.

alter table public.venues
  add column if not exists monthly_promo_cap smallint;

alter table public.venues
  add constraint venues_monthly_promo_cap_legal_values
  check (monthly_promo_cap is null or monthly_promo_cap in (200, 500, 1000, 2000));

comment on column public.venues.monthly_promo_cap is
  'Max monthly promo spend in venues.currency. One of 200, 500, 1000, 2000 or null (no cap).';

notify pgrst, 'reload schema';
