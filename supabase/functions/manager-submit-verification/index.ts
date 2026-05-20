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

  // The venue must exist and must NOT already have a verified owner.
  // The caller is staking a claim — they aren't a venue_members row yet
  // (and won't be until admin-decide-verification approves them).
  const { data: venue, error: venueError } = await admin
    .from("venues")
    .select("id, phone")
    .eq("id", venueId)
    .maybeSingle();
  if (venueError || !venue) {
    return json({ ok: false, error: "Venue not found" }, 404);
  }
  const { data: existingOwner } = await admin
    .from("venue_members")
    .select("manager_id")
    .eq("venue_id", venueId)
    .eq("role", "owner")
    .maybeSingle();
  if (existingOwner) {
    return json(
      {
        ok: false,
        code: "venue_already_owned",
        error:
          "This venue already has a verified owner. Use the contact / report-fraud flow instead.",
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

  // Auto-approved → insert the owning venue_members row. The venue
  // itself was already active+web from manager-create-unit; the only
  // missing piece is the membership that lets this manager manage it.
  if (autoVerify) {
    const { error: memberError } = await admin.from("venue_members").insert({
      venue_id: venueId,
      manager_id: userId,
      role: "owner",
    });
    if (memberError) {
      console.error(
        "[manager-submit-verification] venue_members insert after auto-approve:",
        memberError.message,
      );
      // Roll the verification back so the caller can retry instead of
      // sitting in a half-approved state. A unique-violation here
      // means a parallel claim won; that's fine — surface it.
      await admin
        .from("venue_verifications")
        .update({
          status: "pending",
          decided_at: null,
          decided_by: null,
          decided_via: null,
        })
        .eq("id", verification.id);
      return json(
        {
          ok: false,
          code: "ownership_grant_failed",
          error: `Verification approved but ownership could not be granted: ${memberError.message}`,
        },
        500,
      );
    }
  }

  return json({ ok: true, verification });
});
