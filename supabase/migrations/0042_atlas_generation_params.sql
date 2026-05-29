-- 0042 — Atlas profile-generation params on app_settings.
--
-- Operator-tunable knobs for venue profile generation, surfaced on the admin
-- console's Atlas → Configuration page and grouped by pipeline stage
-- (Sourcing → Data → Analysis). These are the SINGLE SOURCE OF TRUTH: the
-- Atlas agent reads them at run time, and any caller (admin or business) that
-- triggers enrichment without specifying params gets these DB defaults. No
-- frontend holds defaults.
--
--   Sourcing
--     atlas_source_tier_ceiling      — run sources whose tier <= ceiling (1..5)
--     atlas_source_overrides         — per-source on/off exceptions to the tier
--                                      rule, { "<source_key>": bool }
--     atlas_serp_only_when_thin      — only reach for SERP/Perplexity grounding
--                                      when Google came back sparse
--   Data depth (google_images + instagram_posts already exist from 0040)
--     atlas_google_reviews           — Google reviews to keep (Google caps at 5)
--     atlas_website_crawl_max_pages  — Firecrawl crawl depth
--     atlas_reviews_per_site         — reviews per review-site (TripAdvisor/Yelp)
--   Analysis
--     atlas_image_vision_enabled     — run the (expensive) vision pass at all
--     atlas_max_images_analyzed      — hard cap on images sent to vision
--     atlas_per_source_ai_summary    — summarize each source before synthesis
--     atlas_synthesis_quality        — economy | standard | high (model tier)
--     atlas_per_run_cost_cap_usd     — hard ceiling per venue enrichment run

alter table public.app_settings
  add column if not exists atlas_source_tier_ceiling smallint not null default 3,
  add column if not exists atlas_source_overrides jsonb not null default '{}'::jsonb,
  add column if not exists atlas_serp_only_when_thin boolean not null default true,
  add column if not exists atlas_google_reviews smallint not null default 5,
  add column if not exists atlas_website_crawl_max_pages smallint not null default 5,
  add column if not exists atlas_reviews_per_site smallint not null default 10,
  add column if not exists atlas_image_vision_enabled boolean not null default true,
  add column if not exists atlas_max_images_analyzed smallint not null default 20,
  add column if not exists atlas_per_source_ai_summary boolean not null default true,
  add column if not exists atlas_synthesis_quality text not null default 'economy',
  add column if not exists atlas_per_run_cost_cap_usd numeric(8,2) not null default 1.00;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_source_tier_ceiling_range') then
    alter table public.app_settings add constraint app_settings_atlas_source_tier_ceiling_range
      check (atlas_source_tier_ceiling between 1 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_google_reviews_range') then
    alter table public.app_settings add constraint app_settings_atlas_google_reviews_range
      check (atlas_google_reviews between 0 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_website_crawl_max_pages_range') then
    alter table public.app_settings add constraint app_settings_atlas_website_crawl_max_pages_range
      check (atlas_website_crawl_max_pages between 1 and 20);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_reviews_per_site_range') then
    alter table public.app_settings add constraint app_settings_atlas_reviews_per_site_range
      check (atlas_reviews_per_site between 0 and 30);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_max_images_analyzed_range') then
    alter table public.app_settings add constraint app_settings_atlas_max_images_analyzed_range
      check (atlas_max_images_analyzed between 0 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_synthesis_quality_values') then
    alter table public.app_settings add constraint app_settings_atlas_synthesis_quality_values
      check (atlas_synthesis_quality in ('economy', 'standard', 'high'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_atlas_per_run_cost_cap_usd_range') then
    alter table public.app_settings add constraint app_settings_atlas_per_run_cost_cap_usd_range
      check (atlas_per_run_cost_cap_usd >= 0);
  end if;
end$$;

notify pgrst, 'reload schema';
