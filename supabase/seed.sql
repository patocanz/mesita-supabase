-- seed.sql — applied by `supabase db reset` after every migration.
-- Idempotent: safe to re-run.

insert into public.venues (slug, name, category, vibe, price_level, listing_type, status, closes_at, cashback_percent)
values
  ('casa-luminar-seed', 'Casa Luminar (seed)', 'mediterranean', 'rooftop', 3, 'partner', 'active', '02:00', 20)
on conflict (slug) do nothing;
