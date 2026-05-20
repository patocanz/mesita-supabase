// Supabase Edge Function — manager-submit-verification
//
// Manager submits ownership verification for a venue they created.
// Three methods, all written to public.venue_verifications:
//
//   - ai_call:  automated phone call to the Google-listed venue phone
//               with a 6-digit code (MOCKED for v0 — we don't actually
//               place the call, just record the method choice).
//   - video:    manager pastes a URL to a ≤1-minute walkthrough video.
//   - postcard: Google-style mailed code (MOCKED — no postcard sent).
//
// If public.app_settings.auto_verify_venues is true, the row is
// inserted with status='approved' and the venue is flipped to
// ('web', 'active') in the same EF call. Otherwise it lands as
// 'pending' and an admin reviews in admin.mesita.ai/verifications.
//
// Self-contained: own JWT verification, own DB writes via service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Method = "ai_call" | "video" | "postcard";

type Body = {
  venueId?: string;
  method?: Method;
  requesterEmail?: string;
  // Method-specific:
  videoUrl?: string; // method === 'video'
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

  // Auth.
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

  // Body.
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const venueId = (body.venueId ?? "").trim();
  const method = body.method;
  const requesterEmail = (body.requesterEmail ?? "").trim().toLowerCase();
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (!method || !["ai_call", "video", "postcard"].includes(method)) {
    return json(
      { ok: false, error: "method must be ai_call | video | postcard" },
      400,
    );
  }
  if (!requesterEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requesterEmail)) {
    return json(
      { ok: false, error: "requesterEmail must look like name@domain.tld" },
      400,
    );
  }

  // Method-specific payload + validation.
  const payload: Record<string, unknown> = {};
  if (method === "video") {
    const videoUrl = (body.videoUrl ?? "").trim();
    if (!videoUrl || !/^https:\/\/[^\s]+$/.test(videoUrl)) {
      return json(
        { ok: false, error: "videoUrl must be an https:// URL" },
        400,
      );
    }
    payload.videoUrl = videoUrl;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // The caller must be a venue_members row on this venue (set during
  // manager-create-unit) and the venue must currently be in
  // pending_verification — submitting verification for an already-active
  // venue is a no-op.
  const { data: membership } = await admin
    .from("venue_members")
    .select("role")
    .eq("venue_id", venueId)
    .eq("manager_id", userId)
    .maybeSingle();
  if (!membership) {
    return json({ ok: false, error: "Not a member of this venue" }, 403);
  }

  const { data: venue, error: venueError } = await admin
    .from("venues")
    .select("id, status, phone")
    .eq("id", venueId)
    .maybeSingle();
  if (venueError || !venue) {
    return json({ ok: false, error: "Venue not found" }, 404);
  }
  // Accept either of the two "claimed but not verified" statuses. The
  // older manager-create-unit deploys still write 'pending_review';
  // newer ones write 'pending_verification'. Both should be verifiable.
  if (
    venue.status !== "pending_verification" &&
    venue.status !== "pending_review"
  ) {
    return json(
      {
        ok: false,
        code: "venue_not_pending",
        error: "This venue is not awaiting verification.",
      },
      409,
    );
  }

  // Capture the Google-listed phone the call would target (or null) so
  // future audits see what the venue's phone WAS at submit time.
  if (method === "ai_call") {
    payload.phoneCalled = venue.phone ?? null;
  }

  // Read auto-verify flag.
  const { data: settings } = await admin
    .from("app_settings")
    .select("auto_verify_venues")
    .eq("id", 1)
    .maybeSingle();
  const autoVerify = settings?.auto_verify_venues === true;

  // Insert the verification row. If auto-mode is on, mark it approved
  // up-front so the admin queue stays empty.
  const now = new Date().toISOString();
  const insertRow = {
    venue_id: venueId,
    requester_id: userId,
    method,
    payload,
    requester_email: requesterEmail,
    status: autoVerify ? "approved" : "pending",
    decided_at: autoVerify ? now : null,
    decided_by: autoVerify ? userId : null,
    decided_via: autoVerify ? "auto" : null,
  };
  const { data: verification, error: insertError } = await admin
    .from("venue_verifications")
    .insert(insertRow)
    .select("id, status, decided_via, decided_at")
    .single();
  if (insertError) {
    return json(
      { ok: false, error: `verification_insert: ${insertError.message}` },
      500,
    );
  }

  // Auto-approved → flip venue to ('web', 'active') so the manager can
  // start managing immediately. Failure here is bad: we have an approved
  // verification but the venue is still pending. Surface it loudly.
  if (autoVerify) {
    const { error: venueFlipError } = await admin
      .from("venues")
      .update({ status: "active", listing_type: "web" })
      .eq("id", venueId);
    if (venueFlipError) {
      console.error(
        "[manager-submit-verification] venue flip after auto-approve:",
        venueFlipError.message,
      );
      return json(
        {
          ok: false,
          code: "venue_flip_failed",
          error: `Verification approved but venue could not be activated: ${venueFlipError.message}`,
        },
        500,
      );
    }
  }

  return json({ ok: true, verification });
});
