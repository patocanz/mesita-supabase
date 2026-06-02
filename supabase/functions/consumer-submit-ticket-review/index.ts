// Supabase Edge Function — consumer-submit-ticket-review
//
// Post-visit review (Food, Service, Ambiance, Overall + comments) after Type A.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";

type Body = {
  ticketId?: string;
  food?: number;
  service?: number;
  ambiance?: number;
  overall?: number;
  comments?: string;
};

function score(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return Math.trunc(n);
}

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
  const body = bodyRes.body;

  const ticketId = (body.ticketId ?? "").trim();
  const food = score(body.food);
  const service = score(body.service);
  const ambiance = score(body.ambiance);
  const overall = score(body.overall);
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);
  if (food == null || service == null || ambiance == null || overall == null) {
    return json(
      { ok: false, error: "food, service, ambiance, and overall must be 1–5" },
      400,
    );
  }

  const admin = adminClient(envRes.env);
  const ticket = await admin
    .from("tickets")
    .select("id, consumer_id, venue_id, status")
    .eq("id", ticketId)
    .eq("consumer_id", userId)
    .maybeSingle();
  if (ticket.error || !ticket.data) {
    return json({ ok: false, error: "Ticket not found" }, 404);
  }
  if (!["revealed", "paid", "awaiting_story"].includes(ticket.data.status)) {
    return json({ ok: false, error: "Ticket is not ready for review" }, 409);
  }

  const comments = body.comments
    ? String(body.comments).trim().slice(0, 2000)
    : null;

  const insert = await admin
    .from("ticket_reviews")
    .upsert(
      {
        ticket_id: ticketId,
        consumer_id: userId,
        venue_id: ticket.data.venue_id,
        food,
        service,
        ambiance,
        overall,
        comments,
      },
      { onConflict: "ticket_id" },
    )
    .select("id")
    .single();
  if (insert.error) {
    return json({ ok: false, error: insert.error.message }, 500);
  }

  const now = new Date().toISOString();
  await admin
    .from("consumer_pay_notifications")
    .update({ status: "completed", resolved_at: now })
    .eq("ticket_id", ticketId)
    .eq("consumer_id", userId)
    .eq("kind", "review")
    .eq("status", "pending");

  return json({ ok: true, reviewId: insert.data.id });
});
