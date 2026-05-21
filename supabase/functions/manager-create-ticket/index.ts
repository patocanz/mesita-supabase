// Supabase Edge Function — manager-create-ticket
//
// Authenticated. The waiter / validator opens a ticket against a guest at
// their venue. The body specifies which of the 10 ticket flows is being
// run (`kind`). The function does these things:
//
//   1. Verifies the caller's JWT and venue membership.
//   2. Loads the venue + guest, validates input.
//   3. Branches by the venue's fiscal_type:
//        - formal  → cashback flows. Inserts ticket as `pending_pay`,
//                    snapshots cashback_percent, computes earn at gross,
//                    accepts an optional redeem against the guest balance.
//        - informal → discount flows. Inserts ticket as `revealed`,
//                    snapshots discount_percent + cents, no Stripe rail,
//                    no balance touched.
//   4. If the kind includes a story (S in the name), seeds story_status =
//      'pending' so the post-meal upload + verify flow is gated.
//   5. If the kind is reservation-prefixed (R…), accepts reservation fields
//      and seeds reservation_status = 'pending' so the AI agent layer can
//      pick it up.
//
// Self-contained: own auth, own DB writes via the service role, no
// function-to-function calls.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

// All 10 kinds. The two `none` rows in the taxonomy mean "no Mesita
// transaction" — there's no ticket to write. We reject 'none' here so the
// API never persists an empty row.
const ACTIONABLE_KINDS = new Set([
  "p_c",
  "s_p_sf_c",
  "r_p_c",
  "r_s_p_sf_c",
  "dp",
  "s_dp_sf",
  "r_dp",
  "r_s_dp_sf",
]);

const FORMAL_KINDS = new Set(["p_c", "s_p_sf_c", "r_p_c", "r_s_p_sf_c"]);
const STORY_KINDS = new Set(["s_p_sf_c", "r_s_p_sf_c", "s_dp_sf", "r_s_dp_sf"]);
const RESERVATION_KINDS = new Set([
  "r_p_c",
  "r_s_p_sf_c",
  "r_dp",
  "r_s_dp_sf",
]);

type Body = {
  venueId?: string;
  guestCode?: string;
  kind?: string;
  checkSubtotalCents?: number;
  tipCents?: number;
  redeemCents?: number; // formal only
  // Reservation fields (R-prefixed kinds)
  reservationAt?: string;
  reservationPartySize?: number;
  reservationChannel?: string;
  reservationNotes?: string;
};

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
  const validatorId = userData.user.id;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const venueId = (body.venueId ?? "").toString().trim();
  const guestCode = (body.guestCode ?? "").toString().trim().toUpperCase();
  const kind = (body.kind ?? "p_c").toString().trim();

  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (!guestCode) return json({ ok: false, error: "guestCode is required" }, 400);
  if (!ACTIONABLE_KINDS.has(kind)) {
    return json(
      { ok: false, error: `Unsupported ticket kind: ${kind}` },
      400,
    );
  }

  const isFormal = FORMAL_KINDS.has(kind);
  const requiresStory = STORY_KINDS.has(kind);
  const isReservation = RESERVATION_KINDS.has(kind);

  // Bill totals: required for everything. Even reservation kinds open at
  // checkout time with the full check captured. (Pre-checkout reservation
  // state is held in reservation_status, not in this insert.)
  const subtotal = toCents(body.checkSubtotalCents);
  const tip = toCents(body.tipCents ?? 0);
  const redeemRequested = toCents(body.redeemCents ?? 0);
  if (subtotal == null) {
    return json(
      { ok: false, error: "checkSubtotalCents must be a non-negative integer" },
      400,
    );
  }
  if (tip == null) {
    return json(
      { ok: false, error: "tipCents must be a non-negative integer" },
      400,
    );
  }
  if (redeemRequested == null) {
    return json(
      { ok: false, error: "redeemCents must be a non-negative integer" },
      400,
    );
  }
  if (subtotal === 0) {
    return json({ ok: false, error: "Check total can't be zero" }, 400);
  }
  if (!isFormal && redeemRequested > 0) {
    return json(
      {
        ok: false,
        error: "Redemption isn't allowed on informal/discount tickets.",
      },
      400,
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Membership ────────────────────────────────────────────────────────
  const membership = await admin
    .from("venue_members")
    .select("role")
    .eq("venue_id", venueId)
    .eq("manager_id", validatorId)
    .maybeSingle();
  if (membership.error) {
    return json(
      { ok: false, error: `membership: ${membership.error.message}` },
      500,
    );
  }
  if (!membership.data) {
    return json({ ok: false, error: "Not a member of this venue" }, 403);
  }

  // ── Venue snapshot (fiscal_type pins the mechanic) ────────────────────
  const venueRow = await admin
    .from("venues")
    .select(
      "id, name, cashback_percent, listing_type, status, fiscal_type",
    )
    .eq("id", venueId)
    .maybeSingle();
  if (venueRow.error || !venueRow.data) {
    return json({ ok: false, error: "Venue not found" }, 404);
  }
  const venue = venueRow.data;
  if (venue.status === "archived") {
    return json({ ok: false, error: "Venue is archived" }, 409);
  }
  if (venue.listing_type !== "partner") {
    return json(
      {
        ok: false,
        error:
          "Only Verified Partners can open tickets. Promote this venue to partner first.",
      },
      409,
    );
  }
  if (isFormal && venue.fiscal_type !== "formal") {
    return json(
      {
        ok: false,
        code: "fiscal_type_mismatch",
        error: `This venue is ${venue.fiscal_type} — cashback flows aren't available here. Use a discount kind.`,
      },
      409,
    );
  }
  if (!isFormal && venue.fiscal_type !== "informal") {
    return json(
      {
        ok: false,
        code: "fiscal_type_mismatch",
        error: `This venue is ${venue.fiscal_type} — discount flows aren't available here. Use a cashback kind.`,
      },
      409,
    );
  }

  const ratePercent = Math.max(0, Math.min(100, venue.cashback_percent ?? 0));

  // ── Guest lookup ──────────────────────────────────────────────────────
  const guestRow = await admin
    .from("guests")
    .select("id, code, full_name, cashback_balance_cents")
    .eq("code", guestCode)
    .maybeSingle();
  if (guestRow.error) {
    return json(
      { ok: false, error: `guest_lookup: ${guestRow.error.message}` },
      500,
    );
  }
  if (!guestRow.data) {
    return json({ ok: false, error: `No guest with code ${guestCode}` }, 404);
  }
  const guestId = guestRow.data.id;
  const guestBalance = guestRow.data.cashback_balance_cents ?? 0;

  const total = subtotal + tip;

  // ── Branch the snapshot by fiscal type ────────────────────────────────
  // Formal:   cashback EARN on gross; redemption capped at min(balance, total).
  // Informal: discount snapshot at the configured rate against the bill total,
  //           applied immediately at reveal.
  let cashbackCents = 0;
  let redeemCents = 0;
  let discountCents = 0;
  let discountPercent: number | null = null;

  if (isFormal) {
    if (redeemRequested > guestBalance) {
      return json(
        {
          ok: false,
          code: "redeem_exceeds_balance",
          error: `Guest balance is ${guestBalance} cents — can't redeem ${redeemRequested}.`,
        },
        400,
      );
    }
    if (redeemRequested > total) {
      return json(
        {
          ok: false,
          code: "redeem_exceeds_total",
          error: `Redemption ${redeemRequested} can't exceed the check total ${total}.`,
        },
        400,
      );
    }
    redeemCents = redeemRequested;
    cashbackCents = Math.floor((total * ratePercent) / 100);
  } else {
    discountPercent = ratePercent;
    discountCents = Math.floor((total * ratePercent) / 100);
    if (discountCents > total) discountCents = total;
    // Balance is now portable across fiscal types. At an Informal venue
    // the guest's cashback balance is applied on top of the discount:
    // billAfterDiscount = total - discountCents
    // redeem = min(guest balance, billAfterDiscount)
    // The cash the guest hands the waiter = billAfterDiscount - redeem.
    // Mesita is on the hook to pay the venue the `redeem` portion out of
    // its float (tracked as a redeem ledger row scoped to this venue).
    const billAfterDiscount = total - discountCents;
    const cap = Math.min(guestBalance, billAfterDiscount);
    if (redeemRequested > guestBalance) {
      return json(
        {
          ok: false,
          code: "redeem_exceeds_balance",
          error: `Guest balance is ${guestBalance} cents — can't redeem ${redeemRequested}.`,
        },
        400,
      );
    }
    if (redeemRequested > billAfterDiscount) {
      return json(
        {
          ok: false,
          code: "redeem_exceeds_total",
          error: `Redemption ${redeemRequested} can't exceed the post-discount bill ${billAfterDiscount}.`,
        },
        400,
      );
    }
    // If the caller didn't request a specific redemption, default to the
    // full available cap — this is the "auto-applies" promise the guest
    // app makes on /qr ("Auto-applies to your next bill at any partner").
    redeemCents = redeemRequested > 0 ? redeemRequested : cap;
  }

  // ── Reservation fields ────────────────────────────────────────────────
  let reservationAt: string | null = null;
  let reservationPartySize: number | null = null;
  let reservationChannel: string | null = null;
  let reservationNotes: string | null = null;
  let reservationStatus: string | null = null;
  if (isReservation) {
    if (body.reservationAt) {
      const parsed = new Date(body.reservationAt);
      if (Number.isNaN(parsed.getTime())) {
        return json(
          { ok: false, error: "reservationAt must be an ISO timestamp" },
          400,
        );
      }
      reservationAt = parsed.toISOString();
    }
    if (body.reservationPartySize != null) {
      const n = Number(body.reservationPartySize);
      if (!Number.isFinite(n) || n < 1) {
        return json(
          { ok: false, error: "reservationPartySize must be ≥ 1" },
          400,
        );
      }
      reservationPartySize = Math.trunc(n);
    }
    if (body.reservationChannel) {
      const allowed = [
        "voice",
        "whatsapp",
        "instagram_dm",
        "web_form",
        "email",
      ];
      if (!allowed.includes(body.reservationChannel)) {
        return json(
          {
            ok: false,
            error: `reservationChannel must be one of ${allowed.join(", ")}`,
          },
          400,
        );
      }
      reservationChannel = body.reservationChannel;
    }
    if (body.reservationNotes) {
      reservationNotes = String(body.reservationNotes).slice(0, 500);
    }
    // If the reservation was already confirmed by the venue before checkout
    // (rare today; common once the AI agent is live) the caller can pass
    // reservationStatus too. For now we always seed 'confirmed' since the
    // ticket is being opened *at* the table — the guest is here, the
    // reservation succeeded.
    reservationStatus = "confirmed";
  }

  // ── Lifecycle status at insert time ───────────────────────────────────
  // Formal:   ticket opens as `pending_pay` — guest still needs to pay.
  // Informal: ticket opens as `revealed` — discount has been shown to the
  //           waiter and is being applied at the bill right now. The cash
  //           settles off-rail; Mesita's involvement at the payment step
  //           ends here.
  const status = isFormal ? "pending_pay" : "revealed";
  const storyStatus = requiresStory ? "pending" : "not_required";

  // ── Insert ────────────────────────────────────────────────────────────
  const insert = await admin
    .from("tickets")
    .insert({
      venue_id: venueId,
      guest_id: guestId,
      opened_by: validatorId,
      kind,
      status,
      story_status: storyStatus,
      check_subtotal_cents: subtotal,
      tip_cents: tip,
      total_cents: total,
      cashback_percent: isFormal ? ratePercent : 0,
      cashback_cents: isFormal ? cashbackCents : 0,
      redeem_cents: redeemCents,
      discount_percent: discountPercent,
      discount_cents: isFormal ? null : discountCents,
      revealed_at: !isFormal ? new Date().toISOString() : null,
      reservation_status: reservationStatus,
      reservation_at: reservationAt,
      reservation_party_size: reservationPartySize,
      reservation_channel: reservationChannel,
      reservation_notes: reservationNotes,
    })
    .select(
      "id, kind, status, story_status, check_subtotal_cents, tip_cents, total_cents, cashback_percent, cashback_cents, redeem_cents, discount_percent, discount_cents, revealed_at, reservation_status, reservation_at, reservation_party_size, currency, created_at",
    )
    .single();
  if (insert.error) {
    return json(
      { ok: false, error: `ticket_insert: ${insert.error.message}` },
      500,
    );
  }

  // ── Informal: apply redemption immediately ────────────────────────────
  // Informal tickets settle off-rail (status goes straight to 'revealed'
  // and there's no manager-mark-paid step). If we captured a redemption,
  // we have to debit the guest balance and write the ledger row right
  // now — otherwise the credit never lands on the venue side. Formal
  // tickets keep deferring this to manager-mark-paid.
  if (!isFormal && redeemCents > 0) {
    const newBalance = guestBalance - redeemCents;
    const ledger = await admin.from("cashback_ledger").insert({
      guest_id: guestId,
      ticket_id: insert.data.id,
      venue_id: venueId,
      delta_cents: -redeemCents,
      balance_after_cents: newBalance,
      kind: "redeem",
    });
    if (ledger.error) {
      // We've already inserted the ticket — surface the ledger failure but
      // don't roll back. Reconciliation can replay the ledger row later.
      console.error("[manager-create-ticket] informal_redeem_ledger:", ledger.error);
    }
    const balanceUpdate = await admin
      .from("guests")
      .update({ cashback_balance_cents: newBalance })
      .eq("id", guestId);
    if (balanceUpdate.error) {
      console.error(
        "[manager-create-ticket] informal_redeem_balance:",
        balanceUpdate.error,
      );
    }
  }

  return json(
    {
      ok: true,
      ticket: insert.data,
      venue: {
        id: venue.id,
        name: venue.name,
        fiscal_type: venue.fiscal_type,
      },
      guest: {
        id: guestId,
        code: guestRow.data.code,
        full_name: guestRow.data.full_name,
      },
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
