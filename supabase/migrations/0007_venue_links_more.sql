-- 0007_venue_links_more.sql
-- Round out the venue channel inventory so the enrichment pipeline has a
-- place to land every link it can confidently classify from Google Places +
-- Firecrawl. Eight new columns:
--   • x_url / youtube_url / threads_url / reddit_url — social channels we
--     were silently dropping even though they're common in hospitality.
--   • google_maps_url — Google already returns googleMapsUri on the details
--     call; persist it as the canonical "see on Google" link.
--   • tripadvisor_url — strong review surface for tourist-leaning venues.
--   • didi_food_url   — completes the delivery trio (Rappi / Uber Eats / DiDi).
--   • email           — direct contact, extractable from Firecrawl markdown
--     with a simple regex. Stored as plain text (not URL-shaped) — the
--     update EF skips the https:// check for this field.
--
-- All nullable, all plain text. No indexes — these are display values, not
-- search keys.

alter table public.venues
  add column x_url           text,
  add column youtube_url     text,
  add column threads_url     text,
  add column reddit_url      text,
  add column google_maps_url text,
  add column tripadvisor_url text,
  add column didi_food_url   text,
  add column email           text;
