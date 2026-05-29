-- 0056 — Atlas: private Storage bucket for append-only research snapshots.
--
-- Phase 4 of the Atlas pipeline. The enricher (atlas-enrich-profile) writes one
-- JSON snapshot per run under `<venue_id>/<timestamp>.json`, and pre-reads the
-- latest one to skip sources it can reuse ("only fetch the gaps"). History is
-- append-only — each run is a new object, nothing is overwritten.
--
-- Private bucket: the enricher uses the service-role key, which bypasses
-- storage RLS, so no public access or per-object policies are needed.

insert into storage.buckets (id, name, public)
values ('atlas-snapshots', 'atlas-snapshots', false)
on conflict (id) do nothing;
