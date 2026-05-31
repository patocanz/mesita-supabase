// Supabase Edge Function — consumer-list-saved-venues (natural caller)
//
// Authenticated read of the caller's bookmarks. Returns saved_venues
// joined with the venue summary the saved card needs (name, slug,
// hero photo, category, price level, distance computed client-side).
//
// Deploy: supabase functions deploy consumer-list-saved-venues

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { clampIntRange, corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const consumerId = authRes.user.id;

  let limit = DEFAULT_LIMIT;
  if (req.method === "POST") {
    const body = await readJsonOr<{ limit?: number }>(req, {});
    if (typeof body.limit === "number") {
      limit = clampIntRange(body.limit, 1, MAX_LIMIT);
    }
  }

  const admin = adminClient(envRes.env);

  const { data, error } = await admin
    .from("saved_venues")
    .select(
      "id, created_at, venue:venues(id, slug, name, category, price_level, listing_type, photos, address, lat, lng)",
    )
    .eq("consumer_id", consumerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, saved_venues: data ?? [] });
});
