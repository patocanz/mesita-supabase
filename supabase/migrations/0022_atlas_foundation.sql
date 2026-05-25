-- 0022_atlas_foundation.sql
-- Foundation for Mesita Atlas — the venue profile research & enrichment
-- subsystem that lives inside this Supabase project (Path A from the
-- intelligence-microapp memory). No new tables — Atlas state lives in
-- Supabase Storage as text files per venue. Two additions here:
--
--   1. Extend public.app_settings with the single Atlas toggle
--      (atlas_pre_read_snapshots). When ON, the venue research EFs read
--      prior snapshots with an LLM before fetching anything new; when
--      OFF, they always fetch from scratch. Snapshots are written EITHER
--      WAY — the toggle only gates the pre-read.
--
--   2. Create the `atlas` Supabase Storage bucket with path-based RLS:
--        venues/{venue_id}/media/*       → public-read (CDN-served)
--        venues/{venue_id}/snapshots/**  → service-role only
--      Snapshot subfolders:
--        snapshots/research/  — external API research history (.txt)
--        snapshots/mesita/    — routine dumps of Core's venue profile (.txt)
--
-- The admin reset function (admin_reset_database) is updated to also
-- nuke all objects in the atlas bucket, so a reset rebuilds a clean
-- working environment per the super-admin-reset-fn memory.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Atlas pre-read toggle on app_settings
-- ─────────────────────────────────────────────────────────────────────

alter table public.app_settings
  add column if not exists atlas_pre_read_snapshots boolean not null default true;

comment on column public.app_settings.atlas_pre_read_snapshots is
  'Atlas behavior: when true, EFs read prior snapshots with an LLM before fetching; when false, every research call fetches from scratch. Snapshots are saved EITHER WAY.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Atlas Storage bucket
-- ─────────────────────────────────────────────────────────────────────

-- Bucket is private at the bucket level; individual paths are opened up
-- via RLS policies below. This means anything not explicitly allowed by
-- a policy is denied to anon/authenticated; service role bypasses RLS.
insert into storage.buckets (id, name, public)
values ('atlas', 'atlas', false)
on conflict (id) do nothing;

-- Public SELECT on media files. Pattern:
--   venues/<venue_id>/media/<filename>
-- Anyone (including unauthenticated guests) can fetch the URL — these
-- are the photos served in the guest app. The image bytes ride the
-- standard Supabase Storage CDN with no auth header required.
create policy "atlas: public read media"
  on storage.objects
  for select
  to public
  using (
    bucket_id = 'atlas'
    and name ~ '^venues/[^/]+/media/'
  );

-- Snapshots (research/* and mesita/*) have NO public-readable policy.
-- Absence of a SELECT policy => RLS denies all anon/authenticated reads;
-- service-role (used by Edge Functions) bypasses RLS and can read freely.
-- No additional policy needed; we intentionally do NOT create one for
-- the snapshots path so default deny applies.

-- ─────────────────────────────────────────────────────────────────────
-- 3. Update admin_reset_database to also wipe the atlas bucket
-- ─────────────────────────────────────────────────────────────────────
-- Atlas Storage contents are operational data (per-venue research +
-- snapshots). A reset should bring the environment back to "clean
-- working state" per the super-admin-reset-fn rule, which means clearing
-- atlas/ along with the wiped DB rows.

create or replace function public.admin_reset_database()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, storage
as $$
declare
  deleted_users     bigint;
  deleted_atlas     bigint;
begin
  -- 1. Wipe operational data. CASCADE clears FK-dependents and
  --    RESTART IDENTITY resets sequences. super_admins and app_settings
  --    are deliberately omitted (config singleton + founder allowlist).
  truncate table
    public.cashback_ledger,
    public.tickets,
    public.venue_verifications,
    public.manager_invites,
    public.staff_invites,
    public.venue_roles,
    public.venue_members,
    public.venues,
    public.guests,
    public.managers
  restart identity cascade;

  -- 2. Drop every auth.user that isn't a super-admin.
  delete from auth.users u
  where u.email is null
     or lower(u.email) not in (
       select lower(email) from public.super_admins
     );
  get diagnostics deleted_users = row_count;

  -- 3. Nuke the atlas Storage bucket (research snapshots, mesita
  --    snapshots, media files). The bucket itself stays.
  delete from storage.objects where bucket_id = 'atlas';
  get diagnostics deleted_atlas = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_auth_users', deleted_users,
    'deleted_atlas_objects', deleted_atlas,
    'reset_at', now()
  );
end;
$$;

revoke all on function public.admin_reset_database() from public;
revoke all on function public.admin_reset_database() from anon, authenticated;
grant execute on function public.admin_reset_database() to service_role;
