-- 0020_stripe_and_ledger.sql
--
-- Stripe Connect + Postgres-owned ledger foundation.
--
-- Money is moved by Stripe. State (who owes whom, what's pending, what's
-- closed-loop) is owned by Postgres. The ledger here is the source of
-- truth; Stripe is the rail. This separation is what lets Mesita Balance
-- be closed-loop (no payout method ever wired to a guest) and lets us
-- swap providers later without losing the ledger.
--
-- Tables introduced:
--   stripe_customers          — link Stripe Customer ↔ venue/guest
--   stripe_connect_accounts   — Express account per Formal venue
--   stripe_subscriptions      — venue Pro / guest Class active subs
--   stripe_webhook_events     — idempotency + replay log
--   guest_balances            — Mesita Balance, closed-loop (no payout)
--   venue_balances            — venue earnings held on Mesita platform
--   mesita_balance            — singleton platform revenue row
--   ledger_entries            — append-only audit log of every balance change

-- =========================
-- Stripe Customer linkage (guests + venues that pay Mesita)
-- =========================
-- One Customer per guest (for class Subscription) and one Customer per
-- venue (for Pro Subscription). A venue does NOT use this row for its
-- Connect Express account — that lives in stripe_connect_accounts.

create table public.stripe_customers (
  id                   uuid primary key default gen_random_uuid(),
  venue_id             uuid references public.venues(id) on delete cascade,
  guest_id             uuid references public.guests(id) on delete cascade,
  stripe_customer_id   text not null unique,
  created_at           timestamptz not null default now(),
  -- Exactly one owner per Customer row.
  constraint stripe_customers_owner_xor check (
    (venue_id is null) <> (guest_id is null)
  )
);
create index stripe_customers_venue_idx on public.stripe_customers (venue_id);
create index stripe_customers_guest_idx on public.stripe_customers (guest_id);

-- =========================
-- Stripe Connect Express accounts (one per Formal Verified Partner)
-- =========================
-- Mirrors the subset of Stripe's Account object that gates payouts.
-- Refreshed by webhook-receives-stripe-connect on account.updated.

create table public.stripe_connect_accounts (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null unique references public.venues(id) on delete cascade,
  stripe_account_id   text not null unique,
  charges_enabled     boolean not null default false,
  payouts_enabled     boolean not null default false,
  details_submitted   boolean not null default false,
  -- Raw requirements blob from Stripe so the UI can surface what the
  -- venue still needs to provide. Refreshed on every account.updated.
  requirements        jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger stripe_connect_accounts_set_updated_at
  before update on public.stripe_connect_accounts
  for each row execute function public.set_updated_at();

-- =========================
-- Stripe Subscriptions (venue Pro + guest Class)
-- =========================
-- Mirrors active subscriptions. `kind` is denormalised from the Price ID
-- so the UI doesn't have to look up which Stripe Price means which plan.

create type public.stripe_subscription_kind as enum (
  'venue_formal_pro',   -- MX$400 / mo, cashback mechanic
  'venue_informal_pro', -- MX$800 / mo, discount mechanic
  'guest_silver',       -- MX$200 / mo, grants Silver class
  'guest_gold',         -- MX$500 / mo, grants Gold class
  'guest_diamond'       -- MX$1000 / mo, grants Diamond class
);

create type public.stripe_subscription_status as enum (
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'paused'
);

create table public.stripe_subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  stripe_subscription_id   text not null unique,
  stripe_customer_id       text not null,
  venue_id                 uuid references public.venues(id) on delete set null,
  guest_id                 uuid references public.guests(id) on delete set null,
  kind                     public.stripe_subscription_kind not null,
  status                   public.stripe_subscription_status not null,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint stripe_subscriptions_owner_xor check (
    (venue_id is null) <> (guest_id is null)
  )
);
create trigger stripe_subscriptions_set_updated_at
  before update on public.stripe_subscriptions
  for each row execute function public.set_updated_at();
create index stripe_subscriptions_venue_idx  on public.stripe_subscriptions (venue_id);
create index stripe_subscriptions_guest_idx  on public.stripe_subscriptions (guest_id);
create index stripe_subscriptions_status_idx on public.stripe_subscriptions (status);

-- =========================
-- Stripe webhook event log (idempotency + replay)
-- =========================
-- Every incoming Stripe event lands here first. Webhook handlers no-op
-- if the event id already exists, so retries from Stripe are safe.

create table public.stripe_webhook_events (
  id                 uuid primary key default gen_random_uuid(),
  stripe_event_id    text not null unique,
  type               text not null,
  livemode           boolean not null,
  payload            jsonb not null,
  processed_at       timestamptz,
  processing_error   text,
  created_at         timestamptz not null default now()
);
create index stripe_webhook_events_type_idx       on public.stripe_webhook_events (type);
create index stripe_webhook_events_processed_idx  on public.stripe_webhook_events (processed_at)
  where processed_at is null;

-- =========================
-- guest_balances (closed-loop Mesita Balance)
-- =========================
-- One row per guest. Closed-loop: no payout method is ever wired. The
-- "no withdrawal" rule is enforced by the absence of any code path that
-- can move funds OUT of guest_balances to a bank — only to Mesita's
-- platform balance via cashback_redeem.
--
-- pending  → cashback held during story validation
-- available → ready to redeem at any Formal Verified Partner

create table public.guest_balances (
  guest_id          uuid primary key references public.guests(id) on delete cascade,
  available_cents   bigint not null default 0,
  pending_cents     bigint not null default 0,
  updated_at        timestamptz not null default now(),
  constraint guest_balances_nonneg check (available_cents >= 0 and pending_cents >= 0)
);
create trigger guest_balances_set_updated_at
  before update on public.guest_balances
  for each row execute function public.set_updated_at();

-- =========================
-- venue_balances (held on Mesita platform until released)
-- =========================
-- One row per Formal Verified Partner. Holds the venue's portion of each
-- bill on Mesita's Stripe platform balance until story validates and the
-- chargeback window closes; once available, the venue can withdraw via
-- a Stripe Transfer → Express account → Payout to bank.

create table public.venue_balances (
  venue_id          uuid primary key references public.venues(id) on delete cascade,
  available_cents   bigint not null default 0,
  pending_cents     bigint not null default 0,
  updated_at        timestamptz not null default now(),
  constraint venue_balances_nonneg check (available_cents >= 0 and pending_cents >= 0)
);
create trigger venue_balances_set_updated_at
  before update on public.venue_balances
  for each row execute function public.set_updated_at();

-- =========================
-- mesita_balance (singleton platform revenue)
-- =========================
-- One row. Holds Mesita's accumulated fees (platform fee on every bill,
-- subscription revenue) that the founder eventually withdraws to a bank.
-- Singleton invariant enforced by the check + a seed insert below.

create table public.mesita_balance (
  id                text primary key default 'mesita',
  available_cents   bigint not null default 0,
  updated_at        timestamptz not null default now(),
  constraint mesita_balance_singleton check (id = 'mesita'),
  constraint mesita_balance_nonneg    check (available_cents >= 0)
);
create trigger mesita_balance_set_updated_at
  before update on public.mesita_balance
  for each row execute function public.set_updated_at();
insert into public.mesita_balance (id) values ('mesita') on conflict do nothing;

-- =========================
-- ledger_entries (append-only audit log)
-- =========================
-- Every change to guest_balances / venue_balances / mesita_balance writes
-- one ledger_entry row. The aggregate tables are derivable from this log
-- (sum amount_cents grouped by owner + bucket), but we keep the running
-- totals materialised for fast reads. ledger_entries is the audit trail
-- for reconciliation against Stripe.

create type public.ledger_entry_kind as enum (
  -- Bill payment flow
  'bill_charge',             -- guest paid full bill into Mesita platform
  'cashback_earn_pending',   -- guest balance += cashback (held)
  'cashback_release',        -- guest pending → available (story validated)
  'cashback_redeem',         -- guest available → 0; funds applied to a bill
  'venue_earn_pending',      -- venue balance += (bill − fee − cashback) (held)
  'venue_earn_release',      -- venue pending → available
  'mesita_fee_earn',         -- mesita_balance += platform fee
  -- Payout flow
  'venue_transfer_out',      -- venue available → Stripe Express acct
  'mesita_payout_out',       -- mesita_balance → founder bank
  -- Subscription flow
  'venue_subscription_in',   -- mesita_balance += venue Pro charge
  'guest_subscription_in',   -- mesita_balance += guest Class charge
  -- Edge cases
  'refund',                  -- reverse a prior entry (links via metadata)
  'adjustment'               -- manual correction by an admin
);

create table public.ledger_entries (
  id                 uuid primary key default gen_random_uuid(),
  kind               public.ledger_entry_kind not null,
  -- Signed cents: positive = balance increased, negative = decreased.
  amount_cents       bigint not null,
  -- Which balance row this entry adjusts. Exactly one ownership flag is set.
  venue_id           uuid references public.venues(id) on delete set null,
  guest_id           uuid references public.guests(id) on delete set null,
  is_mesita          boolean not null default false,
  bucket             text not null check (bucket in ('available', 'pending')),
  -- Source links for reconciliation
  ticket_id          uuid references public.tickets(id) on delete set null,
  stripe_object_id   text,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  constraint ledger_entry_owner_exactly_one check (
    (case when venue_id is null then 0 else 1 end)
    + (case when guest_id is null then 0 else 1 end)
    + (case when is_mesita then 1 else 0 end) = 1
  ),
  -- mesita_balance only has an available bucket; pending is invalid.
  constraint ledger_entry_mesita_bucket check (
    not is_mesita or bucket = 'available'
  )
);
create index ledger_entries_ticket_idx     on public.ledger_entries (ticket_id);
create index ledger_entries_venue_idx      on public.ledger_entries (venue_id);
create index ledger_entries_guest_idx      on public.ledger_entries (guest_id);
create index ledger_entries_stripe_obj_idx on public.ledger_entries (stripe_object_id);
create index ledger_entries_kind_idx       on public.ledger_entries (kind);

-- =========================
-- Row-level security
-- =========================
-- Default deny on every new table. Writes happen via the service role
-- from inside Edge Functions (matches the rest of the schema).

alter table public.stripe_customers          enable row level security;
alter table public.stripe_connect_accounts   enable row level security;
alter table public.stripe_subscriptions      enable row level security;
alter table public.stripe_webhook_events     enable row level security;
alter table public.guest_balances            enable row level security;
alter table public.venue_balances            enable row level security;
alter table public.mesita_balance            enable row level security;
alter table public.ledger_entries            enable row level security;

-- =========================
-- Documentation comments (so a future reader / generator picks them up)
-- =========================

comment on table public.stripe_customers is
  'One Stripe Customer per venue (for Pro Subscription) or guest (for Class Subscription). Exactly one of venue_id / guest_id is set.';
comment on table public.stripe_connect_accounts is
  'Stripe Connect Express account per Formal Verified Partner. Mirrors Stripe Account fields that gate payouts; refreshed by the account.updated webhook.';
comment on table public.stripe_subscriptions is
  'Active Stripe Subscriptions for venues (Pro plans) and guests (Class plans). `kind` denormalises the Price ID into a stable enum.';
comment on table public.stripe_webhook_events is
  'Idempotency log. Every incoming Stripe event is recorded here first by stripe_event_id; handlers no-op on duplicates.';
comment on table public.guest_balances is
  'Closed-loop Mesita Balance. No payout method is ever wired to a guest; funds can only flow OUT via cashback_redeem when the guest spends balance on a future bill.';
comment on table public.venue_balances is
  'Venue earnings held on Mesita platform until story validates + chargeback window closes. Released to the venue via a Stripe Transfer to their Express account.';
comment on table public.mesita_balance is
  'Singleton row holding Mesita platform revenue (fees + subscription income). Withdrawn to founder bank via Stripe Payout from the platform balance.';
comment on table public.ledger_entries is
  'Append-only audit log. Every change to guest/venue/mesita balances writes one row. Source of truth for Stripe reconciliation.';
