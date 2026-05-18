-- 0008_venue_embeddings.sql
-- pgvector + per-venue embedding so guest-build-deck and
-- guest-build-catalog can do semantic ranking (RAG) instead of asking the
-- LLM to compare each venue one-by-one. The flow is:
--
--   1. embed each venue's source text once (cached in `embedding`)
--   2. at request time, embed ONE user-intent query
--   3. ORDER BY embedding <=> :query_vec → ranked candidate set
--
-- That collapses an N-LLM-call ranking into 1 embedding call + 1 SQL scan.
--
-- Why text-embedding-3-small (1536 dims):
--   • cheap ($0.02 / 1M tokens),
--   • lands cosine-similarity quality close to ada-002,
--   • universally supported by openai/voyage/cohere shims if we ever swap.
--
-- `embedding_source_hash` is the FNV-1a (or any cheap digest) of the
-- composed source text. Lets the embedder detect "this venue's text
-- changed, regenerate" without storing the whole source. NULL means the
-- venue hasn't been embedded yet — both EFs will batch-embed lazily.

create extension if not exists vector;

alter table public.venues
  add column embedding             vector(1536),
  add column embedding_source_hash text;

-- HNSW with cosine ops. m=16, ef_construction=64 are the standard "good
-- defaults" for catalogs in the 10K–1M row range. We tune `ef_search` at
-- query time (per-statement SET) if recall feels low; not needed yet.
--
-- Note: HNSW build is fast on small tables (<1ms). On a multi-million-row
-- table it would block writes; not a concern for hospitality scale.
create index if not exists venues_embedding_hnsw
  on public.venues
  using hnsw (embedding vector_cosine_ops);

-- Bounding-box prefilter speedup. Both EFs filter by lat/lng radius before
-- ranking; without these, the planner full-scans for every cold request.
create index if not exists venues_lat_active_idx
  on public.venues (lat) where status = 'active';
create index if not exists venues_lng_active_idx
  on public.venues (lng) where status = 'active';
