-- 0047 — Atlas tiers are now T1-T4 (no T5).
--
-- The pipeline only has four tiers; the highest node is T4 (SERP/OpenTable/
-- TripAdvisor Contents). Clamp any stored ceiling above 4, then tighten the
-- range constraint from 1-5 to 1-4.

update public.app_settings
  set atlas_source_tier_ceiling = 4
  where atlas_source_tier_ceiling > 4;

alter table public.app_settings
  drop constraint if exists app_settings_atlas_source_tier_ceiling_range;

alter table public.app_settings
  add constraint app_settings_atlas_source_tier_ceiling_range
  check (atlas_source_tier_ceiling between 1 and 4);

notify pgrst, 'reload schema';
