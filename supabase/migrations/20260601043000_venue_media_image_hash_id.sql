-- Canonical image ID = SHA-256 hash of image bytes.
-- This ID is immutable and survives venue/admin resets.

alter table public.venue_media_assets
  add column if not exists image_id text;

-- Backfill only rows whose storage_path already encodes a full 64-char hex id.
update public.venue_media_assets
set image_id = lower(substring(storage_path from '/([a-f0-9]{64})\.[^./]+$'))
where image_id is null
  and storage_path is not null
  and storage_path ~ '/[a-f0-9]{64}\.[^./]+$';

alter table public.venue_media_assets
  drop constraint if exists venue_media_assets_image_id_sha256_chk;

alter table public.venue_media_assets
  add constraint venue_media_assets_image_id_sha256_chk
  check (image_id is null or image_id ~ '^[a-f0-9]{64}$');

create unique index if not exists venue_media_assets_image_id_uq
  on public.venue_media_assets (image_id)
  where image_id is not null;

comment on column public.venue_media_assets.image_id is
  'Canonical image ID (SHA-256 hash of image bytes).';
