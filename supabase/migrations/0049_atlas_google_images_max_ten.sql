-- 0049 — Google images cap is 0-10 (Places API default order).
--
-- Google image pre-selection now comes straight from the Places API's
-- default photo order (Google's own ranking), which returns at most 10
-- photos per place. So the cap can never exceed 10. Clamp any stored value
-- above 10 and tighten the constraint from 0-20 to 0-10.

update public.app_settings
  set atlas_research_google_images = 10
  where atlas_research_google_images > 10;

alter table public.app_settings
  drop constraint if exists app_settings_atlas_research_google_images_range;

alter table public.app_settings
  add constraint app_settings_atlas_research_google_images_range
  check (atlas_research_google_images between 0 and 10);

comment on column public.app_settings.atlas_research_google_images is
  'Atlas research param: number of Google photos to pull per venue (0-10), taken from the Places API default photo order (Google''s own ranking).';

notify pgrst, 'reload schema';
