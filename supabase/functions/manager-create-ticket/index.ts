// Supabase Edge Function — manager-create-ticket
//
// Authenticated. The waiter / validator opens a ticket against a consumer at
// their venue. The body specifies which of the 10 ticket flows is being
// run (`kind`). The function does these things:
//
//   1. Verifies the caller's JWT and venue membership.
//   2. Loads the venue + consumer, validates input.
//   3. Branches by the venue's fiscal_type:
//        - formal  → cashback flows. Inserts ticket as `pending_pay`,
//                    snapshots cashback_percent, computes earn at gross,
//                    accepts an optional redeem against the consumer balance.
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
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";
import {
  ACTIONABLE_KINDS,
  FORMAL_KINDS,
  RESERVATION_KINDS,
  STORY_KINDS,
} from "../_shared/ticket-kinds.ts";

type Body = {
  venueId?: string;
  consumerCode?: string;
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

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const validatorId = authRes.user.id;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const venueId = (body.venueId ?? "").toString().trim();
  const consumerCode = (body.consumerCode ?? "").toString().trim().toUpperCase();
  const kind = (body.kind ?? "p_c").toString().trim();

  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (!consumerCode) return json({ ok: false, error: "consumerCode is required" }, 400);
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

  const admin = adminClient(envRes.env);

  // ── Membership ────────────────────────────────────────────────────────
  const memberRes = await requireMembership(admin, authRes.user, venueId);
  if (!memberRes.ok) return memberRes.response;

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

  // ── Consumer lookup ──────────────────────────────────────────────────────
  const consumerRow = await admin
    .from("consumers")
    .select("id, code, full_name, cashback_balance_cents")
    .eq("code", consumerCode)
    .maybeSingle();
  if (consumerRow.error) {
    return json(
      { ok: false, error: `consumer_lookup: ${consumerRow.error.message}` },
      500,
    );
  }
  if (!consumerRow.data) {
    return json({ ok: false, error: `No consumer with code ${consumerCode}` }, 404);
  }
  const consumerId = consumerRow.data.id;
  const consumerBalance = consumerRow.data.cashback_balance_cents ?? 0;

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
    if (redeemRequested > consumerBalance) {
      return json(
        {
          ok: false,
          code: "redeem_exceeds_balance",
          error: `Consumer balance is ${consumerBalance} cents — can't redeem ${redeemRequested}.`,
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
    // the consumer's cashback balance is applied on top of the discount:
    // billAfterDiscount = total - discountCents
    // redeem = min(consumer balance, billAfterDiscount)
    // The cash the consumer hands the waiter = billAfterDiscount - redeem.
    // Mesita is on the hook to pay the venue the `redeem` portion out of
    // its float (tracked as a redeem ledger row scoped to this venue).
    const billAfterDiscount = total - discountCents;
    const cap = Math.min(consumerBalance, billAfterDiscount);
    if (redeemRequested > consumerBalance) {
      return json(
        {
          ok: false,
          code: "redeem_exceeds_balance",
          error: `Consumer balance is ${consumerBalance} cents — can't redeem ${redeemRequested}.`,
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
    // full available cap — this is the "auto-applies" promise the consumer
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
    // ticket is being opened *at* the table — the consumer is here, the
    // reservation succeeded.
    reservationStatus = "confirmed";
  }

  // ── Lifecycle status at insert time ───────────────────────────────────
  // Formal:   ticket opens as `pending_pay` — consumer still needs to pay.
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
      consumer_id: consumerId,
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
  // we have to debit the consumer balance and write the ledger row right
  // now — otherwise the credit never lands on the venue side. Formal
  // tickets keep deferring this to manager-mark-paid.
  if (!isFormal && redeemCents > 0) {
    const newBalance = consumerBalance - redeemCents;
    const ledger = await admin.from("cashback_ledger").insert({
      consumer_id: consumerId,
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
      .from("consumers")
      .update({ cashback_balance_cents: newBalance })
      .eq("id", consumerId);
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
      consumer: {
        id: consumerId,
        code: consumerRow.data.code,
        full_name: consumerRow.data.full_name,
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
