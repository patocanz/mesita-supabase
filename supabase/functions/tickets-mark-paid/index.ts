// Supabase Edge Function — tickets-mark-paid
//
// Authenticated. Transitions a ticket from 'pending_pay' to 'paid' and
// credits cashback into the guest's balance via cashback_ledger. Idempotent
// on re-submission of an already-paid ticket.
//
// Authorisation: either a venue_member of the ticket's venue OR the ticket's
// guest can call this. (In v0 the validator marks paid manually; once a
// Stripe webhook is wired up that webhook becomes the trusted caller and
// this function becomes the shared write path.)
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

type Body = { ticketId?: string };

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
  const ticketId = (body.ticketId ?? "").toString().trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Read the ticket
  const ticketRow = await admin
    .from("tickets")
    .select(
      "id, venue_id, guest_id, status, total_cents, cashback_cents, cashback_percent, redeem_cents, paid_at",
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketRow.error) {
    return json({ ok: false, error: `ticket_lookup: ${ticketRow.error.message}` }, 500);
  }
  if (!ticketRow.data) return json({ ok: false, error: "Ticket not found" }, 404);
  const ticket = ticketRow.data;

  // Authorisation: venue member OR the ticket's guest
  let authorised = ticket.guest_id === userId;
  if (!authorised) {
    const membership = await admin
      .from("venue_members")
      .select("role")
      .eq("venue_id", ticket.venue_id)
      .eq("manager_id", userId)
      .maybeSingle();
    if (membership.error) {
      return json({ ok: false, error: `membership: ${membership.error.message}` }, 500);
    }
    authorised = !!membership.data;
  }
  if (!authorised) {
    return json({ ok: false, error: "Not authorised for this ticket" }, 403);
  }

  if (ticket.status === "paid") {
    return json({ ok: true, ticket, alreadyPaid: true });
  }
  if (ticket.status !== "pending_pay") {
    return json(
      { ok: false, error: `Cannot mark ${ticket.status} ticket as paid` },
      409,
    );
  }

  // Transition the ticket
  const paidAt = new Date().toISOString();
  const updated = await admin
    .from("tickets")
    .update({ status: "paid", paid_at: paidAt })
    .eq("id", ticketId)
    .eq("status", "pending_pay") // optimistic check guards against races
    .select("id, status, paid_at, cashback_cents")
    .single();
  if (updated.error) {
    return json({ ok: false, error: `ticket_update: ${updated.error.message}` }, 500);
  }

  const cashbackCents = ticket.cashback_cents ?? 0;
  const redeemCents = ticket.redeem_cents ?? 0;

  // Read the current balance once. We'll apply redemption FIRST (debit)
  // then earn (credit) and write a ledger row for each non-zero leg. The
  // two writes happen back-to-back; if the second fails we surface the
  // error and an operator can reconcile by hand — the ticket has already
  // moved to 'paid'.
  const guestRow = await admin
    .from("guests")
    .select("cashback_balance_cents")
    .eq("id", ticket.guest_id)
    .single();
  if (guestRow.error) {
    return json({ ok: false, error: `guest_balance_read: ${guestRow.error.message}` }, 500);
  }
  let balance = guestRow.data.cashback_balance_cents ?? 0;

  // Apply redemption (debit) before earning (credit) so the balance
  // movement reads in the order it makes sense for the user: "spent X,
  // then earned Y".
  if (redeemCents > 0) {
    if (redeemCents > balance) {
      // Balance went down between ticket-create and mark-paid (e.g. a
      // concurrent redemption elsewhere). Refuse rather than driving the
      // balance negative.
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
      return json({ ok: false, error: `ledger_redeem: ${debit.error.message}` }, 500);
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
      return json({ ok: false, error: `ledger_earn: ${credit.error.message}` }, 500);
    }
  }

  if (redeemCents > 0 || cashbackCents > 0) {
    const balanceUpdate = await admin
      .from("guests")
      .update({ cashback_balance_cents: balance })
      .eq("id", ticket.guest_id);
    if (balanceUpdate.error) {
      return json(
        { ok: false, error: `guest_balance_write: ${balanceUpdate.error.message}` },
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
