-- 0051 — drop image params replaced by the 3-stage funnel (0050).
--
-- atlas_research_google_images: Google is now fixed at 10 (Places default
--   order) in the Selection stage — no longer a param.
-- atlas_max_images_analyzed: replaced by per-source vision caps X3/X4/X5
--   (atlas_analyze_google_images / _website_images / _instagram_images).
--
-- Runs AFTER admin-get-settings + admin-update-atlas-config stopped
-- referencing these columns.

alter table public.app_settings
  drop column if exists atlas_research_google_images,
  drop column if exists atlas_max_images_analyzed;

notify pgrst, 'reload schema';
