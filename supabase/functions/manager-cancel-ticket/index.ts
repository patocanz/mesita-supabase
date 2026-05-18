// Supabase Edge Function — manager-cancel-ticket
//
// Authenticated. Validator cancels a pending_pay ticket they opened by
// mistake (wrong total, guest left without paying, etc.). Only the
// venue's members can cancel. Paid tickets cannot be cancelled — those
// need an explicit refund flow (out of scope for now).
//
// Self-contained: own auth check, own DB writes via service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Body = { ticketId?: string; reason?: string };

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
  const reason = (body.reason ?? "").toString().trim().slice(0, 240) || null;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ticket = await admin
    .from("tickets")
    .select("id, venue_id, status")
    .eq("id", ticketId)
    .maybeSingle();
  if (ticket.error) {
    return json({ ok: false, error: `ticket_lookup: ${ticket.error.message}` }, 500);
  }
  if (!ticket.data) return json({ ok: false, error: "Ticket not found" }, 404);

  // Validator must be a member of the venue.
  const membership = await admin
    .from("venue_members")
    .select("role")
    .eq("venue_id", ticket.data.venue_id)
    .eq("manager_id", userId)
    .maybeSingle();
  if (membership.error) {
    return json({ ok: false, error: `membership: ${membership.error.message}` }, 500);
  }
  if (!membership.data) {
    return json({ ok: false, error: "Not a member of this venue" }, 403);
  }

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
