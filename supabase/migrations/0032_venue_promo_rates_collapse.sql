-- 0032 — collapse the eight per-tier venue promo rates into four.
--
-- The consumer membership ladder went from four classes (bronze / silver /
-- gold / diamond) to two (free / premium). The venue-side promo rates follow:
-- two passes per ladder (welcome variant for a guest's first visit, default
-- variant for every visit afterwards) crossed with the two classes =
-- welcome_free_rate / welcome_premium_rate / free_rate / premium_rate.
--
-- Backfill maps the old ladder onto the new one before the old columns drop:
--   free    <- bronze  (the entry rung)
--   premium <- gold     (falling back to diamond, then silver, if gold is null)
-- so the single venue currently carrying rates keeps a sensible value.
--
-- Legacy cashback_percent is left untouched (still the fallback rate until
-- every reader switches off it).

alter table public.venues
  drop constraint if exists venues_promo_rate_legal_values;

alter table public.venues
  add column if not exists welcome_free_rate    smallint,
  add column if not exists welcome_premium_rate smallint,
  add column if not exists free_rate            smallint,
  add column if not exists premium_rate         smallint;

update public.venues set
  welcome_free_rate    = welcome_bronze_rate,
  welcome_premium_rate = coalesce(welcome_gold_rate, welcome_diamond_rate, welcome_silver_rate),
  free_rate            = bronze_rate,
  premium_rate         = coalesce(gold_rate, diamond_rate, silver_rate);

alter table public.venues
  drop column if exists welcome_bronze_rate,
  drop column if exists welcome_silver_rate,
  drop column if exists welcome_gold_rate,
  drop column if exists welcome_diamond_rate,
  drop column if exists bronze_rate,
  drop column if exists silver_rate,
  drop column if exists gold_rate,
  drop column if exists diamond_rate;

alter table public.venues
  add constraint venues_promo_rate_legal_values
  check (
        (welcome_free_rate    is null or welcome_free_rate    in (10, 20, 50, 70))
    and (welcome_premium_rate is null or welcome_premium_rate in (10, 20, 50, 70))
    and (free_rate            is null or free_rate            in (10, 20, 50, 70))
    and (premium_rate         is null or premium_rate         in (10, 20, 50, 70))
  );

comment on column public.venues.welcome_free_rate    is 'First-visit promo for Free guests. One of 10, 20, 50, 70 or null.';
comment on column public.venues.welcome_premium_rate is 'First-visit promo for Premium guests. One of 10, 20, 50, 70 or null.';
comment on column public.venues.free_rate            is 'Returning-visit promo for Free guests. One of 10, 20, 50, 70 or null.';
comment on column public.venues.premium_rate         is 'Returning-visit promo for Premium guests. One of 10, 20, 50, 70 or null.';

notify pgrst, 'reload schema';
