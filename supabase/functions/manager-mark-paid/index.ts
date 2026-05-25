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
// Informal kinds are not expected here — they settle at create-time in
// manager-create-ticket (status goes straight to 'revealed' and the
// redemption is applied inline). If one slips through (e.g. a future
// Stripe webhook fires on an informal ticket), we still reject below.
//
// Authorisation: either a venue_member of the ticket's venue OR the
// ticket's consumer can call this. (In v0 the validator marks paid manually;
// once a Stripe webhook is wired up that webhook becomes the trusted
// caller and this function becomes the shared write path.)
//
// Self-contained: own auth, own DB writes via service role, no Edge-to-Edge.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  checkMembership,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { FORMAL_KINDS, FORMAL_STORY_KINDS } from "../_shared/ticket-kinds.ts";

const STORY_VERIFIED = new Set(["ai_verified", "waiter_verified"]);

type Body = { ticketId?: string };

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

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const ticketId = (body.ticketId ?? "").toString().trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);

  const admin = adminClient(envRes.env);

  const ticketRow = await admin
    .from("tickets")
    .select(
      "id, venue_id, consumer_id, kind, status, story_status, total_cents, cashback_cents, cashback_percent, redeem_cents, paid_at",
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

  // Authorisation: venue member OR the ticket's consumer.
  let authorised = ticket.consumer_id === userId;
  if (!authorised) {
    const m = await checkMembership(admin, authRes.user, ticket.venue_id);
    authorised = m.isSuperAdmin || m.role != null;
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
  const storyRequired = FORMAL_STORY_KINDS.has(ticket.kind);
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
      consumerBalanceAfterCents: null,
      awaitingStory: true,
    });
  }

  // Cashback is ready to credit. Apply redemption FIRST (debit) then earn
  // (credit), with a single balance write at the end. The ledger rows are
  // append-only so we can read the trail later.
  const cashbackCents = ticket.cashback_cents ?? 0;
  const redeemCents = ticket.redeem_cents ?? 0;

  const consumerRow = await admin
    .from("consumers")
    .select("cashback_balance_cents")
    .eq("id", ticket.consumer_id)
    .single();
  if (consumerRow.error) {
    return json(
      { ok: false, error: `consumer_balance_read: ${consumerRow.error.message}` },
      500,
    );
  }
  let balance = consumerRow.data.cashback_balance_cents ?? 0;

  if (redeemCents > 0) {
    if (redeemCents > balance) {
      // Concurrent redemption elsewhere shrank the balance. Refuse so the
      // ledger never goes negative.
      return json(
        {
          ok: false,
          code: "redeem_exceeds_balance",
          error: `Consumer balance dropped below the ${redeemCents} cents this ticket would redeem.`,
        },
        409,
      );
    }
    balance -= redeemCents;
    const debit = await admin.from("cashback_ledger").insert({
      consumer_id: ticket.consumer_id,
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
      consumer_id: ticket.consumer_id,
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
      .from("consumers")
      .update({ cashback_balance_cents: balance })
      .eq("id", ticket.consumer_id);
    if (balanceUpdate.error) {
      return json(
        {
          ok: false,
          error: `consumer_balance_write: ${balanceUpdate.error.message}`,
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
    consumerBalanceAfterCents: balance,
    awaitingStory: false,
  });
});
