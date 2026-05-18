// Supabase Edge Function — guest-submit-story
//
// Authenticated. The guest uploads the URL of their Instagram-story
// screenshot for a story-required ticket. Sets story_status to
// 'submitted' and records the screenshot URL + timestamp, so the AI
// verifier (or waiter fallback) can pick it up.
//
// This function is the *queue* feeder for the verification pipeline:
//   - Submit moves the row from 'pending' (or 'ai_rejected') to 'submitted'.
//   - The AI bot polls 'submitted' rows, attempts to match the @mention
//     or location tag, and flips to 'ai_verified' / 'ai_rejected' on its own.
//   - Anything that ends up 'ai_rejected' falls to the waiter via
//     manager-verify-story.
//
// Auth model: the caller must be the ticket's guest. The validator does
// NOT submit on the guest's behalf — that's the whole point of the proof.
//
// Self-contained: own auth, own DB writes via service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const STORY_KINDS = new Set([
  "s_p_sf_c",
  "r_s_p_sf_c",
  "s_dp_sf",
  "r_s_dp_sf",
]);

type Body = { ticketId?: string; screenshotUrl?: string };

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
  const url = (body.screenshotUrl ?? "").toString().trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);
  if (!url) {
    return json({ ok: false, error: "screenshotUrl is required" }, 400);
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return json(
        { ok: false, error: "screenshotUrl must be https://" },
        400,
      );
    }
  } catch {
    return json({ ok: false, error: "screenshotUrl is not a valid URL" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ticketRow = await admin
    .from("tickets")
    .select("id, guest_id, kind, story_status")
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

  if (ticket.guest_id !== userId) {
    return json(
      { ok: false, error: "Only the ticket's guest can submit a story." },
      403,
    );
  }
  if (!STORY_KINDS.has(ticket.kind)) {
    return json(
      {
        ok: false,
        error: `This ticket (${ticket.kind}) doesn't require a story.`,
      },
      409,
    );
  }
  if (
    ticket.story_status === "waiter_verified" ||
    ticket.story_status === "ai_verified"
  ) {
    return json({ ok: true, ticket, alreadyVerified: true });
  }
  if (ticket.story_status === "waiter_rejected") {
    return json(
      {
        ok: false,
        error:
          "This story was rejected. No more submissions allowed for this ticket.",
      },
      409,
    );
  }

  // Allowed inbound states: pending, submitted (re-upload), ai_rejected.
  const allowed = new Set(["pending", "submitted", "ai_rejected"]);
  if (!allowed.has(ticket.story_status)) {
    return json(
      {
        ok: false,
        error: `Cannot submit a story when story_status=${ticket.story_status}`,
      },
      409,
    );
  }

  const submittedAt = new Date().toISOString();
  const updated = await admin
    .from("tickets")
    .update({
      story_status: "submitted",
      story_screenshot_url: url,
      story_submitted_at: submittedAt,
      story_verified_at: null,
      story_verified_by: null,
      story_reject_reason: null,
    })
    .eq("id", ticketId)
    .select(
      "id, kind, status, story_status, story_screenshot_url, story_submitted_at",
    )
    .single();
  if (updated.error) {
    return json(
      { ok: false, error: `story_submit: ${updated.error.message}` },
      500,
    );
  }

  return json({ ok: true, ticket: updated.data });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
