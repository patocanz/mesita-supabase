-- 0048 — drop atlas_reviews_per_site.
--
-- Reviews come from GOOGLE ONLY. No other source contributes reviews
-- (TripAdvisor/OpenTable/Yelp are used for ranking/links/dining detail, not
-- review ingestion). So a generic per-site review cap controls nothing.
-- Removed from the admin console + settings EFs; this drops the column.
-- Google reviews keep their own cap (atlas_google_reviews).

alter table public.app_settings
  drop column if exists atlas_reviews_per_site;

notify pgrst, 'reload schema';
