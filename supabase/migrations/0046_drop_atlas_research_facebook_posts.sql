-- 0046 — drop atlas_research_facebook_posts.
--
-- The Atlas restructure removed Facebook's posts entirely: Facebook is now
-- Link + Profile only (followers + rating), no Posts/Contents node — nobody
-- actively uses Facebook. So the "Max Facebook posts & images" depth param
-- has nothing to control. Removed from the admin console + settings EFs;
-- this drops the column.

alter table public.app_settings
  drop column if exists atlas_research_facebook_posts;

notify pgrst, 'reload schema';
