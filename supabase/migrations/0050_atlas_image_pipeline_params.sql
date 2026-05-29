-- 0050 — Atlas image-pipeline params (additive part).
--
-- New 3-stage image funnel:
--   Pre-selection (gather + rank): Google = Places default 10 (fixed);
--     Website = all images on X1 crawled pages, ranked tallest->least;
--     Instagram = images from X2 posts (images only), ranked by likes.
--   Selection (save to Supabase, FIXED caps): Google 10 / Website 10 /
--     Instagram 20 = 40 saved; hard ceiling 50/venue. (constants, not params)
--   Analysis (vision, per-source): first X3 Google / X4 Website / X5 Instagram,
--     then AI sorts best->worst.
--
-- Five params: X1 = atlas_website_crawl_max_pages (existing), X2 =
-- atlas_research_instagram_posts (existing, now "max posts per profile"),
-- X3/X4/X5 = the new per-source vision-analysis caps below.
--
-- This migration is additive (add X3/X4/X5, bump X2 default). The replaced
-- columns (atlas_research_google_images, atlas_max_images_analyzed) are
-- dropped in 0051 AFTER the EFs stop referencing them.

alter table public.app_settings
  add column if not exists atlas_analyze_google_images smallint not null default 5,
  add column if not exists atlas_analyze_website_images smallint not null default 5,
  add column if not exists atlas_analyze_instagram_images smallint not null default 10;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_analyze_google_images_range') then
    alter table public.app_settings add constraint app_settings_atlas_analyze_google_images_range
      check (atlas_analyze_google_images between 0 and 10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_analyze_website_images_range') then
    alter table public.app_settings add constraint app_settings_atlas_analyze_website_images_range
      check (atlas_analyze_website_images between 0 and 10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_analyze_instagram_images_range') then
    alter table public.app_settings add constraint app_settings_atlas_analyze_instagram_images_range
      check (atlas_analyze_instagram_images between 0 and 20);
  end if;
end$$;

-- X2 is now "Instagram max posts per profile" — needs a wider pool than the
-- old default (12) to rank the top-20 IG images by likes. Default -> 30.
alter table public.app_settings
  alter column atlas_research_instagram_posts set default 30;
update public.app_settings
  set atlas_research_instagram_posts = 30
  where atlas_research_instagram_posts = 12;

comment on column public.app_settings.atlas_analyze_google_images is
  'X3 — Google images sent to vision (0-10). Selection saves 10; analyze the first X3.';
comment on column public.app_settings.atlas_analyze_website_images is
  'X4 — Website images sent to vision (0-10). Selection saves 10; analyze the first X4.';
comment on column public.app_settings.atlas_analyze_instagram_images is
  'X5 — Instagram images sent to vision (0-20). Selection saves 20; analyze the first X5.';
comment on column public.app_settings.atlas_research_instagram_posts is
  'X2 — Instagram max posts per profile pulled by Apify (images extracted + ranked by likes).';

notify pgrst, 'reload schema';
