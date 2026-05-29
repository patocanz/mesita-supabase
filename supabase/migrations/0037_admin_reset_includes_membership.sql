-- 0037 — extend admin_reset_database() for the membership entities.
--
-- Per the super-admin-reset rule: a reset must rebuild a clean working
-- environment. Two new operational tables (consumer_subscriptions,
-- stripe_events) get truncated. membership_tiers is config (like
-- app_settings / super_admins) so it is NOT truncated — instead it is
-- re-seeded idempotently so a reset always leaves Free + Premium present.
-- Wiped consumers come back 'free' via the column default.

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
    public.consumer_subscriptions,
    public.stripe_events,
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

  -- Re-seed membership config so a fresh env always has both tiers.
  insert into public.membership_tiers
    (key, label, rank, follower_threshold, monthly_reservation_limit, price_cents, currency, recommendation_weight)
  values
    ('free',    'Free',    0, null, 2,    0,     'MXN', 1.0),
    ('premium', 'Premium', 1, 1000, null, 20000, 'MXN', 1.5)
  on conflict (key) do update set
    label                     = excluded.label,
    rank                      = excluded.rank,
    follower_threshold        = excluded.follower_threshold,
    monthly_reservation_limit = excluded.monthly_reservation_limit,
    price_cents               = excluded.price_cents,
    currency                  = excluded.currency,
    recommendation_weight     = excluded.recommendation_weight;

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
