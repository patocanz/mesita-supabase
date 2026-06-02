-- Sequential consumer QR codes (0000-0000 … 9999-9999), Staff WhatsApp Type-A
-- billing flow, consumer pay notifications (Realtime), and ticket reviews.

-- ── Ticket status: payment confirmation gate (Type A discount flow) ────────
alter type public.ticket_status add value if not exists 'awaiting_payment_confirm';

-- ── Sequential consumer codes ──────────────────────────────────────────────
create table if not exists public.consumer_code_counter (
  id smallint primary key default 1 check (id = 1),
  next_value bigint not null default 0
    check (next_value >= 0 and next_value <= 99999999)
);

insert into public.consumer_code_counter (id, next_value)
values (1, 0)
on conflict (id) do nothing;

create or replace function public.format_consumer_code(n bigint)
returns text
language sql
immutable
set search_path to 'pg_catalog', 'public'
as $$
  select lpad((n / 10000)::text, 4, '0') || '-' ||
         lpad((mod(n, 10000))::text, 4, '0');
$$;

create or replace function public.normalize_consumer_code_input(raw text)
returns text
language plpgsql
immutable
set search_path to 'pg_catalog', 'public'
as $function$
declare
  digits text;
  n bigint;
begin
  if raw is null or length(trim(raw)) = 0 then
    return null;
  end if;
  digits := regexp_replace(upper(trim(raw)), '[^0-9A-Z]', '', 'g');
  if digits ~ '^[0-9]{8}$' then
    return public.format_consumer_code(digits::bigint);
  end if;
  if raw ~ '^[0-9]{4}-[0-9]{4}$' then
    return upper(trim(raw));
  end if;
  return upper(trim(raw));
end;
$function$;

create or replace function public.generate_consumer_code()
returns text
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  seq bigint;
  formatted text;
begin
  update public.consumer_code_counter
  set next_value = next_value + 1
  where id = 1
  returning next_value - 1 into seq;

  if seq is null then
    raise exception 'consumer_code_counter missing';
  end if;
  if seq > 99999999 then
    raise exception 'consumer code space exhausted';
  end if;

  formatted := public.format_consumer_code(seq);
  if exists (select 1 from public.consumers where code = formatted) then
    raise exception 'consumer code collision at %', formatted;
  end if;
  return formatted;
end;
$function$;

comment on function public.generate_consumer_code() is
  'Allocates the next sequential 8-digit consumer code as 0000-0000 … 9999-9999.';

-- ── tickets.opened_by → auth.users (staff + business openers) ─────────────
alter table public.tickets drop constraint if exists tickets_opened_by_fkey;
alter table public.tickets
  add constraint tickets_opened_by_fkey
  foreign key (opened_by) references auth.users(id) on delete restrict;

alter table public.tickets
  add column if not exists consumer_payment_confirmed_at timestamptz,
  add column if not exists staff_payment_confirmed_at timestamptz,
  add column if not exists opened_by_staff_user_id uuid references auth.users(id) on delete set null;

comment on column public.tickets.opened_by_staff_user_id is
  'When a ticket is opened via Staff WhatsApp, the waiter auth user id (opened_by may be venue owner for FK legacy).';

-- ── Staff WhatsApp session state ─────────────────────────────────────────
create table public.staff_whatsapp_sessions (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  staff_user_id uuid not null references auth.users(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  state text not null default 'idle'
    check (state in (
      'idle',
      'consumer_identified',
      'awaiting_payment_confirm',
      'awaiting_staff_payment_confirm'
    )),
  consumer_id uuid references public.consumers(id) on delete set null,
  ticket_id uuid references public.tickets(id) on delete set null,
  pending_consumer_code text,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger staff_whatsapp_sessions_set_updated_at
  before update on public.staff_whatsapp_sessions
  for each row execute function public.set_updated_at();

create index staff_whatsapp_sessions_staff_idx
  on public.staff_whatsapp_sessions (staff_user_id);

alter table public.staff_whatsapp_sessions enable row level security;

-- Service-role only (Edge Functions). No client policies.

-- ── Consumer in-app pay notifications (Supabase Realtime) ────────────────
create table public.consumer_pay_notifications (
  id uuid primary key default gen_random_uuid(),
  consumer_id uuid not null references public.consumers(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  kind text not null
    check (kind in ('payment_confirm', 'review')),
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'dismissed')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index consumer_pay_notifications_consumer_pending_idx
  on public.consumer_pay_notifications (consumer_id, created_at desc)
  where status = 'pending';

alter table public.consumer_pay_notifications enable row level security;

create policy consumer_pay_notifications_select_own
  on public.consumer_pay_notifications
  for select
  to authenticated
  using (consumer_id = auth.uid());

-- ── Post-visit reviews (Food / Service / Ambiance / Overall + comments) ───
create table public.ticket_reviews (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null unique references public.tickets(id) on delete cascade,
  consumer_id uuid not null references public.consumers(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  food smallint not null check (food between 1 and 5),
  service smallint not null check (service between 1 and 5),
  ambiance smallint not null check (ambiance between 1 and 5),
  overall smallint not null check (overall between 1 and 5),
  comments text,
  created_at timestamptz not null default now()
);

create index ticket_reviews_venue_idx on public.ticket_reviews (venue_id, created_at desc);

alter table public.ticket_reviews enable row level security;

create policy ticket_reviews_select_own
  on public.ticket_reviews
  for select
  to authenticated
  using (consumer_id = auth.uid());

-- Realtime for pay notifications
alter publication supabase_realtime add table public.consumer_pay_notifications;

-- ── admin_reset_database: new tables ─────────────────────────────────────
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
    public.ticket_reviews,
    public.consumer_pay_notifications,
    public.staff_whatsapp_sessions,
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

  update public.consumer_code_counter set next_value = 0 where id = 1;

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

  perform public.seed_venue_categories();

  delete from auth.users u
  where u.email is null
     or lower(u.email) not in (
       select lower(email) from public.super_admins
     );
  get diagnostics deleted_users = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_auth_users', deleted_users,
    'preserved_media_assets', true,
    'reset_at', now()
  );
end;
$function$;

-- Lookup staff auth user by E.164 phone (digits only).
create or replace function public.find_user_id_by_phone(phone_digits text)
returns uuid
language sql
security definer
set search_path to 'auth', 'pg_catalog', 'public'
as $$
  select u.id
  from auth.users u
  where regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g') = phone_digits
     or right(regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g'), 10)
        = right(phone_digits, 10)
  limit 1;
$$;

notify pgrst, 'reload schema';
