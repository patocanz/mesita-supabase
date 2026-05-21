// Supabase Edge Function — manager-verify-story
//
// Authenticated. The waiter (or AI-fallback escalation) approves or rejects
// a guest's Instagram-story screenshot.
//
// Inputs:
//   ticketId    — uuid of the ticket
//   decision    — 'approve' | 'reject'
//   reason      — optional, only relevant on reject (≤240 chars)
//
// Behaviour by fiscal flow:
//
//   Formal (s_p_sf_c, r_s_p_sf_c)
//     approve →
//       If ticket is in 'awaiting_story' (paid but cashback gated), credit
//       the cashback NOW: redeem first, earn second, single balance write,
//       and flip status to 'paid'.
//       If ticket is still 'pending_pay', just flip story_status; cashback
//       lands later when manager-mark-paid runs.
//     reject →
//       Story-fallback waiter rejected. Cashback NEVER lands. If still
//       'awaiting_story' we flip to 'paid' (the payment itself happened)
//       but with story_status='waiter_rejected' so the ledger stays empty.
//
//   Informal (s_dp_sf, r_s_dp_sf)
//     The discount was already applied at the bill before this call. This
//     function only records the verification outcome — there's no money
//     to credit or claw back. The "vulnerability" flag is exactly this:
//     reject is informational only.
//
// Self-contained: own auth, own DB writes, no function-to-function calls.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

const FORMAL_STORY_KINDS = new Set(["s_p_sf_c", "r_s_p_sf_c"]);
const INFORMAL_STORY_KINDS = new Set(["s_dp_sf", "r_s_dp_sf"]);

type Body = {
  ticketId?: string;
  decision?: "approve" | "reject";
  reason?: string;
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
  const userId = userData.user.id;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const ticketId = (body.ticketId ?? "").toString().trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") {
    return json(
      { ok: false, error: "decision must be 'approve' or 'reject'" },
      400,
    );
  }
  const reason = (body.reason ?? "").toString().trim().slice(0, 240) || null;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ticketRow = await admin
    .from("tickets")
    .select(
      "id, venue_id, guest_id, kind, status, story_status, cashback_cents, redeem_cents",
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

  const isFormal = FORMAL_STORY_KINDS.has(ticket.kind);
  const isInformal = INFORMAL_STORY_KINDS.has(ticket.kind);
  if (!isFormal && !isInformal) {
    return json(
      {
        ok: false,
        error: `Ticket kind ${ticket.kind} has no story step to verify.`,
      },
      409,
    );
  }

  // Membership: the waiter who verifies must belong to the ticket's venue.
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
  if (!membership.data) {
    return json({ ok: false, error: "Not a member of this venue" }, 403);
  }

  // Story-status guard: once we've moved to a terminal verified/rejected
  // state we don't re-process. Idempotent re-submission returns the row.
  if (
    ticket.story_status === "waiter_verified" ||
    ticket.story_status === "waiter_rejected"
  ) {
    return json({ ok: true, ticket, alreadyDecided: true });
  }
  // We allow verifying from any non-terminal state — pending, submitted, or
  // ai_rejected — because the waiter is the fallback for all of them.

  const verifiedAt = new Date().toISOString();
  const nextStoryStatus = decision === "approve"
    ? "waiter_verified"
    : "waiter_rejected";

  // Decide if the ticket's overall status moves too. Only the formal
  // awaiting_story case flips here (to 'paid').
  const moveTicketStatusToPaid =
    isFormal && ticket.status === "awaiting_story";

  const patch: Record<string, unknown> = {
    story_status: nextStoryStatus,
    story_verified_at: verifiedAt,
    story_verified_by: userId,
    story_reject_reason: decision === "reject" ? reason : null,
  };
  if (moveTicketStatusToPaid) {
    patch.status = "paid";
  }

  const updated = await admin
    .from("tickets")
    .update(patch)
    .eq("id", ticketId)
    .select(
      "id, kind, status, story_status, story_verified_at, story_reject_reason, cashback_cents, redeem_cents",
    )
    .single();
  if (updated.error) {
    return json(
      { ok: false, error: `ticket_update: ${updated.error.message}` },
      500,
    );
  }

  // Informal flows: discount was applied at the bill — nothing to credit.
  if (isInformal) {
    return json({
      ok: true,
      ticket: updated.data,
      cashbackCreditedCents: 0,
      cashbackRedeemedCents: 0,
      guestBalanceAfterCents: null,
    });
  }

  // Formal approve: if we moved the ticket from awaiting_story → paid, the
  // cashback ledger has to run now (it didn't run during mark-paid).
  if (!moveTicketStatusToPaid) {
    return json({
      ok: true,
      ticket: updated.data,
      cashbackCreditedCents: 0,
      cashbackRedeemedCents: 0,
      guestBalanceAfterCents: null,
    });
  }
  if (decision === "reject") {
    // Story rejected post-payment. The ticket is now 'paid' but cashback
    // never lands. No ledger rows, no balance change.
    return json({
      ok: true,
      ticket: updated.data,
      cashbackCreditedCents: 0,
      cashbackRedeemedCents: 0,
      guestBalanceAfterCents: null,
    });
  }

  // Approve + awaiting_story → run the ledger.
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
      return json(
        {
          ok: false,
          code: "redeem_exceeds_balance",
          error: `Guest balance is below the ${redeemCents} cents this ticket would redeem.`,
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
  });
});
