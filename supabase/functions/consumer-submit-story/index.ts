// Supabase Edge Function — consumer-submit-story
//
// Authenticated. The consumer uploads the URL of their Instagram-story
// screenshot for a story-required ticket. Sets story_status to
// 'submitted' and records the screenshot URL + timestamp, so the AI
// verifier (or waiter fallback) can pick it up.
//
// This function is the *queue* feeder for the verification pipeline:
//   - Submit moves the row from 'pending' (or 'ai_rejected') to 'submitted'.
//   - The AI bot polls 'submitted' rows, attempts to match the @mention
//     or location tag, and flips to 'ai_verified' / 'ai_rejected' on its own.
//   - Anything that ends up 'ai_rejected' falls to the waiter via
//     business-verify-story.
//
// Auth model: the caller must be the ticket's consumer. The validator does
// NOT submit on the consumer's behalf — that's the whole point of the proof.
//
// Self-contained: own auth, own DB writes via service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { STORY_KINDS } from "../_shared/ticket-kinds.ts";

type Body = { ticketId?: string; screenshotUrl?: string };

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

  const admin = adminClient(envRes.env);

  const ticketRow = await admin
    .from("tickets")
    .select("id, consumer_id, kind, story_status")
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

  if (ticket.consumer_id !== userId) {
    return json(
      { ok: false, error: "Only the ticket's consumer can submit a story." },
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
