-- 0039 — complete-venue profile columns.
--
-- The consumer venue-detail modal (VenueDetail in mesita-web-consumer) needs
-- far more than the venues table held. After the DB reset we only insert
-- FULLY-enriched venues (one-run profile generation), so the schema must hold
-- the whole profile. Hybrid model: filterable facts stay scalar columns; the
-- variable, multi-source nested/array data lives in JSONB.
--
-- Spine is Google Business (Places). Photos come from Google only for now
-- (Instagram/Apify later). Every field is nullable — the enricher writes what
-- it finds and leaves the rest null; the UI already tolerates nulls.

alter table public.venues
  -- Provenance
  add column if not exists enriched_at         timestamptz,
  add column if not exists enrichment_sources  jsonb,
  -- Summary / identity
  add column if not exists editorial_summary   text,
  add column if not exists zone                text,
  add column if not exists city                text,
  add column if not exists established_year    smallint,
  add column if not exists executive_chef      text,
  -- Per-visit reward ceiling, in the venue's currency minor units (cents).
  -- Distinct from monthly_promo_cap (0038), which is the venue's monthly
  -- spend ceiling. Null = no per-visit cap surfaced.
  add column if not exists reward_cap_cents    integer
    check (reward_cap_cents is null or reward_cap_cents >= 0),
  -- When true the reward unlocks only after an Instagram story (+ QR pay).
  add column if not exists requires_story      boolean not null default false,
  -- Facebook signal (Meta/Apify later; nullable now).
  add column if not exists facebook_rating     real
    check (facebook_rating is null or (facebook_rating >= 0 and facebook_rating <= 5)),
  add column if not exists facebook_followers  integer
    check (facebook_followers is null or facebook_followers >= 0),
  -- Mesita "value" sub-score, completing food/service/ambience already present.
  add column if not exists mesita_stars_value  real
    check (mesita_stars_value is null or (mesita_stars_value >= 0 and mesita_stars_value <= 5)),
  -- Rich, source-varying structures. Shapes (all nullable):
  --   details        object  — dining_style, dress_code, service_options[],
  --                            reservations, payment_methods[], parking,
  --                            amenities[], accessibility[], dietary_options[],
  --                            good_for[], languages[], kid_friendly,
  --                            pet_friendly
  --   google_reviews array   — { author, rating, quote, date, photo_url? }
  --   menus          array    — { name, source_url?, items?[], updated_at? }
  --   popular_times  array    — { day, range, bars:number[] }
  add column if not exists details             jsonb,
  add column if not exists google_reviews      jsonb,
  add column if not exists menus               jsonb,
  add column if not exists popular_times       jsonb;

comment on column public.venues.enriched_at is 'When the one-run profile enricher last wrote this venue. Null = never enriched.';
comment on column public.venues.details is 'Google-Places-style metadata object (dining style, amenities, etc.). Nullable; keys optional.';
comment on column public.venues.reward_cap_cents is 'Per-visit reward ceiling in currency minor units. Distinct from monthly_promo_cap.';

notify pgrst, 'reload schema';
