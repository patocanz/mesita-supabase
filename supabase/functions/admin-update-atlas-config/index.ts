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
};

function intInRange(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  if (v < min || v > max) return null;
  return v;
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

  if (Object.keys(patch).length === 0) {
    return json({ ok: false, error: "Nothing to update" }, 400);
  }
  patch.updated_by = userId;

  const { data, error } = await admin
    .from("app_settings")
    .update(patch)
    .eq("id", 1)
    .select(
      "atlas_save_snapshots, atlas_snapshot_on_business_edit, atlas_research_google_images, atlas_research_instagram_posts, updated_at",
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
    updatedAt: data.updated_at,
  });
});
