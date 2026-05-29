-- 0045 — drop redundant atlas_per_source_ai_summary.
--
-- Per-source AI summaries (e.g. SERP Page AI Summary via Perplexity) live in
-- the Data/Sourcing pipeline and are gated by the source tier ceiling via the
-- "AI summary" step nodes — not by a separate Analysis toggle. The flag was
-- double-specification (same reasoning as 0044's serp_only_when_thin), so it
-- is removed from the admin console + settings EFs; this drops the column.
--
-- Analysis-stage params that remain: image vision (+ max images), synthesis
-- quality (the final OpenAI synthesis / "Research Backbone"), per-run cost cap.

alter table public.app_settings
  drop column if exists atlas_per_source_ai_summary;

notify pgrst, 'reload schema';
