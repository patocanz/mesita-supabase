-- 0031_c — extend admin_reset_database() to wipe the new entities.
--
-- Per the super-admin-reset-fn memory rule: every architectural change
-- must update this function so a fresh-environment rebuild includes the
-- new tables. Without this entry, `admin-reset-database` would leave
-- stale rows in reservations / coupons / saved_venues after a reset and
-- the next test session would inherit them.
--
-- Truncate order doesn't matter when CASCADE is used, but listing the
-- new tables at the top before the legacy tickets makes the intent
-- obvious in the diff.

create or replace function public.admin_reset_database()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'auth'
as $function$
declare
  deleted_users bigint;
begin
  truncate table
    public.reservations,
    public.coupons,
    public.saved_venues,
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
$function$;
