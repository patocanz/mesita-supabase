// Supabase Edge Function — tickets-venue-recent
//
// Authenticated. Returns the most recent tickets for a venue the caller is
// a member of. Joins the guest's display fields (code, full name) for the
// validator UI. Self-contained.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type Body = { venueId?: string; limit?: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

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

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const venueId = (body.venueId ?? "").toString().trim();
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  const limit = Math.max(
    1,
    Math.min(MAX_LIMIT, Math.trunc(Number(body.limit ?? DEFAULT_LIMIT))),
  );

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const membership = await admin
    .from("venue_members")
    .select("role")
    .eq("venue_id", venueId)
    .eq("manager_id", userId)
    .maybeSingle();
  if (membership.error) {
    return json({ ok: false, error: `membership: ${membership.error.message}` }, 500);
  }
  if (!membership.data) {
    return json({ ok: false, error: "Not a member of this venue" }, 403);
  }

  const { data, error } = await admin
    .from("tickets")
    .select(
      "id, kind, status, story_status, story_screenshot_url, story_submitted_at, story_verified_at, story_reject_reason, check_subtotal_cents, tip_cents, total_cents, cashback_percent, cashback_cents, redeem_cents, discount_percent, discount_cents, revealed_at, reservation_status, reservation_at, reservation_party_size, currency, created_at, paid_at, cancelled_at, cancel_reason, guest:guests(id, code, full_name)",
    )
    .eq("venue_id", venueId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return json({ ok: false, error: error.message }, 500);
  }

  return json({ ok: true, tickets: data ?? [] });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
