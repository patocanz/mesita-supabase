-- 0054 — drop atlas_google_reviews.
--
-- Google reviews now come from Apify (compass/crawler-google-places), which
-- returns ALL reviews. There is no per-venue review limit anymore, so the cap
-- param (which existed for the Places API 5-review cap) is removed. Runs after
-- the settings EFs stopped referencing it.

alter table public.app_settings
  drop column if exists atlas_google_reviews;

notify pgrst, 'reload schema';
