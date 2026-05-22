-- 0018_venue_place_components.sql
-- Backend support for the Place redesign driven by the Notion Components
-- database. Two groups of new columns:
--
--   1. Editable on Place (Manager-E=YES): description, menu_pdf_url, tags,
--      whatsapp_pr_urls, instagram_pr_urls. These are written through
--      manager-update-unit.
--
--   2. Read-only signals (Manager-E=NO): google_business_url and the
--      ratings / review / visitor / follower counts surfaced in the Signals
--      section. These are populated by the enrichment pipeline and the
--      ticket / verification aggregators — never by the manager.
--
-- closes_at / pitch / story are intentionally left in place. The Place page
-- no longer surfaces them, but other call sites still read them and the
-- migration stays additive.

alter table public.venues
  -- Editable on Place
  add column description        text,
  add column menu_pdf_url       text,
  add column tags               text[] not null default '{}',
  add column whatsapp_pr_urls   text[] not null default '{}',
  add column instagram_pr_urls  text[] not null default '{}',
  -- Read-only on Place
  add column google_business_url        text,
  add column google_stars_overall       numeric(2, 1) check (google_stars_overall between 0 and 5),
  add column google_review_count        integer       check (google_review_count >= 0),
  add column google_visitor_count       integer       check (google_visitor_count >= 0),
  add column mesita_stars_overall       numeric(2, 1) check (mesita_stars_overall between 0 and 5),
  add column mesita_stars_food          numeric(2, 1) check (mesita_stars_food between 0 and 5),
  add column mesita_stars_service       numeric(2, 1) check (mesita_stars_service between 0 and 5),
  add column mesita_stars_ambience      numeric(2, 1) check (mesita_stars_ambience between 0 and 5),
  add column mesita_review_count        integer       check (mesita_review_count >= 0),
  add column mesita_visitor_count       integer       check (mesita_visitor_count >= 0),
  add column instagram_followers_count  integer       check (instagram_followers_count >= 0);

comment on column public.venues.description is
  'Manager-authored 1-2 sentence description of the venue. Shown in the Place editor and on the guest Info view.';
comment on column public.venues.menu_pdf_url is
  'Public URL to the latest menu PDF. https:// only.';
comment on column public.venues.tags is
  'Free-form descriptor tags ("elegant", "rooftop", "tequila"). Lowercased, deduped, capped at MAX_TAGS in the EF.';
comment on column public.venues.whatsapp_pr_urls is
  'Concierge / PR WhatsApp numbers (as wa.me URLs) the venue routes VIPs through. Capped at MAX_PR_LINKS in the EF.';
comment on column public.venues.instagram_pr_urls is
  'PR / events Instagram handles. Capped at MAX_PR_LINKS in the EF.';
comment on column public.venues.google_business_url is
  'Google Business Profile URL. Distinct from google_maps_url. Populated by enrichment.';
comment on column public.venues.google_stars_overall is
  'Overall Google rating, 0.0–5.0. Populated by enrichment.';
comment on column public.venues.mesita_stars_overall is
  'Overall Mesita rating, 0.0–5.0. Aggregated from verified guest ratings.';
