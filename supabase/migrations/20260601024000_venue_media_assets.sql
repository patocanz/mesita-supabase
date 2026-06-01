-- Async venue media persistence ledger.
-- Stores source links + metadata (likes, caption, analysis) and the mirrored
-- Storage object details once each image is persisted.

create table if not exists public.venue_media_assets (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  source text not null check (source in ('google', 'website', 'instagram')),
  source_url text not null,
  status text not null default 'pending' check (status in ('pending', 'saved', 'failed')),
  storage_path text,
  public_url text,
  likes_count integer,
  caption text,
  analysis_text text,
  source_metadata jsonb,
  mime_type text,
  bytes integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue_id, source_url)
);

create index if not exists venue_media_assets_venue_id_idx
  on public.venue_media_assets (venue_id);

create index if not exists venue_media_assets_status_idx
  on public.venue_media_assets (status);

comment on table public.venue_media_assets is
  'Source media URLs + metadata captured during enrichment and their mirrored Storage targets.';

comment on column public.venue_media_assets.source_metadata is
  'Raw source-level metadata (e.g. Instagram comments/is_video/shortcode, website alt+dimensions+page).';

alter table public.venue_media_assets enable row level security;

create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_venue_media_assets_updated_at on public.venue_media_assets;
create trigger set_venue_media_assets_updated_at
before update on public.venue_media_assets
for each row execute function public.tg_set_updated_at();
