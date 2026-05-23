// Supabase Edge Function — manager-cancel-ticket
//
// Authenticated. Validator cancels a pending_pay ticket they opened by
// mistake (wrong total, guest left without paying, etc.). Only the
// venue's members can cancel. Paid tickets cannot be cancelled — those
// need an explicit refund flow (out of scope for now).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";

type Body = { ticketId?: string; reason?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const ticketId = (body.ticketId ?? "").toString().trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);
  const reason = (body.reason ?? "").toString().trim().slice(0, 240) || null;

  const admin = adminClient(envRes.env);

  const ticket = await admin
    .from("tickets")
    .select("id, venue_id, status")
    .eq("id", ticketId)
    .maybeSingle();
  if (ticket.error) {
    return json({ ok: false, error: `ticket_lookup: ${ticket.error.message}` }, 500);
  }
  if (!ticket.data) return json({ ok: false, error: "Ticket not found" }, 404);

  const membership = await requireMembership(admin, authRes.user, ticket.data.venue_id);
  if (!membership.ok) return membership.response;

  if (ticket.data.status === "cancelled") {
    return json({ ok: true, alreadyCancelled: true });
  }
  if (ticket.data.status !== "pending_pay") {
    return json(
      { ok: false, error: `Cannot cancel a ${ticket.data.status} ticket` },
      409,
    );
  }

  const cancelledAt = new Date().toISOString();
  const update = await admin
    .from("tickets")
    .update({ status: "cancelled", cancelled_at: cancelledAt, cancel_reason: reason })
    .eq("id", ticketId)
    .eq("status", "pending_pay") // optimistic guard against double-cancel race
    .select("id, status, cancelled_at, cancel_reason")
    .single();
  if (update.error) {
    return json({ ok: false, error: `ticket_update: ${update.error.message}` }, 500);
  }

  return json({ ok: true, ticket: update.data });
});
