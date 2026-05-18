// Supabase Edge Function — guest-list-venues
//
// Public endpoint. Returns venues that are visible to guests
// (status in 'active', 'lead'). Self-contained: no calls to other functions.
//
// Local:  supabase functions serve guest-list-venues
// Deploy: supabase functions deploy guest-list-venues

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type ListBody = { limit?: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    return jsonResponse({ ok: false, error: "Server misconfigured" }, 500);
  }

  // Anon client is sufficient: the venues RLS policy already restricts SELECT
  // to status in ('active', 'lead') for anon + authenticated. This is the
  // single source of truth for what guests are allowed to see.
  const supabase = createClient(supabaseUrl, anonKey);

  // Limit can come from a JSON body (POST from supabase.functions.invoke) or
  // a query string (?limit=… for raw GETs). Body wins if both are present.
  let limit = DEFAULT_LIMIT;
  if (req.method === "POST") {
    try {
      const body = (await req.json()) as ListBody;
      if (typeof body?.limit === "number") {
        limit = clampLimit(body.limit);
      }
    } catch {
      // empty / non-JSON body — fall through to default
    }
  } else {
    const q = Number(new URL(req.url).searchParams.get("limit"));
    if (Number.isFinite(q)) limit = clampLimit(q);
  }

  const { data, error } = await supabase
    .from("venues")
    .select(
      "id, slug, name, category, vibe, price_level, listing_type, status, fiscal_type, plan, lat, lng, address, closes_at, phone, pitch, story, cashback_percent, photos, website_url, instagram_url, tiktok_url, facebook_url, whatsapp_url, opentable_url, resy_url, uber_eats_url, rappi_url, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return jsonResponse({ ok: false, error: error.message }, 500);
  }

  return jsonResponse({ ok: true, venues: data ?? [] });
});

function clampLimit(n: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
