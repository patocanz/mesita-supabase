-- 0028 — currency column on venues.
--
-- Every monetary amount on a venue (price ranges shown on the consumer
-- detail page, the reward_cap, future cover charges, etc.) is implicitly
-- denominated in this currency. Mesita launches Mexico-only so every
-- row defaults to 'MXN'. The column exists so a future multi-country
-- expansion can flip a venue to USD / EUR / etc. without a schema
-- change, and so EFs / clients can render the correct currency prefix
-- without hard-coding "MX$".

alter table public.venues
  add column if not exists currency text not null default 'MXN';

comment on column public.venues.currency is
  'ISO 4217 currency code. Default MXN — every monetary amount on the venue (price ranges, reward caps) is in this currency.';
