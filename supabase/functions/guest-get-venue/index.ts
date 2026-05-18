// Supabase Edge Function — guest-get-venue
//
// Public. Returns a single venue by id (uuid) or slug, plus the manager
// authority info needed for the detail page (vibe / channels / etc.).
// Anon-readable but the venues RLS policy still gates which rows ship.
//
// Caller: guest. Verb: get. Noun: venue. (Per the new <caller>-<verb>-<noun>
// naming convention.)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const VENUE_COLUMNS =
  "id, slug, name, category, vibe, price_level, listing_type, status, fiscal_type, plan, lat, lng, address, closes_at, phone, pitch, story, cashback_percent, photos, website_url, instagram_url, tiktok_url, facebook_url, whatsapp_url, opentable_url, resy_url, uber_eats_url, rappi_url, created_at";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { id?: string; slug?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !ANON_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const idOrSlug = (body.id ?? body.slug ?? "").toString().trim();
  if (!idOrSlug) {
    return json({ ok: false, error: "id or slug is required" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, ANON_KEY);
  const column = UUID_RE.test(idOrSlug) ? "id" : "slug";

  const { data, error } = await supabase
    .from("venues")
    .select(VENUE_COLUMNS)
    .eq(column, idOrSlug)
    .maybeSingle();

  if (error) return json({ ok: false, error: error.message }, 500);
  if (!data) return json({ ok: false, error: "Venue not found" }, 404);

  return json({ ok: true, venue: data });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
