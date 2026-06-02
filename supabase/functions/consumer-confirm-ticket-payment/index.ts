// Supabase Edge Function — consumer-confirm-ticket-payment
//
// Consumer confirms passive (off-rail) payment for a Type A discount ticket.
// When both guest and staff have confirmed, finalizes the ticket and queues review.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { readTwilioEnv } from "../_shared/twilio.ts";
import { onConsumerPaymentConfirmed } from "../_shared/staff-whatsapp-flow.ts";

type Body = { ticketId?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const ticketId = (bodyRes.body.ticketId ?? "").trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);

  const admin = adminClient(envRes.env);

  const ticket = await admin
    .from("tickets")
    .select("id, consumer_id, venue_id, status, kind, staff_payment_confirmed_at")
    .eq("id", ticketId)
    .eq("consumer_id", userId)
    .maybeSingle();
  if (ticket.error || !ticket.data) {
    return json({ ok: false, error: "Ticket not found" }, 404);
  }
  if (ticket.data.status !== "awaiting_payment_confirm") {
    return json({ ok: false, error: "Ticket is not awaiting payment confirmation" }, 409);
  }
  if (ticket.data.kind !== "dp") {
    return json({ ok: false, error: "This flow only applies to discount tickets" }, 400);
  }

  const now = new Date().toISOString();
  await admin
    .from("tickets")
    .update({ consumer_payment_confirmed_at: now })
    .eq("id", ticketId);

  await admin
    .from("consumer_pay_notifications")
    .update({ status: "completed", resolved_at: now })
    .eq("ticket_id", ticketId)
    .eq("consumer_id", userId)
    .eq("kind", "payment_confirm")
    .eq("status", "pending");

  const twilio = readTwilioEnv();
  await onConsumerPaymentConfirmed(
    admin,
    twilio.ok ? twilio.env : null,
    ticketId,
    userId,
  );

  const refreshed = await admin
    .from("tickets")
    .select("status, staff_payment_confirmed_at")
    .eq("id", ticketId)
    .single();

  return json({
    ok: true,
    ticketId,
    finalized: refreshed.data?.status === "revealed",
    awaitingStaff: !refreshed.data?.staff_payment_confirmed_at,
  });
});
