-- 0021_admin_reset_include_manager_invites.sql
-- Re-issue admin_reset_database() so manager_invites (added in 0020) is
-- enumerated explicitly in the truncate list.
--
-- The function already cleared manager_invites transitively because of
-- the venue_id ON DELETE CASCADE FK, but the convention in this function
-- is to list every operational table by name — that way the wipe stays
-- self-documenting and survives any future FK refactor that might break
-- the implicit cascade chain.
--
-- Preserved tables remain:
--   * public.super_admins   — founder allowlist
--   * public.app_settings   — config singleton (auto-verify flags)
--
-- Auth users without a super-admin email are still deleted at the end.

create or replace function public.admin_reset_database()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  deleted_users bigint;
begin
  -- 1. Wipe operational data. Every operational table created through
  --    migration 0020 is listed explicitly, even when a CASCADE from
  --    venues would clear it transitively.
  truncate table
    public.cashback_ledger,
    public.tickets,
    public.venue_verifications,
    public.staff_invites,
    public.manager_invites,
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

-- Re-assert the grant chain so it stays explicit in migration history.
revoke all on function public.admin_reset_database() from public;
revoke all on function public.admin_reset_database() from anon, authenticated;
grant execute on function public.admin_reset_database() to service_role;
