-- 0055 — Atlas: separate PRE-SELECTION (save) caps from ANALYSIS caps.
--
-- Two distinct parameter sets per image source:
--   SAVE (pre-selection): how many images we pull + store on the venue.
--     atlas_save_google_images     (0-10, default 10) — Places default order
--     atlas_save_website_images    (0-10, default 10) — from crawled pages
--     atlas_save_instagram_images  (0-30, default 20) — top by likes
--     (atlas_research_instagram_posts = IG posts pool; atlas_website_crawl_max_pages = website pool)
--   ANALYZE (vision): how many of the SAVED images go to AI vision (<= save).
--     atlas_analyze_google_images     (exists)
--     atlas_analyze_website_images    (re-added here)
--     atlas_analyze_instagram_images  (exists)
--
-- You do NOT vision-analyze every saved image — analysis is the expensive
-- step, so its caps are independent and usually smaller.

alter table public.app_settings
  add column if not exists atlas_save_google_images smallint not null default 10,
  add column if not exists atlas_save_website_images smallint not null default 10,
  add column if not exists atlas_save_instagram_images smallint not null default 20,
  add column if not exists atlas_analyze_website_images smallint not null default 5;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_save_google_images_range') then
    alter table public.app_settings add constraint app_settings_atlas_save_google_images_range
      check (atlas_save_google_images between 0 and 10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_save_website_images_range') then
    alter table public.app_settings add constraint app_settings_atlas_save_website_images_range
      check (atlas_save_website_images between 0 and 10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_save_instagram_images_range') then
    alter table public.app_settings add constraint app_settings_atlas_save_instagram_images_range
      check (atlas_save_instagram_images between 0 and 30);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_analyze_website_images_range') then
    alter table public.app_settings add constraint app_settings_atlas_analyze_website_images_range
      check (atlas_analyze_website_images between 0 and 10);
  end if;
end$$;

notify pgrst, 'reload schema';
