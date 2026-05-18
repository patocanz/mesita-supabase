// Supabase Edge Function — tickets-venue-create
//
// Authenticated. A validator (any venue_member) creates a ticket for an
// identified guest at their venue. Captures check subtotal + tip + currency,
// snapshots the venue's cashback rate, computes cashback_cents, persists as
// status='pending_pay'.
//
// Self-contained: verifies JWT, checks venue membership, looks up guest by
// code, writes ticket via service role, never calls another Edge Function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Body = {
  venueId?: string;
  guestCode?: string;
  checkSubtotalCents?: number;
  tipCents?: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

  // Auth
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
  const validatorId = userData.user.id;

  // Body
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const venueId = (body.venueId ?? "").toString().trim();
  const guestCode = (body.guestCode ?? "").toString().trim().toUpperCase();
  const subtotal = toCents(body.checkSubtotalCents);
  const tip = toCents(body.tipCents ?? 0);

  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (!guestCode) return json({ ok: false, error: "guestCode is required" }, 400);
  if (subtotal == null) {
    return json({ ok: false, error: "checkSubtotalCents must be a non-negative integer" }, 400);
  }
  if (tip == null) {
    return json({ ok: false, error: "tipCents must be a non-negative integer" }, 400);
  }
  if (subtotal === 0) {
    return json({ ok: false, error: "Check total can't be zero" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Membership check — validator must belong to this venue
  const membership = await admin
    .from("venue_members")
    .select("role")
    .eq("venue_id", venueId)
    .eq("manager_id", validatorId)
    .maybeSingle();
  if (membership.error) {
    return json({ ok: false, error: `membership: ${membership.error.message}` }, 500);
  }
  if (!membership.data) {
    return json({ ok: false, error: "Not a member of this venue" }, 403);
  }

  // Venue snapshot (cashback_percent + currency hint)
  const venueRow = await admin
    .from("venues")
    .select("id, name, cashback_percent, listing_type, status")
    .eq("id", venueId)
    .maybeSingle();
  if (venueRow.error || !venueRow.data) {
    return json({ ok: false, error: "Venue not found" }, 404);
  }
  const venue = venueRow.data;
  if (venue.status === "archived") {
    return json({ ok: false, error: "Venue is archived" }, 409);
  }
  // Web listings (non-partners) currently don't pay cashback; we still
  // permit the ticket but cap cashback to 0 so the ledger reflects that.
  const cashbackPercent =
    venue.listing_type === "partner" ? Math.max(0, Math.min(100, venue.cashback_percent ?? 0)) : 0;

  // Resolve guest by code
  const guestRow = await admin
    .from("guests")
    .select("id, code, full_name")
    .eq("code", guestCode)
    .maybeSingle();
  if (guestRow.error) {
    return json({ ok: false, error: `guest_lookup: ${guestRow.error.message}` }, 500);
  }
  if (!guestRow.data) {
    return json({ ok: false, error: `No guest with code ${guestCode}` }, 404);
  }
  const guestId = guestRow.data.id;

  const total = subtotal + tip;
  const cashbackCents = Math.floor((total * cashbackPercent) / 100);

  // Insert ticket
  const insert = await admin
    .from("tickets")
    .insert({
      venue_id: venueId,
      guest_id: guestId,
      opened_by: validatorId,
      status: "pending_pay",
      check_subtotal_cents: subtotal,
      tip_cents: tip,
      total_cents: total,
      cashback_percent: cashbackPercent,
      cashback_cents: cashbackCents,
    })
    .select(
      "id, status, check_subtotal_cents, tip_cents, total_cents, cashback_percent, cashback_cents, currency, created_at",
    )
    .single();
  if (insert.error) {
    return json({ ok: false, error: `ticket_insert: ${insert.error.message}` }, 500);
  }

  return json(
    {
      ok: true,
      ticket: insert.data,
      venue: { id: venue.id, name: venue.name },
      guest: { id: guestId, code: guestRow.data.code, full_name: guestRow.data.full_name },
    },
    201,
  );
});

function toCents(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  return Math.trunc(n);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
