// Supabase Edge Function — manager-mark-paid
//
// Authenticated. Transitions a FORMAL ticket from 'pending_pay' to either
// 'paid' (cashback can land now) or 'awaiting_story' (paid but story still
// needs verification). The function also runs the redemption + earn ledger
// rows when cashback is ready to credit.
//
// Story gating:
//   - kinds with a story step (s_p_sf_c, r_s_p_sf_c) only credit cashback
//     when story_status is already verified (ai_verified or waiter_verified).
//     If the story is still pending/submitted/ai_rejected, the ticket
//     moves to 'awaiting_story' and the credit happens later via
//     manager-verify-story.
//   - kinds without a story step (p_c, r_p_c) credit cashback immediately
//     on mark-paid.
//
// Informal kinds are rejected here — they don't go through Mesita's
// payment rail, the discount has already been applied at the bill.
//
// Authorisation: either a venue_member of the ticket's venue OR the
// ticket's guest can call this. (In v0 the validator marks paid manually;
// once a Stripe webhook is wired up that webhook becomes the trusted
// caller and this function becomes the shared write path.)
//
// Self-contained: own auth, own DB writes via service role, no Edge-to-Edge.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const FORMAL_KINDS = new Set(["p_c", "s_p_sf_c", "r_p_c", "r_s_p_sf_c"]);
const STORY_KINDS = new Set(["s_p_sf_c", "r_s_p_sf_c"]);
const STORY_VERIFIED = new Set(["ai_verified", "waiter_verified"]);

type Body = { ticketId?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
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
  const ticketId = (body.ticketId ?? "").toString().trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ticketRow = await admin
    .from("tickets")
    .select(
      "id, venue_id, guest_id, kind, status, story_status, total_cents, cashback_cents, cashback_percent, redeem_cents, paid_at",
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketRow.error) {
    return json(
      { ok: false, error: `ticket_lookup: ${ticketRow.error.message}` },
      500,
    );
  }
  if (!ticketRow.data) return json({ ok: false, error: "Ticket not found" }, 404);
  const ticket = ticketRow.data;

  if (!FORMAL_KINDS.has(ticket.kind)) {
    return json(
      {
        ok: false,
        error:
          "manager-mark-paid is for formal/cashback flows only. Informal tickets settle off-rail.",
      },
      409,
    );
  }

  // Authorisation: venue member OR the ticket's guest.
  let authorised = ticket.guest_id === userId;
  if (!authorised) {
    const membership = await admin
      .from("venue_members")
      .select("role")
      .eq("venue_id", ticket.venue_id)
      .eq("manager_id", userId)
      .maybeSingle();
    if (membership.error) {
      return json(
        { ok: false, error: `membership: ${membership.error.message}` },
        500,
      );
    }
    authorised = !!membership.data;
  }
  if (!authorised) {
    return json({ ok: false, error: "Not authorised for this ticket" }, 403);
  }

  // Idempotency: 'paid' and 'awaiting_story' are both post-payment states.
  if (ticket.status === "paid") {
    return json({ ok: true, ticket, alreadyPaid: true });
  }
  if (ticket.status === "awaiting_story") {
    // Already paid, just waiting on story. No-op; surface that to the caller.
    return json({ ok: true, ticket, alreadyPaid: true, awaitingStory: true });
  }
  if (ticket.status !== "pending_pay") {
    return json(
      { ok: false, error: `Cannot mark ${ticket.status} ticket as paid` },
      409,
    );
  }

  const paidAt = new Date().toISOString();
  const storyRequired = STORY_KINDS.has(ticket.kind);
  const storyOk = STORY_VERIFIED.has(ticket.story_status);
  const nextStatus = storyRequired && !storyOk ? "awaiting_story" : "paid";

  // Optimistic guard: only update if we're still in pending_pay.
  const updated = await admin
    .from("tickets")
    .update({ status: nextStatus, paid_at: paidAt })
    .eq("id", ticketId)
    .eq("status", "pending_pay")
    .select("id, status, paid_at, cashback_cents, story_status")
    .single();
  if (updated.error) {
    return json(
      { ok: false, error: `ticket_update: ${updated.error.message}` },
      500,
    );
  }

  // If the cashback is gated by story verification, stop here. The credit
  // will run later inside manager-verify-story.
  if (nextStatus === "awaiting_story") {
    return json({
      ok: true,
      ticket: updated.data,
      cashbackCreditedCents: 0,
      cashbackRedeemedCents: 0,
      guestBalanceAfterCents: null,
      awaitingStory: true,
    });
  }

  // Cashback is ready to credit. Apply redemption FIRST (debit) then earn
  // (credit), with a single balance write at the end. The ledger rows are
  // append-only so we can read the trail later.
  const cashbackCents = ticket.cashback_cents ?? 0;
  const redeemCents = ticket.redeem_cents ?? 0;

  const guestRow = await admin
    .from("guests")
    .select("cashback_balance_cents")
    .eq("id", ticket.guest_id)
    .single();
  if (guestRow.error) {
    return json(
      { ok: false, error: `guest_balance_read: ${guestRow.error.message}` },
      500,
    );
  }
  let balance = guestRow.data.cashback_balance_cents ?? 0;

  if (redeemCents > 0) {
    if (redeemCents > balance) {
      // Concurrent redemption elsewhere shrank the balance. Refuse so the
      // ledger never goes negative.
      return json(
        {
          ok: false,
          code: "redeem_exceeds_balance",
          error: `Guest balance dropped below the ${redeemCents} cents this ticket would redeem.`,
        },
        409,
      );
    }
    balance -= redeemCents;
    const debit = await admin.from("cashback_ledger").insert({
      guest_id: ticket.guest_id,
      ticket_id: ticket.id,
      venue_id: ticket.venue_id,
      delta_cents: -redeemCents,
      balance_after_cents: balance,
      kind: "redeem",
    });
    if (debit.error) {
      return json(
        { ok: false, error: `ledger_redeem: ${debit.error.message}` },
        500,
      );
    }
  }

  if (cashbackCents > 0) {
    balance += cashbackCents;
    const credit = await admin.from("cashback_ledger").insert({
      guest_id: ticket.guest_id,
      ticket_id: ticket.id,
      venue_id: ticket.venue_id,
      delta_cents: cashbackCents,
      balance_after_cents: balance,
      kind: "earn",
    });
    if (credit.error) {
      return json(
        { ok: false, error: `ledger_earn: ${credit.error.message}` },
        500,
      );
    }
  }

  if (redeemCents > 0 || cashbackCents > 0) {
    const balanceUpdate = await admin
      .from("guests")
      .update({ cashback_balance_cents: balance })
      .eq("id", ticket.guest_id);
    if (balanceUpdate.error) {
      return json(
        {
          ok: false,
          error: `guest_balance_write: ${balanceUpdate.error.message}`,
        },
        500,
      );
    }
  }

  return json({
    ok: true,
    ticket: updated.data,
    cashbackCreditedCents: cashbackCents,
    cashbackRedeemedCents: redeemCents,
    guestBalanceAfterCents: balance,
    awaitingStory: false,
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
