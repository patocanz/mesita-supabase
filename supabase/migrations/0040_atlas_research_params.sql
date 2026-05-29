-- 0040 — Atlas research configuration on app_settings.
--
-- Extends the app_settings singleton with operator-tunable Atlas knobs,
-- surfaced on the admin console's Atlas → Configuration page:
--
--   atlas_save_snapshots          — when true, every venue research run is
--                                   saved as a new snapshot in Storage
--                                   (append-only history). When false, runs
--                                   are not persisted. (Distinct from
--                                   atlas_pre_read_snapshots, which only
--                                   gates the READ side.)
--   atlas_research_google_images  — how many Google photos to pull per venue.
--   atlas_research_instagram_posts— how many Instagram posts to scrape per
--                                   venue (consumed once the IG-posts source
--                                   ships).
--
-- All non-null with defaults so the existing singleton row reads sane values
-- immediately and a reset (which does not touch app_settings) keeps them.

alter table public.app_settings
  add column if not exists atlas_save_snapshots boolean not null default true;

alter table public.app_settings
  add column if not exists atlas_research_google_images smallint not null default 10;

alter table public.app_settings
  add column if not exists atlas_research_instagram_posts smallint not null default 12;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'app_settings_atlas_research_google_images_range'
  ) then
    alter table public.app_settings
      add constraint app_settings_atlas_research_google_images_range
      check (atlas_research_google_images between 0 and 20);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'app_settings_atlas_research_instagram_posts_range'
  ) then
    alter table public.app_settings
      add constraint app_settings_atlas_research_instagram_posts_range
      check (atlas_research_instagram_posts between 0 and 50);
  end if;
end$$;

comment on column public.app_settings.atlas_save_snapshots is
  'Atlas: when true, every venue research run is saved as a new Storage snapshot (append-only). Gates the WRITE side; atlas_pre_read_snapshots gates the READ side.';
comment on column public.app_settings.atlas_research_google_images is
  'Atlas research param: number of Google photos to pull per venue (0-20).';
comment on column public.app_settings.atlas_research_instagram_posts is
  'Atlas research param: number of Instagram posts to scrape per venue (0-50).';

notify pgrst, 'reload schema';
