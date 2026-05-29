-- 0053 — drop atlas_analyze_website_images.
--
-- The vision set is Google + Instagram only (per the "Vision Params" spec).
-- Website is menu/content, not part of the experience-photo vision pipeline,
-- so the website-images vision cap is removed. (atlas_website_crawl_max_pages
-- stays — it governs the website MENU crawl under Data sources.)
-- Runs after the settings EFs stopped referencing this column.

alter table public.app_settings
  drop column if exists atlas_analyze_website_images;

notify pgrst, 'reload schema';
