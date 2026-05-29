-- 0041 — Atlas: auto profile-snapshot on business edit.
--
-- A third Atlas snapshot knob on app_settings, distinct from the two
-- research knobs (0022 pre-read, 0040 save). This one is about PROFILE
-- snapshots (snapshots/mesita/), not research:
--
--   atlas_snapshot_on_business_edit — when true, every time a business user
--                                     updates their venue, Atlas saves a
--                                     profile snapshot of the resulting
--                                     public.venues state (edit history).
--
-- The manual "back up all venues" trigger (admin-snapshot-mesita) stays as a
-- separate, on-demand bulk operation. This flag governs the automatic,
-- per-venue snapshot taken on each business edit.

alter table public.app_settings
  add column if not exists atlas_snapshot_on_business_edit boolean not null default true;

comment on column public.app_settings.atlas_snapshot_on_business_edit is
  'Atlas: when true, a profile snapshot (snapshots/mesita/) is saved automatically whenever a business user updates their venue. Distinct from the manual bulk back-up and from the research snapshots.';

notify pgrst, 'reload schema';
