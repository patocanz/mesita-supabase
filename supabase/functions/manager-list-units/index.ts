// Supabase Edge Function — manager-list-units
//
// Authenticated. Returns every venue the caller is a member of, regardless
// of status (so paused / archived rows are visible to the owner). Self-
// contained: own auth check, own DB query; never calls other Edge Functions.
//
// Local:  supabase functions serve manager-list-units
// Deploy: supabase functions deploy manager-list-units

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ ok: false, error: "Missing bearer token" }, 401);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return json({ ok: false, error: "Invalid session" }, 401);
  }
  const userId = userData.user.id;

  // Service role: we want to read regardless of venue status (paused /
  // archived rows belong to the owner too). RLS would filter those out for
  // the user JWT path.
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await admin
    .from("venue_members")
    .select(
      "role, venue:venues(id, slug, name, category, vibe, price_level, listing_type, status, lat, lng, address, closes_at, phone, pitch, story, cashback_percent, photos, created_at, updated_at)",
    )
    .eq("manager_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    return json({ ok: false, error: error.message }, 500);
  }

  // Flatten — frontend only needs the venue + the caller's role within it.
  type Row = { role: string; venue: Record<string, unknown> | null };
  const rows = (data ?? []) as Row[];
  const venues = rows
    .filter((r) => r.venue != null)
    .map((r) => ({ ...r.venue!, my_role: r.role }));

  return json({ ok: true, venues });
});
