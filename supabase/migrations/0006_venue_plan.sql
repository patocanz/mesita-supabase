-- 0006_venue_plan.sql
-- Five-tier subscription model. The plan is the venue's commercial posture
-- on Mesita: which mechanic runs (cashback vs discount) and how much
-- visibility the venue buys.
--
--   free            $0 MX / mo   None         Minimum visibility (scraped)
--   formal_pro      $1,000 MX/mo Cashback     Medium visibility
--   formal_ultra    $3,000 MX/mo Cashback     Maximum visibility + featured
--   informal_pro    $2,000 MX/mo Discount     Medium visibility
--   informal_ultra  $6,000 MX/mo Discount     Maximum visibility + featured
--
-- Mechanic is pinned by fiscal_type, not by the plan. Plans only differ in
-- price and visibility. Informal costs 2× formal because Mesita captures no
-- transaction data on the discount rail — it pays for the same visibility
-- without handing over the wallet.

create type public.venue_plan as enum (
  'free',
  'formal_pro',
  'formal_ultra',
  'informal_pro',
  'informal_ultra'
);

alter table public.venues
  add column plan public.venue_plan not null default 'free';

comment on column public.venues.plan is
  'Subscription plan. Free venues are scraped + minimally visible. Pro/Ultra plans buy visibility; the mechanic (cashback vs discount) is determined by fiscal_type, not the plan.';

create index venues_plan_idx on public.venues (plan);
