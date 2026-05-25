// Supabase Edge Function — business-list-units
//
// Authenticated. Returns every venue the caller is a member of,
// regardless of status (so paused / archived rows are visible to the
// owner).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { VENUE_BUSINESS_COLUMNS } from "../_shared/venue-columns.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  // Service role: read regardless of venue status (paused / archived
  // rows belong to the owner too). RLS would filter those out for the
  // user JWT path.
  const admin = adminClient(envRes.env);

  const { data, error } = await admin
    .from("venue_members")
    .select(`role, venue:venues(${VENUE_BUSINESS_COLUMNS})`)
    .eq("business_id", authRes.user.id)
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
