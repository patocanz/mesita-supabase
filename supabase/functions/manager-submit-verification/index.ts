// Supabase Edge Function — manager-submit-verification
//
// Manager submits ownership verification for an unclaimed venue. Two
// methods today:
//
//   - ai_call:  generates a 6-digit OTP code, stores the SHA-256 hash
//               in payload.codeHash, returns the plain code to the
//               caller in `mockCode` (TODO: drop mockCode once Twilio
//               is wired; phase 2 of this EF, manager-verify-call-code,
//               accepts the code and approves). Insert lands as
//               status='pending' regardless of auto-mode — the code
//               entry IS the verification.
//   - video:    stores videoUrl in payload, auto-approves if
//               app_settings.auto_verify_venues is true (admin queue
//               otherwise).
//
// Auto-approve path inserts the venue_members owner row in the same EF
// call. The caller does NOT have to be an existing venue_members row;
// they're staking a claim.
//
// Dedup: any existing pending row for (venue_id, requester_id) is
// deleted before the insert, so submitting again replaces the prior
// claim. A partial unique index (migration 0014) catches races.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Method = "ai_call" | "video" | "postcard";

type Body = {
  venueId?: string;
  method?: Method;
  requesterEmail?: string;
  videoUrl?: string;
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

  // ai_call: generate code + hash. Plain code is returned only when
  // Twilio isn't configured (mock mode); production gets the code via
  // the actual phone call.
  let mockCode: string | null = null;
  if (method === "ai_call") {
    payload.phoneCalled = venue.phone ?? null;
    const code = randomSixDigits();
    payload.codeHash = await sha256Hex(code);
    if (!Deno.env.get("TWILIO_AUTH_TOKEN")) mockCode = code;
  }

  // ai_call has its own confirmation step (manager-verify-call-code),
  // so it ignores the auto-mode flag — the code entry IS the
  // verification. video / postcard honour auto-mode.
  const { data: settings } = await admin
    .from("app_settings")
    .select("auto_verify_venues")
    .eq("id", 1)
    .maybeSingle();
  const autoVerify =
    method !== "ai_call" && settings?.auto_verify_venues === true;

  // Dedup: drop any prior pending claim by this caller on this venue
  // before inserting the new one. The partial unique index in
  // migration 0014 catches concurrent inserts; this avoids the
  // friendly-error path under sequential resubmits.
  await admin
    .from("venue_verifications")
    .delete()
    .eq("venue_id", venueId)
    .eq("requester_id", userId)
    .eq("status", "pending");

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

  if (autoVerify) {
    const { error: memberError } = await admin.from("venue_members").insert({
      venue_id: venueId,
      manager_id: userId,
      role: "owner",
    });
    if (memberError) {
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

  return json({ ok: true, verification, mockCode });
});

// ── helpers ───────────────────────────────────────────────────────────

function randomSixDigits(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // Modulo 1,000,000 is acceptable for OTP — small bias is irrelevant
  // for a code that lives ~5 minutes and isn't a long-term secret.
  return (buf[0] % 1_000_000).toString().padStart(6, "0");
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
