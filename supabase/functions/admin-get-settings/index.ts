// Supabase Edge Function — admin-get-settings
//
// Returns the full public.app_settings singleton row to the admin web.
// One central read for every admin page that needs to surface a flag:
//
//   auto_verify_ai_call         — verification auto-approve (call OTP)
//   auto_verify_ai_email        — verification auto-approve (email OTP)
//   auto_verify_video           — verification auto-approve (legacy video)
//
// Auth: caller's JWT email must be in public.super_admins.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const admin = adminClient(envRes.env);
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  const { data, error } = await admin
    .from("app_settings")
    .select(
      "auto_verify_ai_call, auto_verify_ai_email, auto_verify_video, atlas_source_tier_ceiling, atlas_source_overrides, atlas_website_crawl_max_pages, atlas_gather_google_images, atlas_gather_website_images, atlas_gather_instagram_posts, atlas_image_vision_enabled, atlas_analyze_google_images, atlas_analyze_website_images, atlas_analyze_instagram_images, atlas_save_total_images, atlas_image_analysis_prompt, atlas_image_sorting_prompt, atlas_synthesis_quality, atlas_per_run_cost_cap_usd, updated_at",
    )
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    return json(
      { ok: false, error: `settings_read: ${error.message}` },
      500,
    );
  }
  if (!data) {
    return json({ ok: false, error: "app_settings missing" }, 500);
  }

  return json({
    ok: true,
    autoVerifyAiCall: data.auto_verify_ai_call,
    autoVerifyAiEmail: data.auto_verify_ai_email,
    autoVerifyVideo: data.auto_verify_video,
    atlasSourceTierCeiling: data.atlas_source_tier_ceiling,
    atlasSourceOverrides: data.atlas_source_overrides,
    atlasWebsiteCrawlMaxPages: data.atlas_website_crawl_max_pages,
    atlasGatherGoogleImages: data.atlas_gather_google_images,
    atlasGatherWebsiteImages: data.atlas_gather_website_images,
    atlasGatherInstagramPosts: data.atlas_gather_instagram_posts,
    atlasImageVisionEnabled: data.atlas_image_vision_enabled,
    atlasAnalyzeGoogleImages: data.atlas_analyze_google_images,
    atlasAnalyzeWebsiteImages: data.atlas_analyze_website_images,
    atlasAnalyzeInstagramImages: data.atlas_analyze_instagram_images,
    atlasSaveTotalImages: data.atlas_save_total_images,
    atlasImageAnalysisPrompt: data.atlas_image_analysis_prompt,
    atlasImageSortingPrompt: data.atlas_image_sorting_prompt,
    atlasSynthesisQuality: data.atlas_synthesis_quality,
    atlasPerRunCostCapUsd: data.atlas_per_run_cost_cap_usd,
    updatedAt: data.updated_at,
  });
});
