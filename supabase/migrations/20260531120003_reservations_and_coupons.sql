-- 0031 — splits the monolithic ticket model into three first-class entities.
--
-- The legacy `tickets` row bundled booking metadata (when, who, party size)
-- and financial metadata (cashback %, totals, paid_at) into one shape. The
-- consumer surface now needs them to be distinct:
--
--   • saved_venues  — consumer ↔ venue bookmark. Moves saving from
--                     localStorage-only to a DB-tracked event so coupons
--                     can be auto-issued downstream. Inserting here
--                     spawns a coupon via trigger.
--
--   • coupons       — discount instruments. Snapshot the venue's eight
--                     per-tier promo rates + cap at issue time so future
--                     rate edits don't retroactively change already-
--                     issued coupons. Live in the consumer's "coupons
--                     wallet" surface.
--
--   • reservations  — booking details only (when, where, party size).
--                     Optionally linked to a coupon via reservations
--                     .coupon_id, but the reservation row NEVER carries
--                     discount info — that intentionally lives on the
--                     linked coupon. Consumer sees booking on the
--                     reservation card and discount on the coupon card.
--
-- The old `tickets` table + `cashback_ledger.ticket_id` stay untouched
-- here. This migration is additive so the new entities can land alongside
-- the existing ticket flow; a follow-up retires tickets once every
-- caller has switched.
--
-- Note on the reservation_status enum:
--   It already exists in this database — added by an earlier
--   `tickets.reservation_status` column on the old monolithic tickets
--   row, with values (pending, confirmed, declined, no_show, cancelled).
--   We reuse that enum verbatim instead of creating a parallel one or
--   trying to ADD VALUE inside a migration transaction (which Postgres
--   forbids). "Completed" is represented by `reservations.completed_at`
--   being set; status stays 'confirmed' through the visit.

-- ── Enums ───────────────────────────────────────────────────────────────

create type public.coupon_status as enum (
  'active',    -- issued, in the wallet, ready to redeem
  'redeemed',  -- consumer used it on a visit (one coupon = one redemption)
  'expired',   -- past expires_at
  'cancelled'  -- consumer unsaved venue / venue offboarded
);

-- ── Saved venues ────────────────────────────────────────────────────────
--
-- Moves the consumer's "bookmark this venue" event into the database. The
-- consumer client used to keep this in localStorage only (see
-- mesita-web-consumer/src/lib/saved-venues.ts); with the entity split a
-- bookmark needs to spawn a coupon, which needs a DB row to anchor on.
--
-- Unique on (consumer_id, venue_id): a consumer either saves a venue or
-- they don't; toggling save off deletes the row (and via the trigger
-- below, cancels the active coupon).

create table public.saved_venues (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  consumer_id  uuid not null references public.consumers(id) on delete cascade,
  venue_id     uuid not null references public.venues(id)    on delete cascade,
  unique (consumer_id, venue_id)
);

create index saved_venues_consumer_idx on public.saved_venues (consumer_id, created_at desc);
create index saved_venues_venue_idx    on public.saved_venues (venue_id, created_at desc);

-- ── Coupons ─────────────────────────────────────────────────────────────
--
-- The discount instrument. Snapshots the venue's promo terms at issue time
-- so a venue editing their rates next week doesn't quietly devalue this
-- consumer's already-issued coupon.

create table public.coupons (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  consumer_id          uuid not null references public.consumers(id) on delete cascade,
  venue_id             uuid not null references public.venues(id)    on delete restrict,
  saved_venue_id       uuid references public.saved_venues(id) on delete set null,
  status               public.coupon_status not null default 'active',
  issued_at            timestamptz not null default now(),
  redeemed_at          timestamptz,
  cancelled_at         timestamptz,
  expires_at           timestamptz,
  welcome_bronze_rate  smallint check (welcome_bronze_rate  is null or welcome_bronze_rate  in (10, 20, 50, 70)),
  welcome_silver_rate  smallint check (welcome_silver_rate  is null or welcome_silver_rate  in (10, 20, 50, 70)),
  welcome_gold_rate    smallint check (welcome_gold_rate    is null or welcome_gold_rate    in (10, 20, 50, 70)),
  welcome_diamond_rate smallint check (welcome_diamond_rate is null or welcome_diamond_rate in (10, 20, 50, 70)),
  bronze_rate          smallint check (bronze_rate          is null or bronze_rate          in (10, 20, 50, 70)),
  silver_rate          smallint check (silver_rate          is null or silver_rate          in (10, 20, 50, 70)),
  gold_rate            smallint check (gold_rate            is null or gold_rate            in (10, 20, 50, 70)),
  diamond_rate         smallint check (diamond_rate         is null or diamond_rate         in (10, 20, 50, 70)),
  cap_cents            integer not null default 0 check (cap_cents >= 0),
  currency             text    not null default 'MXN'
);

create trigger coupons_set_updated_at
  before update on public.coupons
  for each row execute function public.set_updated_at();

create unique index coupons_one_active_per_venue
  on public.coupons (consumer_id, venue_id)
  where status = 'active';

create index coupons_consumer_idx on public.coupons (consumer_id, created_at desc);
create index coupons_venue_idx    on public.coupons (venue_id);
create index coupons_status_idx   on public.coupons (status);

-- ── Reservations ────────────────────────────────────────────────────────
--
-- Booking details. Intentionally has no money fields — the consumer surface
-- renders cashback / discount info exclusively from the linked coupon.
-- completed_at is the "did the visit happen?" timestamp; we keep status
-- on 'confirmed' through the visit and set completed_at on arrival so we
-- don't need to extend the (cross-table) reservation_status enum.

create table public.reservations (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  consumer_id   uuid not null references public.consumers(id) on delete cascade,
  venue_id      uuid not null references public.venues(id)    on delete restrict,
  coupon_id     uuid references public.coupons(id) on delete set null,
  reserved_at   timestamptz not null,
  party_size    smallint    not null check (party_size > 0),
  status        public.reservation_status not null default 'pending',
  notes         text,
  confirmed_at  timestamptz,
  completed_at  timestamptz,
  cancelled_at  timestamptz
);

create trigger reservations_set_updated_at
  before update on public.reservations
  for each row execute function public.set_updated_at();

create index reservations_consumer_idx on public.reservations (consumer_id, reserved_at desc);
create index reservations_venue_idx    on public.reservations (venue_id, reserved_at desc);

-- ── Trigger: save → coupon auto-issue ───────────────────────────────────
--
-- "The coupon is automatically saved as a different entity in the coupons
-- wallet" — the user's directive for this entity split. Implementing the
-- guarantee in a trigger means it holds no matter what surface inserts
-- the saved_venues row.
--
-- Skips non-partner venues: web listings aren't on the rewards program,
-- so a save bookmarks the place but spawns no coupon. The partial unique
-- index above prevents double-issuance if the trigger somehow fires twice.

create or replace function public.tg_saved_venues_issue_coupon()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  select
    listing_type,
    welcome_bronze_rate, welcome_silver_rate, welcome_gold_rate, welcome_diamond_rate,
    bronze_rate, silver_rate, gold_rate, diamond_rate,
    currency
  into v
  from public.venues
  where id = new.venue_id;

  if not found or v.listing_type <> 'partner' then
    return new;
  end if;

  insert into public.coupons (
    consumer_id, venue_id, saved_venue_id,
    welcome_bronze_rate, welcome_silver_rate, welcome_gold_rate, welcome_diamond_rate,
    bronze_rate, silver_rate, gold_rate, diamond_rate,
    cap_cents, currency
  ) values (
    new.consumer_id, new.venue_id, new.id,
    v.welcome_bronze_rate, v.welcome_silver_rate, v.welcome_gold_rate, v.welcome_diamond_rate,
    v.bronze_rate, v.silver_rate, v.gold_rate, v.diamond_rate,
    0,
    coalesce(v.currency, 'MXN')
  )
  on conflict (consumer_id, venue_id) where status = 'active' do nothing;

  return new;
end;
$$;

create trigger saved_venues_issue_coupon
  after insert on public.saved_venues
  for each row execute function public.tg_saved_venues_issue_coupon();

-- ── Trigger: unsave → cancel active coupon ──────────────────────────────

create or replace function public.tg_saved_venues_cancel_coupon()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.coupons
    set status = 'cancelled', cancelled_at = now()
    where consumer_id = old.consumer_id
      and venue_id    = old.venue_id
      and status      = 'active';
  return old;
end;
$$;

create trigger saved_venues_cancel_coupon
  after delete on public.saved_venues
  for each row execute function public.tg_saved_venues_cancel_coupon();

-- ── RLS ─────────────────────────────────────────────────────────────────

alter table public.saved_venues  enable row level security;
alter table public.coupons       enable row level security;
alter table public.reservations  enable row level security;

create policy saved_venues_select_own on public.saved_venues
  for select using (auth.uid() = consumer_id);

create policy coupons_select_own on public.coupons
  for select using (auth.uid() = consumer_id);

create policy reservations_select_own on public.reservations
  for select using (auth.uid() = consumer_id);

notify pgrst, 'reload schema';
