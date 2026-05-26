-- Adds eight per-tier promo rates to public.venues. Two passes per ladder
-- (Welcome variant for a guest's first visit at this venue, and the default
-- variant for every visit afterwards) crossed with the four classes:
-- bronze / silver / gold / diamond. Legal values are 10, 20, 50, 70.
-- Nullable; null means "no promo offered at this tier".
--
-- The legacy cashback_percent column stays untouched for now — it can be
-- retired once every read-EF + every UI surface has switched to the new
-- per-tier projection.

alter table public.venues
  add column if not exists welcome_bronze_rate  smallint,
  add column if not exists welcome_silver_rate  smallint,
  add column if not exists welcome_gold_rate    smallint,
  add column if not exists welcome_diamond_rate smallint,
  add column if not exists bronze_rate          smallint,
  add column if not exists silver_rate          smallint,
  add column if not exists gold_rate            smallint,
  add column if not exists diamond_rate         smallint;

-- Constrain each new column to the legal rate set (10/20/50/70). Null
-- always passes — that's how a venue says "this tier has no promo yet".
alter table public.venues
  add constraint venues_promo_rate_legal_values
  check (
        (welcome_bronze_rate  is null or welcome_bronze_rate  in (10, 20, 50, 70))
    and (welcome_silver_rate  is null or welcome_silver_rate  in (10, 20, 50, 70))
    and (welcome_gold_rate    is null or welcome_gold_rate    in (10, 20, 50, 70))
    and (welcome_diamond_rate is null or welcome_diamond_rate in (10, 20, 50, 70))
    and (bronze_rate          is null or bronze_rate          in (10, 20, 50, 70))
    and (silver_rate          is null or silver_rate          in (10, 20, 50, 70))
    and (gold_rate            is null or gold_rate            in (10, 20, 50, 70))
    and (diamond_rate         is null or diamond_rate         in (10, 20, 50, 70))
  );

comment on column public.venues.welcome_bronze_rate  is 'First-visit promo for Bronze guests. One of 10, 20, 50, 70 or null.';
comment on column public.venues.welcome_silver_rate  is 'First-visit promo for Silver guests. One of 10, 20, 50, 70 or null.';
comment on column public.venues.welcome_gold_rate    is 'First-visit promo for Gold guests. One of 10, 20, 50, 70 or null.';
comment on column public.venues.welcome_diamond_rate is 'First-visit promo for Diamond guests. One of 10, 20, 50, 70 or null.';
comment on column public.venues.bronze_rate          is 'Returning-visit promo for Bronze guests. One of 10, 20, 50, 70 or null.';
comment on column public.venues.silver_rate          is 'Returning-visit promo for Silver guests. One of 10, 20, 50, 70 or null.';
comment on column public.venues.gold_rate            is 'Returning-visit promo for Gold guests. One of 10, 20, 50, 70 or null.';
comment on column public.venues.diamond_rate         is 'Returning-visit promo for Diamond guests. One of 10, 20, 50, 70 or null.';
