// Supabase Edge Function — business-lookup-venue
//
// Returns the Mesita state of a venue keyed by Google Place ID, so the
// /add page can show the right UI without redirecting:
//
//   not_in_mesita            — no venue row exists for this Place ID.
//                              Caller can ask business-create-unit to
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
// Every claim-able state (web_listed_unclaimed, pending_by_me,
// pending_by_other) carries a `methods` block describing which auto-
// verify paths the UI should surface:
//
//   methods.phone   — available when venues.phone is non-null.
//   methods.email   — available when venues.email is on-domain (its
//                     host matches the website_url host, ±www. and
//                     subdomain).
//
// The third "Talk to us" option (WhatsApp deep-link) is always shown
// by the UI and doesn't need a server hint — it's a static fallback
// channel handled entirely on the FE.
//
// Auth: any signed-in user.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { isOnDomain } from "../_shared/onboarding.ts";

type Body = { placeId?: string };

const VENUE_COLUMNS =
  "id, slug, name, status, listing_type, address, phone, email, website_url, photos, category, vibe, cashback_percent, created_at, updated_at";

type VenueRow = {
  id: string;
  phone: string | null;
  email: string | null;
  website_url: string | null;
};

type MethodsBlock = {
  phone: { available: boolean; displayPhone: string | null };
  email: { available: boolean; displayEmail: string | null };
};

function methodsFor(venue: VenueRow): MethodsBlock {
  const phoneOk = !!venue.phone;
  const emailOk =
    !!venue.email &&
    !!venue.website_url &&
    isOnDomain(venue.email, venue.website_url);
  return {
    phone: {
      available: phoneOk,
      displayPhone: phoneOk ? venue.phone : null,
    },
    email: {
      available: emailOk,
      displayEmail: emailOk ? venue.email : null,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const placeId = (body.placeId ?? "").trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  const admin = adminClient(envRes.env);

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
    .select("business_id, role")
    .eq("venue_id", venue.id)
    .eq("role", "owner")
    .maybeSingle();

  if (owner) {
    const { data: ownerUser } = await admin.auth.admin.getUserById(
      owner.business_id,
    );
    return json({
      ok: true,
      state: "verified_partner",
      venue,
      owner: {
        id: owner.business_id,
        email: ownerUser?.user?.email ?? null,
      },
    });
  }

  // From here on the venue is claim-able. Compute the methods block
  // once so all three pending/unclaimed branches return it identically.
  const methods = methodsFor(venue as VenueRow);

  // 3. Pending claim by this caller.
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
      methods,
    });
  }

  // 4. Pending claim from a different user.
  const { data: pendingByOther } = await admin
    .from("venue_verifications")
    .select("id")
    .eq("venue_id", venue.id)
    .eq("status", "pending")
    .neq("requester_id", userId)
    .limit(1)
    .maybeSingle();
  if (pendingByOther) {
    return json({ ok: true, state: "pending_by_other", venue, methods });
  }

  // 5. Default: unclaimed and unmolested.
  return json({ ok: true, state: "web_listed_unclaimed", venue, methods });
});
