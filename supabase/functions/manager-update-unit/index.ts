// Supabase Edge Function — manager-update-unit
//
// Authenticated. Updates editable fields on a venue the caller owns or
// manages. Self-contained: verifies the JWT, checks venue_members membership
// itself, validates input, writes via service role. Does NOT call any other
// Edge Function.
//
// Local:  supabase functions serve manager-update-unit
// Deploy: supabase functions deploy manager-update-unit

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

const MAX_PHOTOS = 30;
const MAX_TAGS = 12;
const MAX_TAG_LEN = 40;
const MAX_PR_LINKS = 10;
const MAX_DESCRIPTION_LEN = 600;

type UpdateBody = {
  id?: string;
  name?: string | null;
  category?: string | null;
  vibe?: string | null;
  price_level?: number | null;
  status?: "active" | "paused" | "archived";
  fiscal_type?: "formal" | "informal";
  plan?:
    | "free"
    | "formal_pro"
    | "formal_ultra"
    | "informal_pro"
    | "informal_ultra";
  address?: string | null;
  closes_at?: string | null;
  phone?: string | null;
  pitch?: string | null;
  story?: string | null;
  cashback_percent?: number | null;
  photos?: string[];
  // External + social channels
  website_url?: string | null;
  instagram_url?: string | null;
  tiktok_url?: string | null;
  facebook_url?: string | null;
  whatsapp_url?: string | null;
  opentable_url?: string | null;
  resy_url?: string | null;
  uber_eats_url?: string | null;
  rappi_url?: string | null;
  x_url?: string | null;
  youtube_url?: string | null;
  threads_url?: string | null;
  reddit_url?: string | null;
  didi_food_url?: string | null;
  tripadvisor_url?: string | null;
  google_maps_url?: string | null;
  // Plain contact (not URL-shaped)
  email?: string | null;
  // Place-redesign editable surface (Manager-E=YES on the Components spec).
  description?: string | null;
  menu_pdf_url?: string | null;
  tags?: string[];
  whatsapp_pr_urls?: string[];
  instagram_pr_urls?: string[];
};

const URL_FIELDS = [
  "website_url",
  "instagram_url",
  "tiktok_url",
  "facebook_url",
  "whatsapp_url",
  "opentable_url",
  "resy_url",
  "uber_eats_url",
  "rappi_url",
  "x_url",
  "youtube_url",
  "threads_url",
  "reddit_url",
  "didi_food_url",
  "tripadvisor_url",
  "google_maps_url",
] as const;
type UrlField = (typeof URL_FIELDS)[number];

const EDITABLE_STATUSES = new Set(["active", "paused", "archived"]);

// Plan catalog the EF accepts. formal_ultra / informal_ultra are kept
// for backwards compatibility with rows written before the tier was
// retired — new plan picks come in as free | formal_pro | informal_pro.
const VALID_PLANS = new Set([
  "free",
  "formal_pro",
  "formal_ultra",
  "informal_pro",
  "informal_ultra",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

  // Auth: any signed-in user. Super-admin elevation (skips the
  // venue_members check) is granted when the caller's email is in
  // public.super_admins.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ ok: false, error: "Missing bearer token" }, 401);
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return json({ ok: false, error: "Invalid session" }, 401);
  }
  const userId = userData.user.id;
  const userEmail = userData.user.email ?? null;

  // Allowlist check. Lazy-backfill user_id so future audit logs can join
  // by uuid without re-reading auth.users.
  let isSuperAdmin = false;
  const emailLower = userEmail?.toLowerCase() ?? null;
  if (emailLower) {
    const { data: saRow } = await admin
      .from("super_admins")
      .select("email, user_id")
      .eq("email", emailLower)
      .maybeSingle();
    if (saRow) {
      isSuperAdmin = true;
      if (saRow.user_id == null) {
        void admin
          .from("super_admins")
          .update({ user_id: userId })
          .eq("email", emailLower)
          .is("user_id", null);
      }
    }
  }

  // Parse + validate.
  let body: UpdateBody = {};
  try {
    body = (await req.json()) as UpdateBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const venueId = (body.id ?? "").toString().trim();
  if (!venueId) return json({ ok: false, error: "id is required" }, 400);

  if (!isSuperAdmin) {
    const { data: membership, error: membershipError } = await admin
      .from("venue_members")
      .select("role")
      .eq("venue_id", venueId)
      .eq("manager_id", userId)
      .maybeSingle();
    if (membershipError) {
      return json({ ok: false, error: `membership_lookup: ${membershipError.message}` }, 500);
    }
    if (!membership) {
      return json({ ok: false, error: "Not a member of this venue" }, 403);
    }
  }

  // Build the update payload from the whitelist. Missing keys are not
  // touched. Explicit null clears the field.
  const update: Record<string, unknown> = {};
  if ("name" in body) {
    const n = (body.name ?? "").toString().trim();
    if (!n) return json({ ok: false, error: "name cannot be empty" }, 400);
    if (n.length > 120) return json({ ok: false, error: "name too long" }, 400);
    update.name = n;
  }
  if ("category" in body) update.category = optString(body.category, 80);
  if ("vibe" in body) update.vibe = optString(body.vibe, 80);
  if ("price_level" in body) update.price_level = body.price_level == null ? null : clampInt(body.price_level, 1, 4);
  if ("status" in body) {
    const s = body.status;
    if (!s || !EDITABLE_STATUSES.has(s)) {
      return json({ ok: false, error: "status must be active|paused|archived" }, 400);
    }
    update.status = s;
  }
  if ("fiscal_type" in body) {
    const f = body.fiscal_type;
    if (f !== "formal" && f !== "informal") {
      return json(
        { ok: false, error: "fiscal_type must be 'formal' or 'informal'" },
        400,
      );
    }
    update.fiscal_type = f;
  }
  if ("plan" in body) {
    const p = body.plan;
    if (!p || !VALID_PLANS.has(p)) {
      return json(
        {
          ok: false,
          error: "plan must be one of free | formal_pro | formal_ultra | informal_pro | informal_ultra",
        },
        400,
      );
    }
    // Mechanic-fiscal coupling: a formal plan only makes sense on a formal
    // venue, and vice versa. We look up the current row to validate against
    // the venue's fiscal_type (or the new fiscal_type the same request is
    // trying to set, whichever wins).
    const incomingFiscal = (update.fiscal_type as string | undefined) ?? null;
    if (p.startsWith("formal_") && incomingFiscal === "informal") {
      return json(
        {
          ok: false,
          code: "plan_fiscal_mismatch",
          error: "Formal plans can't be picked while the venue is set to informal. Change fiscal_type first.",
        },
        409,
      );
    }
    if (p.startsWith("informal_") && incomingFiscal === "formal") {
      return json(
        {
          ok: false,
          code: "plan_fiscal_mismatch",
          error: "Informal plans can't be picked while the venue is set to formal. Change fiscal_type first.",
        },
        409,
      );
    }
    update.plan = p;
  }
  if ("address" in body) update.address = optString(body.address, 300);
  if ("closes_at" in body) {
    const raw = optString(body.closes_at, 5);
    if (raw != null && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(raw)) {
      return json(
        { ok: false, error: "closes_at must be 24h HH:MM (e.g. 02:00)" },
        400,
      );
    }
    update.closes_at = raw;
  }
  if ("phone" in body) update.phone = optString(body.phone, 40);
  if ("pitch" in body) update.pitch = optString(body.pitch, 200);
  if ("story" in body) update.story = optString(body.story, 1500);
  if ("cashback_percent" in body) {
    update.cashback_percent =
      body.cashback_percent == null ? null : clampInt(body.cashback_percent, 0, 100);
  }
  if ("photos" in body) {
    if (!Array.isArray(body.photos)) {
      return json({ ok: false, error: "photos must be an array of URL strings" }, 400);
    }
    const clean = body.photos.filter(isUrl).slice(0, MAX_PHOTOS);
    update.photos = clean;
  }

  // External + social URLs — each optional, each validated to https://.
  for (const field of URL_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field as UrlField];
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
      update[field] = null;
      continue;
    }
    if (!isUrl(raw)) {
      return json({ ok: false, error: `${field} must be a valid https:// URL` }, 400);
    }
    update[field] = raw.trim();
  }

  // Place-redesign editable fields.
  if ("description" in body) {
    update.description = optString(body.description, MAX_DESCRIPTION_LEN);
  }
  if ("menu_pdf_url" in body) {
    const raw = body.menu_pdf_url;
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
      update.menu_pdf_url = null;
    } else if (!isUrl(raw)) {
      return json({ ok: false, error: "menu_pdf_url must be a valid https:// URL" }, 400);
    } else {
      update.menu_pdf_url = raw.trim();
    }
  }
  if ("tags" in body) {
    if (!Array.isArray(body.tags)) {
      return json({ ok: false, error: "tags must be an array of strings" }, 400);
    }
    // Lowercase + trim + dedupe in one pass. Empty entries drop out so the
    // form can submit a partially typed list without rejecting the request.
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const t of body.tags) {
      if (typeof t !== "string") continue;
      const norm = t.trim().toLowerCase().slice(0, MAX_TAG_LEN);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      clean.push(norm);
      if (clean.length >= MAX_TAGS) break;
    }
    update.tags = clean;
  }
  for (const arrayField of ["whatsapp_pr_urls", "instagram_pr_urls"] as const) {
    if (!(arrayField in body)) continue;
    const value = body[arrayField];
    if (!Array.isArray(value)) {
      return json({ ok: false, error: `${arrayField} must be an array of https:// URLs` }, 400);
    }
    const clean = value.filter(isUrl).slice(0, MAX_PR_LINKS);
    update[arrayField] = clean;
  }

  // Email: not a URL. Just trim + sanity-check the shape (has @ and a dot
  // after it). Empty / null clears the field.
  if ("email" in body) {
    const raw = body.email;
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
      update.email = null;
    } else if (typeof raw !== "string") {
      return json({ ok: false, error: "email must be a string" }, 400);
    } else {
      const trimmed = raw.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return json({ ok: false, error: "email must look like name@domain.tld" }, 400);
      }
      if (trimmed.length > 254) {
        return json({ ok: false, error: "email too long" }, 400);
      }
      update.email = trimmed.toLowerCase();
    }
  }

  if (Object.keys(update).length === 0) {
    return json({ ok: false, error: "No editable fields provided" }, 400);
  }

  const { data: venue, error: updateError } = await admin
    .from("venues")
    .update(update)
    .eq("id", venueId)
    .select(
      "id, slug, name, category, vibe, price_level, listing_type, status, fiscal_type, plan, lat, lng, address, closes_at, hours, phone, pitch, story, description, cashback_percent, photos, menu_pdf_url, tags, whatsapp_pr_urls, instagram_pr_urls, website_url, instagram_url, tiktok_url, facebook_url, whatsapp_url, opentable_url, resy_url, uber_eats_url, rappi_url, x_url, youtube_url, threads_url, reddit_url, didi_food_url, tripadvisor_url, google_maps_url, google_business_url, google_stars_overall, google_review_count, google_visitor_count, mesita_stars_overall, mesita_stars_food, mesita_stars_service, mesita_stars_ambience, mesita_review_count, mesita_visitor_count, instagram_followers_count, email, created_at, updated_at",
    )
    .single();
  if (updateError) {
    return json(
      { ok: false, error: `venue_update: ${updateError.message}`, code: updateError.code ?? null },
      400,
    );
  }

  return json({ ok: true, venue });
});

function optString(v: unknown, maxLen: number): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function clampInt(n: unknown, lo: number, hi: number): number | null {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
}

function isUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    // Require https — http:// breaks mixed-content guards in the browser.
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

