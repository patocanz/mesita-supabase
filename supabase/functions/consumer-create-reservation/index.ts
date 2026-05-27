// Supabase Edge Function — consumer-create-reservation (natural caller)
//
// Authenticated. Creates a reservation row for the caller and, if the
// consumer already has an active coupon for the same venue (because
// they previously saved it), links that coupon to the reservation via
// `coupon_id`. The reservation row deliberately carries NO discount
// info — the linked coupon owns the discount surface.
//
// Body:
//   { venue_id: uuid, reserved_at: iso8601, party_size: int, notes?: string }
//
// Response:
//   { ok: true, reservation: {…}, linked_coupon_id: uuid|null }
//
// Deploy: supabase functions deploy consumer-create-reservation

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";

type Body = {
  venue_id?: string;
  reserved_at?: string;
  party_size?: number;
  notes?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const consumerId = authRes.user.id;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  if (!body.venue_id || typeof body.venue_id !== "string") {
    return json({ ok: false, error: "venue_id required" }, 400);
  }
  if (!body.reserved_at || typeof body.reserved_at !== "string") {
    return json({ ok: false, error: "reserved_at (ISO 8601) required" }, 400);
  }
  const reservedAt = new Date(body.reserved_at);
  if (Number.isNaN(reservedAt.getTime())) {
    return json({ ok: false, error: "reserved_at must be a valid ISO 8601 timestamp" }, 400);
  }
  const partySize = Math.trunc(Number(body.party_size));
  if (!Number.isFinite(partySize) || partySize < 1 || partySize > 50) {
    return json({ ok: false, error: "party_size must be 1..50" }, 400);
  }

  const admin = adminClient(envRes.env);

  // Look up an active coupon for this (consumer, venue) so we can link it.
  // We don't fail if none exists — the venue might be a web listing
  // (no coupons), or the consumer might not have saved it yet.
  const { data: coupon } = await admin
    .from("coupons")
    .select("id")
    .eq("consumer_id", consumerId)
    .eq("venue_id", body.venue_id)
    .eq("status", "active")
    .maybeSingle();

  const { data: reservation, error } = await admin
    .from("reservations")
    .insert({
      consumer_id: consumerId,
      venue_id: body.venue_id,
      coupon_id: coupon?.id ?? null,
      reserved_at: reservedAt.toISOString(),
      party_size: partySize,
      notes: (body.notes ?? "").trim() || null,
      status: "pending",
    })
    .select(
      "id, reserved_at, party_size, status, notes, coupon_id, created_at, venue:venues(id, slug, name, category, photos, address)",
    )
    .single();

  if (error) return json({ ok: false, error: error.message }, 500);

  return json({ ok: true, reservation, linked_coupon_id: coupon?.id ?? null });
});
