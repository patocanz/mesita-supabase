-- 0033 — membership_tiers lookup table.
--
-- "Model richly, expose simply": we ship two consumer tiers (free / premium)
-- but keep N-tier capability in the schema. Per-tier config (follower
-- threshold for the Instagram door, monthly reservation cap, subscription
-- price, recommendation weight, Stripe price id) lives here as data, so
-- adding a future tier is an INSERT, not a migration.
--
-- Config is non-secret, so the table is world-readable; writes are
-- service-role only (no write policy + RLS on).

create table public.membership_tiers (
  key                       text primary key,
  label                     text     not null,
  rank                      smallint not null unique,
  -- Instagram follower count that unlocks this tier via the IG door.
  -- null = not reachable through the Instagram door.
  follower_threshold        integer,
  -- Max reservations a guest at this tier may create per calendar month.
  -- null = unlimited.
  monthly_reservation_limit integer,
  -- Monthly subscription price for the paid door. 0 = not purchasable.
  price_cents               integer  not null default 0,
  currency                  text     not null default 'MXN',
  -- Stripe recurring Price id backing the paid door. Set in Phase C.
  stripe_price_id           text,
  -- Personalization weight applied in the recommender ranking. Higher =
  -- stronger partner-first / tighter personalization for this tier.
  recommendation_weight     real     not null default 1.0,
  created_at                timestamptz not null default now()
);

insert into public.membership_tiers
  (key, label, rank, follower_threshold, monthly_reservation_limit, price_cents, currency, stripe_price_id, recommendation_weight)
values
  ('free',    'Free',    0, null, 2,    0,     'MXN', null, 1.0),
  ('premium', 'Premium', 1, 1000, null, 20000, 'MXN', null, 1.5);

alter table public.membership_tiers enable row level security;

create policy membership_tiers_select_all on public.membership_tiers
  for select using (true);

grant select on public.membership_tiers to anon, authenticated;

notify pgrst, 'reload schema';
