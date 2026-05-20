-- 0016_admin_reset_database.sql
-- Destructive full reset for dev/staging.
--
-- Wipes every operational table while PRESERVING:
--   * public.super_admins   — the founder allowlist (the "except super
--                             admins" requirement)
--   * public.app_settings   — the config singleton (auto-verify flags)
--
-- It also deletes every auth.users row that isn't a super-admin so the
-- auth pool doesn't drift out of sync with the (now-empty) profile
-- tables. Guests (phone, no email) and managers go; the founder admin
-- accounts listed in super_admins stay so you can't lock yourself out.
--
-- This function is the only place the wipe lives. It is invoked solely
-- by the admin-reset-database Edge Function (service role), which gates
-- on super_admins + a typed confirmation phrase. Execute is revoked from
-- anon/authenticated so no client can ever reach it directly.

create or replace function public.admin_reset_database()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  deleted_users bigint;
begin
  -- 1. Wipe operational data. CASCADE clears FK-dependents and
  --    RESTART IDENTITY resets sequences. super_admins and app_settings
  --    are deliberately omitted.
  truncate table
    public.cashback_ledger,
    public.tickets,
    public.venue_verifications,
    public.staff_invites,
    public.venue_roles,
    public.venue_members,
    public.venues,
    public.guests,
    public.managers
  restart identity cascade;

  -- 2. Drop every auth.user that isn't a super-admin. Anyone with no
  --    email (guests/staff sign in by phone) is removed; emailed
  --    accounts are kept only if their lowercased email is in
  --    super_admins.
  delete from auth.users u
  where u.email is null
     or lower(u.email) not in (
       select lower(email) from public.super_admins
     );
  get diagnostics deleted_users = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_auth_users', deleted_users,
    'reset_at', now()
  );
end;
$$;

-- Service-role only. Edge Functions run as service_role; anon +
-- authenticated are denied so there is no client-side path to a wipe.
revoke all on function public.admin_reset_database() from public;
revoke all on function public.admin_reset_database() from anon, authenticated;
grant execute on function public.admin_reset_database() to service_role;
