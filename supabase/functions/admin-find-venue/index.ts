// Supabase Edge Function — admin-find-venue
//
// Resolves a Google Place ID to a Mesita venue (id + name + slug) when
// the venue is already onboarded. Used by the admin console's deep-link
// generator: the admin pastes a Place ID, this EF returns the venue.id,
// and the admin web builds a https://manager.mesita.ai/super-admin/enter
// URL pointing at /unit/<id>/place.
//
// Admin auth: `x-admin-key` header == `ADMIN_ACCESS_KEY` env. No JWT.
// Same pattern as admin-search-places — jwt verification is disabled on
// this function in config.toml.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = { placeId?: unknown };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" });

  const expectedAdminKey = Deno.env.get("ADMIN_ACCESS_KEY");
  if (!expectedAdminKey) {
    return json({
      ok: false,
      code: "server_missing_admin_key",
      error: "ADMIN_ACCESS_KEY not set in Supabase secrets.",
    });
  }
  const providedAdminKey = req.headers.get("x-admin-key") ?? "";
  if (providedAdminKey !== expectedAdminKey) {
    return json({ ok: false, code: "unauthorized", error: "Unauthorized" });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" });
  }
  const placeId =
    typeof body.placeId === "string" ? body.placeId.trim() : "";
  if (!placeId) {
    return json({ ok: false, error: "placeId is required" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin
    .from("venues")
    .select("id, slug, name, status, created_at, updated_at")
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (error) {
    return json({ ok: false, error: `lookup_failed: ${error.message}` });
  }
  if (!data) {
    return json({ ok: true, venue: null });
  }
  return json({ ok: true, venue: data });
});
