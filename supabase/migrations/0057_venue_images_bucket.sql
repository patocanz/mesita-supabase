-- 0057 — Public Storage bucket for durable venue gallery images.
--
-- Instagram CDN URLs are signed and expire within a day or two; some website
-- images hotlink-block. The enricher (atlas-enrich-profile) downloads those
-- saved images and re-hosts them here, then stores the durable public URL in
-- venues.photos so the consumer gallery never 404s after the source expires.
--
-- Public bucket: gallery images are world-readable, so the consumer renders
-- them straight from the public URL (no signing). The enricher writes with the
-- service-role key, which bypasses storage RLS.

insert into storage.buckets (id, name, public)
values ('venue-images', 'venue-images', true)
on conflict (id) do nothing;
