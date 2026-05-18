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
      "id, venue_id, guest_id, status, total_cents, cashback_cents, cashback_percent, paid_at",
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

  const cashbackCents = updated.data.cashback_cents ?? 0;

  // Update guest balance + write ledger row atomically-ish.
  // (Supabase Postgres doesn't expose transactions to functions.invoke
  // payloads natively without RPCs, but doing the two writes in order with
  // ledger written after balance update is fine; if the second write fails
  // we surface the error and the ticket stays paid — operator can re-run.)
  let balanceAfter = 0;
  if (cashbackCents > 0) {
    const guestRow = await admin
      .from("guests")
      .select("cashback_balance_cents")
      .eq("id", ticket.guest_id)
      .single();
    if (guestRow.error) {
      return json({ ok: false, error: `guest_balance_read: ${guestRow.error.message}` }, 500);
    }
    balanceAfter = (guestRow.data.cashback_balance_cents ?? 0) + cashbackCents;

    const balanceUpdate = await admin
      .from("guests")
      .update({ cashback_balance_cents: balanceAfter })
      .eq("id", ticket.guest_id);
    if (balanceUpdate.error) {
      return json(
        { ok: false, error: `guest_balance_write: ${balanceUpdate.error.message}` },
        500,
      );
    }

    const ledger = await admin.from("cashback_ledger").insert({
      guest_id: ticket.guest_id,
      ticket_id: ticket.id,
      venue_id: ticket.venue_id,
      delta_cents: cashbackCents,
      balance_after_cents: balanceAfter,
      kind: "earn",
    });
    if (ledger.error) {
      return json({ ok: false, error: `ledger_write: ${ledger.error.message}` }, 500);
    }
  }

  return json({
    ok: true,
    ticket: updated.data,
    cashbackCreditedCents: cashbackCents,
    guestBalanceAfterCents: balanceAfter,
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
