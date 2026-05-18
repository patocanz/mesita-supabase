-- 0002_tickets.sql
-- Ticket + cashback workflow.
--   1. Guests get a short stable code so the waiter can scan or type it.
--   2. Validators (any venue_member) create a ticket against (venue, guest)
--      with the check totals + tip, snapshotting the venue's cashback rate.
--   3. Marking a ticket paid writes a row to cashback_ledger and bumps the
--      guest's cached balance.
--
-- Stripe payment integration is deliberately out-of-scope for this migration;
-- the "paid" transition is the hook where Stripe webhook handling will
-- eventually fire instead of being a manual validator action.

-- ── Enums ────────────────────────────────────────────────────────────────
create type public.ticket_status as enum (
  'open',         -- being filled by the validator (transient; rarely seen)
  'pending_pay',  -- validator finalised; awaiting payment
  'paid',         -- payment confirmed (real or manual placeholder)
  'cancelled'
);

create type public.cashback_kind as enum ('earn', 'redeem', 'expire', 'adjust');

-- ── Guests extensions ────────────────────────────────────────────────────
alter table public.guests
  add column code text unique,
  add column cashback_balance_cents integer not null default 0;

-- Stable per-guest code. 6 chars from a Crockford-style alphabet (no I/O/0/1
-- to keep handwritten codes unambiguous). Generated lazily on first use.
create or replace function public.generate_guest_code()
returns text
language plpgsql
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  attempts integer := 0;
begin
  loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    -- Confirm not already taken
    if not exists (select 1 from public.guests where code = candidate) then
      return candidate;
    end if;
    attempts := attempts + 1;
    if attempts > 16 then
      raise exception 'could not generate unique guest code';
    end if;
  end loop;
end;
$$;

-- ── Tickets ──────────────────────────────────────────────────────────────
create table public.tickets (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  venue_id              uuid not null references public.venues(id)   on delete restrict,
  guest_id              uuid not null references public.guests(id)   on delete restrict,
  opened_by             uuid not null references public.managers(id) on delete restrict,
  status                public.ticket_status not null default 'pending_pay',
  check_subtotal_cents  integer check (check_subtotal_cents is null or check_subtotal_cents >= 0),
  tip_cents             integer check (tip_cents is null or tip_cents >= 0),
  total_cents           integer check (total_cents is null or total_cents >= 0),
  cashback_percent      smallint not null check (cashback_percent between 0 and 100),
  cashback_cents        integer check (cashback_cents is null or cashback_cents >= 0),
  currency              text not null default 'MXN',
  paid_at               timestamptz,
  cancelled_at          timestamptz
);

create trigger tickets_set_updated_at
  before update on public.tickets
  for each row execute function public.set_updated_at();

create index tickets_venue_idx on public.tickets (venue_id, created_at desc);
create index tickets_guest_idx on public.tickets (guest_id, created_at desc);
create index tickets_status_idx on public.tickets (status);

-- ── Cashback ledger ──────────────────────────────────────────────────────
create table public.cashback_ledger (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  guest_id            uuid not null references public.guests(id) on delete restrict,
  ticket_id           uuid references public.tickets(id) on delete restrict,
  venue_id            uuid references public.venues(id) on delete restrict,
  delta_cents         integer not null,
  balance_after_cents integer not null check (balance_after_cents >= 0),
  kind                public.cashback_kind not null,
  notes               text
);

create index cashback_ledger_guest_idx on public.cashback_ledger (guest_id, created_at desc);
create index cashback_ledger_ticket_idx on public.cashback_ledger (ticket_id);

-- ── RLS ──────────────────────────────────────────────────────────────────
alter table public.tickets         enable row level security;
alter table public.cashback_ledger enable row level security;

-- Guest can read their own tickets; venue members read via service role.
create policy "tickets_select_own_guest"
  on public.tickets for select
  to authenticated
  using (guest_id = auth.uid());

-- Guest can read their own ledger.
create policy "cashback_ledger_select_own"
  on public.cashback_ledger for select
  to authenticated
  using (guest_id = auth.uid());

-- Note: validators / venue members access ticket lists via the
-- venues-side Edge Functions, which use the service role and verify
-- venue_members membership themselves. We don't expose those reads to
-- non-service-role callers at the table level.
