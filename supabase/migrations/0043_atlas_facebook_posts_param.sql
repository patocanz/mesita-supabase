-- 0043 — Atlas research param: Facebook posts & images.
--
-- Clarifies the social-source depth model: Instagram and Facebook yield
-- follower count + posts/images only — NEITHER has reviews. Google is the
-- only source with both photos and reviews. So the depth caps are:
--   atlas_research_google_images      (0040) — Google photos
--   atlas_research_google_reviews     (0042) — Google reviews
--   atlas_research_instagram_posts    (0040) — IG posts & images
--   atlas_research_facebook_posts     (this) — FB posts & images  ← new
--
-- No instagram/facebook "reviews" param exists because those sources have
-- no reviews.

alter table public.app_settings
  add column if not exists atlas_research_facebook_posts smallint not null default 12;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'app_settings_atlas_research_facebook_posts_range'
  ) then
    alter table public.app_settings
      add constraint app_settings_atlas_research_facebook_posts_range
      check (atlas_research_facebook_posts between 0 and 50);
  end if;
end$$;

comment on column public.app_settings.atlas_research_facebook_posts is
  'Atlas research param: number of Facebook posts/images to pull per venue (0-50). Facebook has no reviews; it yields follower count + posts/images only.';

notify pgrst, 'reload schema';
