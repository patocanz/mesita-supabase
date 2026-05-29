-- 0035 — consumer subscriptions + Stripe webhook idempotency.
--
-- The paid door into Premium is a $200 MXN/mo Stripe subscription. This
-- table mirrors the Stripe subscription state; the webhook
-- (stripe-handle-webhook) is the only writer that flips
-- consumers.tier_key on the back of it.
--
-- stripe_events records processed Stripe event ids so re-delivered
-- webhooks (Stripe retries aggressively) are no-ops.

create table public.consumer_subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  consumer_id            uuid not null references public.consumers(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  status                 text not null
    check (status in ('incomplete', 'active', 'past_due', 'canceled', 'unpaid')),
  price_cents            integer,
  currency               text not null default 'MXN',
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false
);

create trigger consumer_subscriptions_set_updated_at
  before update on public.consumer_subscriptions
  for each row execute function public.set_updated_at();

-- A consumer can hold at most one live (active or past_due) subscription.
create unique index consumer_subscriptions_one_live
  on public.consumer_subscriptions (consumer_id)
  where status in ('active', 'past_due');

create index consumer_subscriptions_consumer_idx on public.consumer_subscriptions (consumer_id);

alter table public.consumer_subscriptions enable row level security;

create policy consumer_subscriptions_select_own on public.consumer_subscriptions
  for select using (auth.uid() = consumer_id);

-- Webhook idempotency ledger. Service-role only (RLS on, no policy).
create table public.stripe_events (
  event_id     text primary key,
  processed_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;

notify pgrst, 'reload schema';
