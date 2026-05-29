-- 0059 — Atlas: widen the Instagram GATHER cap to 30.
--
-- Instagram is the one source where a deeper pull pays off: we pull N posts,
-- keep one photo each, sort by likes, then analyze/save the best. A bigger pool
-- (≤30) gives the like-ranking more to choose from. Google/Website stay ≤10
-- (their candidate sets are smaller and lower-variance).

alter table public.app_settings
  drop constraint if exists app_settings_atlas_gather_instagram_posts_range;
alter table public.app_settings
  add constraint app_settings_atlas_gather_instagram_posts_range
    check (atlas_gather_instagram_posts between 0 and 30);

notify pgrst, 'reload schema';
