-- 0029 — menu_pdf_name on venues.
--
-- The Place page already lets a business attach a single menu PDF link
-- (menu_pdf_url). This adds an optional display name to that link so
-- the consumer can see "Dinner menu" / "Wine list" / "Cocktail list"
-- instead of the raw URL or a default "Full menu" label. Null means
-- "no name set" — consumers should fall back to the existing "Full
-- menu" copy.

alter table public.venues
  add column if not exists menu_pdf_name text;

comment on column public.venues.menu_pdf_name is
  'Display name for menu_pdf_url, e.g. "Dinner menu" or "Wine list". Null = no name set, consumer falls back to "Full menu".';
