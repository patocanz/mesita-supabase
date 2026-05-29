// Supabase Edge Function — admin-update-atlas-config
//
// Naming: caller-verb-words. Caller = admin, verb = update, words = atlas-config.
//
// Partial-update of the Atlas research knobs on public.app_settings, written
// from the admin console's Atlas → Configuration page. Each field is
// optional; only the keys present in the body are written, so the UI can
// save one control at a time:
//
//   saveSnapshots   (boolean)  → atlas_save_snapshots
//   googleImages    (0-20)     → atlas_research_google_images
//   instagramPosts  (0-50)     → atlas_research_instagram_posts
//
// The separate pre-read toggle keeps its own EF (admin-set-atlas-pre-read).
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

type Body = {
  saveSnapshots?: boolean;
  snapshotOnBusinessEdit?: boolean;
  googleImages?: number;
  instagramPosts?: number;
  // Sourcing
  sourceTierCeiling?: number;
  sourceOverrides?: Record<string, unknown>;
  // Data depth
  googleReviews?: number;
  websiteCrawlMaxPages?: number;
  reviewsPerSite?: number;
  // Analysis
  imageVisionEnabled?: boolean;
  maxImagesAnalyzed?: number;
  synthesisQuality?: string;
  perRunCostCapUsd?: number;
};

const QUALITY_VALUES = new Set(["economy", "standard", "high"]);

function intInRange(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  if (v < min || v > max) return null;
  return v;
}

// A clean { string: boolean } map only — guards the jsonb override column
// against arbitrary nested payloads.
function boolMap(v: unknown): Record<string, boolean> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "boolean") return null;
    out[k] = val;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  const admin = adminClient(envRes.env);
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const patch: Record<string, unknown> = {};

  if (body.saveSnapshots !== undefined) {
    if (typeof body.saveSnapshots !== "boolean") {
      return json({ ok: false, error: "saveSnapshots must be a boolean" }, 400);
    }
    patch.atlas_save_snapshots = body.saveSnapshots;
  }

  if (body.snapshotOnBusinessEdit !== undefined) {
    if (typeof body.snapshotOnBusinessEdit !== "boolean") {
      return json(
        { ok: false, error: "snapshotOnBusinessEdit must be a boolean" },
        400,
      );
    }
    patch.atlas_snapshot_on_business_edit = body.snapshotOnBusinessEdit;
  }

  if (body.googleImages !== undefined) {
    const n = intInRange(body.googleImages, 0, 20);
    if (n === null) {
      return json(
        { ok: false, error: "googleImages must be an integer 0-20" },
        400,
      );
    }
    patch.atlas_research_google_images = n;
  }

  if (body.instagramPosts !== undefined) {
    const n = intInRange(body.instagramPosts, 0, 50);
    if (n === null) {
      return json(
        { ok: false, error: "instagramPosts must be an integer 0-50" },
        400,
      );
    }
    patch.atlas_research_instagram_posts = n;
  }

  // ── Sourcing ──────────────────────────────────────────────────────────
  if (body.sourceTierCeiling !== undefined) {
    const n = intInRange(body.sourceTierCeiling, 1, 5);
    if (n === null) {
      return json(
        { ok: false, error: "sourceTierCeiling must be an integer 1-5" },
        400,
      );
    }
    patch.atlas_source_tier_ceiling = n;
  }

  if (body.sourceOverrides !== undefined) {
    const map = boolMap(body.sourceOverrides);
    if (map === null) {
      return json(
        { ok: false, error: "sourceOverrides must be a { string: boolean } map" },
        400,
      );
    }
    patch.atlas_source_overrides = map;
  }

  // ── Data depth ────────────────────────────────────────────────────────
  if (body.googleReviews !== undefined) {
    const n = intInRange(body.googleReviews, 0, 5);
    if (n === null) {
      return json({ ok: false, error: "googleReviews must be an integer 0-5" }, 400);
    }
    patch.atlas_google_reviews = n;
  }

  if (body.websiteCrawlMaxPages !== undefined) {
    const n = intInRange(body.websiteCrawlMaxPages, 1, 20);
    if (n === null) {
      return json(
        { ok: false, error: "websiteCrawlMaxPages must be an integer 1-20" },
        400,
      );
    }
    patch.atlas_website_crawl_max_pages = n;
  }

  if (body.reviewsPerSite !== undefined) {
    const n = intInRange(body.reviewsPerSite, 0, 30);
    if (n === null) {
      return json({ ok: false, error: "reviewsPerSite must be an integer 0-30" }, 400);
    }
    patch.atlas_reviews_per_site = n;
  }

  // ── Analysis ──────────────────────────────────────────────────────────
  if (body.imageVisionEnabled !== undefined) {
    if (typeof body.imageVisionEnabled !== "boolean") {
      return json({ ok: false, error: "imageVisionEnabled must be a boolean" }, 400);
    }
    patch.atlas_image_vision_enabled = body.imageVisionEnabled;
  }

  if (body.maxImagesAnalyzed !== undefined) {
    const n = intInRange(body.maxImagesAnalyzed, 0, 100);
    if (n === null) {
      return json(
        { ok: false, error: "maxImagesAnalyzed must be an integer 0-100" },
        400,
      );
    }
    patch.atlas_max_images_analyzed = n;
  }

  if (body.synthesisQuality !== undefined) {
    if (
      typeof body.synthesisQuality !== "string" ||
      !QUALITY_VALUES.has(body.synthesisQuality)
    ) {
      return json(
        { ok: false, error: "synthesisQuality must be economy, standard, or high" },
        400,
      );
    }
    patch.atlas_synthesis_quality = body.synthesisQuality;
  }

  if (body.perRunCostCapUsd !== undefined) {
    if (typeof body.perRunCostCapUsd !== "number" || body.perRunCostCapUsd < 0) {
      return json(
        { ok: false, error: "perRunCostCapUsd must be a number >= 0" },
        400,
      );
    }
    // Cap precision to 2 decimals to match numeric(8,2).
    patch.atlas_per_run_cost_cap_usd = Math.round(body.perRunCostCapUsd * 100) / 100;
  }

  if (Object.keys(patch).length === 0) {
    return json({ ok: false, error: "Nothing to update" }, 400);
  }
  patch.updated_by = userId;

  const { data, error } = await admin
    .from("app_settings")
    .update(patch)
    .eq("id", 1)
    .select(
      "atlas_save_snapshots, atlas_snapshot_on_business_edit, atlas_research_google_images, atlas_research_instagram_posts, atlas_source_tier_ceiling, atlas_source_overrides, atlas_google_reviews, atlas_website_crawl_max_pages, atlas_reviews_per_site, atlas_image_vision_enabled, atlas_max_images_analyzed, atlas_synthesis_quality, atlas_per_run_cost_cap_usd, updated_at",
    )
    .single();
  if (error) {
    return json(
      { ok: false, error: `settings_update: ${error.message}` },
      500,
    );
  }

  return json({
    ok: true,
    atlasSaveSnapshots: data.atlas_save_snapshots,
    atlasSnapshotOnBusinessEdit: data.atlas_snapshot_on_business_edit,
    atlasResearchGoogleImages: data.atlas_research_google_images,
    atlasResearchInstagramPosts: data.atlas_research_instagram_posts,
    atlasSourceTierCeiling: data.atlas_source_tier_ceiling,
    atlasSourceOverrides: data.atlas_source_overrides,
    atlasGoogleReviews: data.atlas_google_reviews,
    atlasWebsiteCrawlMaxPages: data.atlas_website_crawl_max_pages,
    atlasReviewsPerSite: data.atlas_reviews_per_site,
    atlasImageVisionEnabled: data.atlas_image_vision_enabled,
    atlasMaxImagesAnalyzed: data.atlas_max_images_analyzed,
    atlasSynthesisQuality: data.atlas_synthesis_quality,
    atlasPerRunCostCapUsd: data.atlas_per_run_cost_cap_usd,
    updatedAt: data.updated_at,
  });
});
