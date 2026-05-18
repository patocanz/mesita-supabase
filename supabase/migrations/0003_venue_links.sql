-- 0003_venue_links.sql
-- External + social channel links per venue. All optional, all stored as
-- plain text URLs (no parsing/validation at the DB layer — the venues-update
-- function enforces https:// shape before write). Flat columns keep queries
-- simple; if we ever need 20+ channels we can roll them up into JSONB later.

alter table public.venues
  add column website_url    text,
  add column instagram_url  text,
  add column tiktok_url     text,
  add column facebook_url   text,
  add column whatsapp_url   text,
  add column opentable_url  text,
  add column resy_url       text,
  add column uber_eats_url  text,
  add column rappi_url      text;
