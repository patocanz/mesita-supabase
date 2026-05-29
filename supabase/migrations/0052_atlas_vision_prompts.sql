-- 0052 — Atlas editable vision prompts (additive).
--
-- Two operator-editable prompts for the image pipeline, surfaced under the
-- admin console's "Vision Params" group:
--   atlas_image_analysis_prompt — per-image vision description/scoring prompt.
--   atlas_image_sorting_prompt  — final best->worst ranking prompt. Default
--                                 bakes in the experience rubric (ambiance
--                                 weighted equally with food).
--
-- The website-images vision cap (atlas_analyze_website_images) is dropped in
-- 0053 once the EFs stop referencing it — website is menu/content only, not
-- part of the Google+Instagram vision set.

alter table public.app_settings
  add column if not exists atlas_image_analysis_prompt text not null default
    'Describe this venue photo for a hospitality discovery app: subject (ambiance / interior / exterior / food / people / detail), visual quality, lighting, whether it is representative and appealing, and any text, logo or watermark. Be concise and factual.',
  add column if not exists atlas_image_sorting_prompt text not null default
    'Rank these venue photos best to worst for a should-we-go-tonight decision. We sell EXPERIENCES, not just food: weight beautiful place / ambiance / vibe shots EQUALLY with food. Favor visual quality, representativeness, and a balanced mix (ambiance + food + people / energy). Drop duplicates, blurry, dark, or text-heavy images.';

comment on column public.app_settings.atlas_image_analysis_prompt is
  'Vision: per-image analysis prompt (subject, quality, representativeness).';
comment on column public.app_settings.atlas_image_sorting_prompt is
  'Vision: final best->worst ranking prompt. Experience rubric: ambiance weighted equally with food.';

notify pgrst, 'reload schema';
