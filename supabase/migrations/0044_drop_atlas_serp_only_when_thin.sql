-- 0044 — drop redundant atlas_serp_only_when_thin.
--
-- SERP is now gated purely by the source tier ceiling (SERP Contents = T5,
-- SERP AI summary = T3). A separate "only when Google is thin" flag was
-- double-specification — if the tier is enabled, SERP runs. Removed from the
-- admin console + settings EFs; this drops the now-unused column.

alter table public.app_settings
  drop column if exists atlas_serp_only_when_thin;

notify pgrst, 'reload schema';
