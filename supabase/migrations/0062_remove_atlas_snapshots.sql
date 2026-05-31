-- 0062 — Remove Atlas snapshots entirely.
--
-- Snapshots (both the research pre-read/cache in `atlas-snapshots` and the
-- Mesita profile .txt dumps in `atlas`) are gone. The enrichment pipeline
-- now always fetches fresh and never persists a research snapshot, so the
-- three app_settings toggles and the public-read media policy are dead.
-- This reverses parts of 0022 (foundation), 0040, and 0041.
--
-- Storage teardown is NOT done here. Supabase guards storage.objects and
-- storage.buckets with statement-level protect_delete triggers, so those rows
-- cannot be removed via SQL (the same reason 0026 pulled storage deletion out
-- of admin_reset_database). The two snapshot buckets (`atlas`, `atlas-snapshots`)
-- and their objects are emptied + dropped out-of-band through the Storage API.
-- The `venue-images` bucket (0057, the live gallery) is left untouched.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Drop the Atlas snapshot toggles from app_settings
-- ─────────────────────────────────────────────────────────────────────
alter table public.app_settings
  drop column if exists atlas_pre_read_snapshots,
  drop column if exists atlas_save_snapshots,
  drop column if exists atlas_snapshot_on_business_edit;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Drop the atlas media read policy (from 0022)
-- ─────────────────────────────────────────────────────────────────────
drop policy if exists "atlas: public read media" on storage.objects;

notify pgrst, 'reload schema';
