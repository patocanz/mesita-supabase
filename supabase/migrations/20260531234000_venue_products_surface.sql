-- Add a generic products payload so menus become one subtype.
-- Backward compatible with existing `menus` readers.

alter table public.venues
  add column if not exists products jsonb;

comment on column public.venues.products is
  'Generic product payload for a venue. Example: {"menu":[...]} for restaurants.';

-- Backfill from existing menus for already-enriched venues.
update public.venues v
set products = jsonb_build_object('menu', v.menus)
where v.products is null
  and v.menus is not null
  and jsonb_typeof(v.menus) = 'array';
