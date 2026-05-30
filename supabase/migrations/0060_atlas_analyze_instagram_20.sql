-- 0060 — Atlas: widen the Instagram ANALYZE cap to 20.
--
-- Gather pulls up to 30 IG posts, so allowing up to 20 of them through the
-- vision pass is reasonable (Google/Website stay ≤10 — smaller candidate sets).

alter table public.app_settings
  drop constraint if exists app_settings_atlas_analyze_instagram_images_range;
alter table public.app_settings
  add constraint app_settings_atlas_analyze_instagram_images_range
    check (atlas_analyze_instagram_images between 0 and 20);

notify pgrst, 'reload schema';
