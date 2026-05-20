// Supabase Edge Function — manager-lookup-venue
//
// Returns the Mesita state of a venue keyed by Google Place ID, so the
// /add page can show the right UI without redirecting:
//
//   not_in_mesita            — no venue row exists for this Place ID.
//                              Caller can ask manager-create-unit to
//                              generate one.
//   web_listed_unclaimed     — venue exists, listing_type='web', no
//                              owner. Caller can submit a verification.
//   pending_by_me            — venue exists, no owner, caller has a
//                              pending venue_verifications row.
//   pending_by_other         — venue exists, no owner, someone else has
//                              a pending verification (caller can still
//                              submit their own).
//   verified_partner         — venue exists and has an owner. Caller
//                              must use the contact / report-fraud flow.
//
// Auth: any signed-in user.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = { placeId?: string };

const VENUE_COLUMNS =
  "id, slug, name, status, listing_type, address, phone, photos, category, vibe, cashback_percent, created_at, updated_at";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

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
  const placeId = (body.placeId ?? "").trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Venue row by Place ID.
  const { data: venue, error: venueError } = await admin
    .from("venues")
    .select(VENUE_COLUMNS)
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (venueError) {
    return json(
      { ok: false, error: `venue_lookup: ${venueError.message}` },
      500,
    );
  }
  if (!venue) {
    return json({ ok: true, state: "not_in_mesita", venue: null });
  }

  // 2. Owner check via venue_members.
  const { data: owner } = await admin
    .from("venue_members")
    .select("manager_id, role")
    .eq("venue_id", venue.id)
    .eq("role", "owner")
    .maybeSingle();

  if (owner) {
    // Pull the owner's email from auth.users so the UI can surface
    // "owned by X" + offer Contact / Report fraud.
    const { data: ownerUser } = await admin.auth.admin.getUserById(
      owner.manager_id,
    );
    return json({
      ok: true,
      state: "verified_partner",
      venue,
      owner: {
        id: owner.manager_id,
        email: ownerUser?.user?.email ?? null,
      },
    });
  }

  // 3. No owner yet — look for pending verifications.
  const { data: pendingForMe } = await admin
    .from("venue_verifications")
    .select(
      "id, method, payload, requester_email, status, reject_reason, decided_at, decided_via, created_at",
    )
    .eq("venue_id", venue.id)
    .eq("requester_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pendingForMe) {
    return json({
      ok: true,
      state: "pending_by_me",
      venue,
      verification: pendingForMe,
    });
  }

  // 4. Pending claim from a different user (informational — caller can
  // still submit their own).
  const { data: pendingByOther } = await admin
    .from("venue_verifications")
    .select("id")
    .eq("venue_id", venue.id)
    .eq("status", "pending")
    .neq("requester_id", userId)
    .limit(1)
    .maybeSingle();
  if (pendingByOther) {
    return json({ ok: true, state: "pending_by_other", venue });
  }

  // 5. Default: unclaimed and unmolested.
  return json({ ok: true, state: "web_listed_unclaimed", venue });
});
