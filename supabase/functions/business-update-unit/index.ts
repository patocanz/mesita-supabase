// Supabase Edge Function — business-update-unit
//
// Authenticated. Updates editable fields on a venue the caller owns or
// manages. Self-contained: verifies the JWT, checks venue_members membership
// itself, validates input, writes via service role. Does NOT call any other
// Edge Function.
//
// Local:  supabase functions serve business-update-unit
// Deploy: supabase functions deploy business-update-unit

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  checkSuperAdmin,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { isEmailish } from "../_shared/input.ts";
import { VENUE_BUSINESS_COLUMNS } from "../_shared/venue-columns.ts";

const MAX_PHOTOS = 30;
const MAX_TAGS = 12;
const MAX_TAG_LEN = 40;
const MAX_PR_LINKS = 10;
// Matches the business Place editor's textarea cap (EditVenueForm
// DESCRIPTION_MAX). Atlas writes at most 1000 of these chars; the business can
// manually expand the description up to the full 2000.
const MAX_DESCRIPTION_LEN = 2000;

type UpdateBody = {
  id?: string;
  name?: string | null;
  category?: string | null;
  vibe?: string | null;
  price_level?: number | null;
  // ISO 4217 code. Mesita defaults every venue to MXN; the business
  // can switch to USD/EUR/etc. only when we extend coverage outside
  // Mexico. Kept as text so the EF doesn't hard-code an enum.
  currency?: string | null;
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
  hours?: VenueHours | null;
  phone?: string | null;
  pitch?: string | null;
  story?: string | null;
  cashback_percent?: number | null;
  // Four per-tier promo rates (migration 0032). Welcome variants fire on a
  // guest's first visit at the venue; the unprefixed variants apply on every
  // visit afterwards. DB constraint enforces the legal set {10, 20, 50, 70}.
  welcome_free_rate?: number | null;
  welcome_premium_rate?: number | null;
  free_rate?: number | null;
  premium_rate?: number | null;
  // Venue-level monthly promo spend cap (migration 0038), in the venue's
  // currency. One of 200, 500, 1000, 2000 or null (no cap).
  monthly_promo_cap?: number | null;
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
  // Place-redesign editable surface (Business-E=YES on the Components spec).
  description?: string | null;
  menu_pdf_url?: string | null;
  // Optional human label paired with menu_pdf_url. Null clears.
  menu_pdf_name?: string | null;
  tags?: string[];
  whatsapp_pr_urls?: string[];
  instagram_pr_urls?: string[];
  // Promos page section toggles — Basic + Advanced segmentation can be
  // collapsed by the business. Defaults align with the migration: basic
  // on, advanced off.
  segmentation_basic_enabled?: boolean;
  segmentation_advanced_enabled?: boolean;
};

type HoursRange = { open: string; close: string };
type DayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";
type VenueHours = Partial<Record<DayKey, HoursRange[]>>;

const DAY_KEYS: DayKey[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

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

// Plan catalog the EF accepts — all five tiers in the venue_plan enum.
// Ordered Free → Pro (formal/informal) → Ultra (formal/informal). The
// mechanic (cashback vs discount) is fixed by fiscal_type; Pro vs Ultra
// only changes price + visibility tier. See business UI plans.ts for the
// picker catalog this is the server-side counterpart of.
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

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  // Auth: any signed-in user. Super-admin elevation (skips the
  // venue_members check) is granted when the caller's email is in
  // public.super_admins.
  const admin = adminClient(envRes.env);
  const isSuperAdmin = await checkSuperAdmin(admin, authRes.user);

  // Parse + validate.
  const bodyRes = await readJson<UpdateBody>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const venueId = (body.id ?? "").toString().trim();
  if (!venueId) return json({ ok: false, error: "id is required" }, 400);

  if (!isSuperAdmin) {
    const { data: membership, error: membershipError } = await admin
      .from("venue_members")
      .select("role")
      .eq("venue_id", venueId)
      .eq("business_id", userId)
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
  // currency: ISO 4217 uppercase code, 3 chars. Reject anything else
  // — accidental empty strings or longer strings would corrupt every
  // monetary render downstream.
  if ("currency" in body) {
    const c = (body.currency ?? "").toString().trim().toUpperCase();
    if (c.length === 3 && /^[A-Z]{3}$/.test(c)) update.currency = c;
  }
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
  if ("hours" in body) {
    const cleaned = sanitiseHours(body.hours);
    if (cleaned === "invalid") {
      return json(
        { ok: false, error: "hours must be a map of weekday → [{open,close}] with HH:MM values" },
        400,
      );
    }
    update.hours = cleaned;
  }
  if ("phone" in body) update.phone = optString(body.phone, 40);
  if ("pitch" in body) update.pitch = optString(body.pitch, 200);
  if ("story" in body) update.story = optString(body.story, 1500);
  if ("cashback_percent" in body) {
    update.cashback_percent =
      body.cashback_percent == null ? null : clampInt(body.cashback_percent, 0, 100);
  }

  // Four per-tier promo rates. Each is nullable (null clears the offer) or
  // one of {10, 20, 50, 70}. The DB has a matching CHECK constraint so a
  // mis-shaped client can't slip through; this is the friendly 400 layer.
  const PROMO_RATE_FIELDS = [
    "welcome_free_rate",
    "welcome_premium_rate",
    "free_rate",
    "premium_rate",
  ] as const;
  const LEGAL_PROMO_RATES = new Set([10, 20, 50, 70]);
  for (const field of PROMO_RATE_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw == null) {
      update[field] = null;
      continue;
    }
    const v = Number(raw);
    if (!LEGAL_PROMO_RATES.has(v)) {
      return json(
        { ok: false, error: `${field} must be null or one of 10, 20, 50, 70` },
        400,
      );
    }
    update[field] = v;
  }

  // Monthly promo spend cap. Nullable (null clears the ceiling) or one of
  // {200, 500, 1000, 2000}. DB CHECK mirrors this; this is the friendly 400.
  if ("monthly_promo_cap" in body) {
    const raw = body.monthly_promo_cap;
    if (raw == null) {
      update.monthly_promo_cap = null;
    } else {
      const v = Number(raw);
      if (![200, 500, 1000, 2000].includes(v)) {
        return json(
          { ok: false, error: "monthly_promo_cap must be null or one of 200, 500, 1000, 2000" },
          400,
        );
      }
      update.monthly_promo_cap = v;
    }
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
  if ("menu_pdf_name" in body) {
    update.menu_pdf_name = optString(body.menu_pdf_name, 80);
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

  // Promos section toggles. Strict boolean only — silently coerce
  // truthy / "true" strings would let stale clients write garbage.
  for (const boolField of [
    "segmentation_basic_enabled",
    "segmentation_advanced_enabled",
  ] as const) {
    if (!(boolField in body)) continue;
    const value = body[boolField];
    if (typeof value !== "boolean") {
      return json({ ok: false, error: `${boolField} must be boolean` }, 400);
    }
    update[boolField] = value;
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
      if (!isEmailish(trimmed)) {
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
    .select(VENUE_BUSINESS_COLUMNS)
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

// "invalid" is the only failure sentinel so the caller can return a single
// 400. Null means the business intentionally cleared their hours. Empty object
// is permitted — the venue is open zero days.
function sanitiseHours(v: unknown): VenueHours | null | "invalid" {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return "invalid";
  const input = v as Record<string, unknown>;
  const out: VenueHours = {};
  for (const day of DAY_KEYS) {
    if (!(day in input)) continue;
    const ranges = input[day];
    if (ranges == null) continue;
    if (!Array.isArray(ranges)) return "invalid";
    const cleanRanges: HoursRange[] = [];
    for (const r of ranges) {
      if (!r || typeof r !== "object") return "invalid";
      const open = (r as { open?: unknown }).open;
      const close = (r as { close?: unknown }).close;
      if (typeof open !== "string" || typeof close !== "string") return "invalid";
      if (!HHMM_RE.test(open) || !HHMM_RE.test(close)) return "invalid";
      cleanRanges.push({ open, close });
    }
    if (cleanRanges.length > 0) out[day] = cleanRanges;
  }
  return out;
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

