-- 0015_split_auto_verify.sql
-- Splits the single `app_settings.auto_verify_venues` switch into two
-- per-method flags so the admin can govern phone vs. video independently:
--
--   auto_verify_ai_call   true by default — picking up the phone and
--                         reading the 6-digit code grants ownership on
--                         the spot. If an admin turns this off, the
--                         correct code is still accepted but the row
--                         lands in the admin queue tagged "code verified,
--                         awaiting manual approval" via a payload
--                         timestamp.
--
--   auto_verify_video     false by default — a posted video URL never
--                         auto-grants ownership; it's queued for human
--                         review. Admin may flip this on for trusted
--                         operators or stress-testing.
--
-- In practice the admin queue is video-only (phone is auto-confirm by
-- default). The old combined `auto_verify_venues` column is dropped;
-- existing value is migrated into the video flag since that's the
-- one it was effectively gating.

alter table public.app_settings
  add column if not exists auto_verify_ai_call boolean not null default true,
  add column if not exists auto_verify_video   boolean not null default false;

-- Preserve whatever the deployment already had: if auto_verify_venues
-- was on, the video path was the auto-approve path (ai_call always
-- ignored it), so carry that over to the video flag.
update public.app_settings
   set auto_verify_video = auto_verify_venues
 where id = 1
   and auto_verify_venues is not null;

alter table public.app_settings
  drop column if exists auto_verify_venues;
