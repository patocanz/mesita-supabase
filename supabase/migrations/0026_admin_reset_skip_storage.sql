-- 0026_admin_reset_skip_storage.sql
--
-- Supabase now blocks direct DELETE on storage.objects from SQL —
-- "Direct deletion from storage tables is not allowed. Use the Storage
-- API instead." The previous admin_reset_database() body included
--
--   delete from storage.objects where bucket_id = 'atlas';
--
-- which now raises and aborts the whole reset transaction before any
-- truncate lands.
--
-- This migration rewrites admin_reset_database() to skip the storage
-- step entirely. Atlas snapshot/photo objects in the `atlas` bucket
-- survive a reset; they're tied to (venue_id, request_id) paths and
-- nothing in the wiped tables references them by FK, so leftovers are
-- inert. If we ever want a clean storage wipe again, do it from an
-- Edge Function via supabase-js (which calls the Storage REST API),
-- not from inside a postgres function.

CREATE OR REPLACE FUNCTION public.admin_reset_database()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
declare
  deleted_users bigint;
begin
  -- 1. Wipe operational data. CASCADE clears FK-dependents and
  --    RESTART IDENTITY resets sequences. super_admins and app_settings
  --    are deliberately omitted (config singleton + founder allowlist).
  truncate table
    public.cashback_ledger,
    public.tickets,
    public.venue_verifications,
    public.business_invites,
    public.staff_invites,
    public.venue_roles,
    public.venue_members,
    public.venues,
    public.consumers,
    public.businesses
  restart identity cascade;

  -- 2. Drop every auth.user that isn't a super-admin. Anyone with no
  --    email (consumers/staff sign in by phone) is removed; emailed
  --    accounts are kept only if their lowercased email is in
  --    super_admins.
  delete from auth.users u
  where u.email is null
     or lower(u.email) not in (
       select lower(email) from public.super_admins
     );
  get diagnostics deleted_users = row_count;

  -- 3. Storage NOT touched (see header). Atlas leftovers are inert.

  return jsonb_build_object(
    'ok', true,
    'deleted_auth_users', deleted_users,
    'reset_at', now()
  );
end;
$function$;

-- Service-role only.
REVOKE ALL ON FUNCTION public.admin_reset_database() FROM public;
REVOKE ALL ON FUNCTION public.admin_reset_database() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reset_database() TO service_role;
