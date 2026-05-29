-- 0058 — Atlas: redo the image funnel param model.
--
-- New funnel:
--   GATHER (≤10 per source) → METADATA SORT (Google = Google's order,
--   Website = by image size, Instagram = by likes) → ANALYZE (vision, ≤10 per
--   source) → RUBRIC SORT (text model) → SAVE one source-independent cap (≤20).
--
-- This replaces the old per-source SAVE caps (Google/Website/Instagram) and the
-- separate IG-posts pool with: explicit GATHER caps per source + a single SAVE
-- cap applied to the final ranked set regardless of source. Tightens the
-- analyze caps to ≤10 each. Goal: far less junk enters the venue.

-- 1. New gather caps + single save-total.
alter table public.app_settings
  add column if not exists atlas_gather_google_images   smallint not null default 10,
  add column if not exists atlas_gather_website_images  smallint not null default 10,
  add column if not exists atlas_gather_instagram_posts smallint not null default 10,
  add column if not exists atlas_save_total_images      smallint not null default 20;

-- Carry forward sensible values from the columns we're about to drop.
update public.app_settings set
  atlas_gather_google_images   = least(coalesce(atlas_save_google_images, 10), 10),
  atlas_gather_website_images  = least(coalesce(atlas_save_website_images, 10), 10),
  atlas_gather_instagram_posts = least(coalesce(atlas_research_instagram_posts, 10), 10);

-- 2. Tighten analyze caps to ≤10 each, default 10.
update public.app_settings set
  atlas_analyze_google_images    = least(atlas_analyze_google_images, 10),
  atlas_analyze_website_images   = least(atlas_analyze_website_images, 10),
  atlas_analyze_instagram_images = least(atlas_analyze_instagram_images, 10);
alter table public.app_settings
  drop constraint if exists app_settings_atlas_analyze_instagram_images_range;
alter table public.app_settings
  add constraint app_settings_atlas_analyze_instagram_images_range
    check (atlas_analyze_instagram_images between 0 and 10);
alter table public.app_settings
  alter column atlas_analyze_google_images    set default 10,
  alter column atlas_analyze_website_images   set default 10,
  alter column atlas_analyze_instagram_images set default 10;

-- 3. Range checks for the new caps.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_gather_google_images_range') then
    alter table public.app_settings add constraint app_settings_atlas_gather_google_images_range
      check (atlas_gather_google_images between 0 and 10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_gather_website_images_range') then
    alter table public.app_settings add constraint app_settings_atlas_gather_website_images_range
      check (atlas_gather_website_images between 0 and 10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_gather_instagram_posts_range') then
    alter table public.app_settings add constraint app_settings_atlas_gather_instagram_posts_range
      check (atlas_gather_instagram_posts between 0 and 10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_save_total_images_range') then
    alter table public.app_settings add constraint app_settings_atlas_save_total_images_range
      check (atlas_save_total_images between 0 and 20);
  end if;
end$$;

-- 4. Drop the replaced per-source SAVE caps + the IG-posts pool.
alter table public.app_settings
  drop column if exists atlas_save_google_images,
  drop column if exists atlas_save_website_images,
  drop column if exists atlas_save_instagram_images,
  drop column if exists atlas_research_instagram_posts;

notify pgrst, 'reload schema';
