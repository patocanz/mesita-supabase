-- 0034 — consumer membership columns.
--
-- Until now the consumer tier lived only as frontend mock data. This adds
-- the real model to public.consumers:
--
--   tier_key      — which membership tier the consumer holds (FK to the
--                   membership_tiers lookup). Defaults to 'free'.
--   tier_origin   — which "door" granted the current tier:
--                     default      — no upgrade
--                     instagram    — 1K+ followers + verified story
--                     subscription — paid $200 MXN/mo (Stripe)
--                     invitation   — admin-granted (models / comps)
--   consumer_instagram_followers_count — namespaced to avoid colliding with
--                   venues.instagram_followers_count (a different concept).
--   tier_granted_at / tier_expires_at — audit + optional expiry for IG /
--                   invitation grants and subscription period end.

alter table public.consumers
  add column tier_key text not null default 'free'
    references public.membership_tiers(key),
  add column tier_origin text not null default 'default'
    check (tier_origin in ('default', 'instagram', 'subscription', 'invitation')),
  add column consumer_instagram_followers_count integer
    check (consumer_instagram_followers_count is null or consumer_instagram_followers_count >= 0),
  add column tier_granted_at timestamptz,
  add column tier_expires_at timestamptz;

create index consumers_tier_idx on public.consumers (tier_key);

notify pgrst, 'reload schema';
