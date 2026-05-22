-- 0019_venue_segmentation_toggles.sql
-- Promos page's Basic / Advanced sections each carry an on/off toggle.
-- They were UI-only state until now (reset on every page reload), which
-- defeats the point of being able to disable a section the venue isn't
-- using. Persist them on the venues row so the toggle actually sticks.
--
-- Defaults match the frontend's initial useState() values:
--   - Basic    → true  (manager landing on Promos sees the full
--                      Welcome + tier-rate configurator)
--   - Advanced → false ("coming soon" panel stays out of the way until
--                      the manager explicitly opts in)
--
-- NOT NULL with defaults so existing rows backfill automatically and
-- the EFs never have to think about a null state.

alter table public.venues
  add column segmentation_basic_enabled    boolean not null default true,
  add column segmentation_advanced_enabled boolean not null default false;

comment on column public.venues.segmentation_basic_enabled is
  'Manager-controlled toggle for the Basic Promos section on /promos. True = section body (Welcome coupon + per-tier rates) renders; false = collapsed to just the header.';
comment on column public.venues.segmentation_advanced_enabled is
  'Manager-controlled toggle for the Advanced Promos section on /promos. Defaults off — most venues won''t touch the demographic / community / geo rules and the "coming soon" panel shouldn''t dominate their first impression.';
