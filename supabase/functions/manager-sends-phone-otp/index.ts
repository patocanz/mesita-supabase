// Supabase Edge Function — manager-sends-phone-otp
//
// Phase 1 of the automatic-phone path for /add ownership verification.
// Generates a 6-digit code, hashes it (SHA-256), inserts a pending
// venue_verifications row (method='ai_call', payload={phoneCalled,
// channel, codeHash}), and "dispatches" the code to the
// Google-listed phone via Twilio.
//
// Mock mode: TWILIO_AUTH_TOKEN missing → no call is placed, plaintext
// code is returned to the caller in `mockCode` so the operator can
// complete the loop in dev. Production wires Twilio Verify (call/SMS)
// later; this EF keeps the contract identical either way.
//
// The phone NEVER comes from the user. We always dial the venue's
// google_place_id-sourced phone, copied to payload.phoneCalled at insert
// time so an admin reviewing the row knows exactly what we tried.
//
// Auth: any signed-in user. Dedup against an existing pending row for
// (venue, requester) is handled here — submitting again replaces the
// prior claim.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = { venueId?: string; requesterEmail?: string };

// Channel choice. Voice for LatAm (landlines common; SMS-to-landline
// fails). SMS for US/CA (mobile-dominant; voice OTPs feel jarring).
// Everywhere else defaults to voice — the EF still works, the operator
// just hears the code instead of reading it.
function channelForCountry(country: string | null): "call" | "sms" {
  if (!country) return "call";
  const c = country.toLowerCase();
  if (c === "united states" || c === "us" || c === "canada" || c === "ca") {
    return "sms";
  }
  return "call";
}

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
  const requesterEmail = (body.requesterEmail ?? "").trim().toLowerCase();
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (!requesterEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requesterEmail)) {
    return json(
      { ok: false, error: "requesterEmail must look like name@domain.tld" },
      400,
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: venue, error: venueError } = await admin
    .from("venues")
    .select("id, phone, country")
    .eq("id", venueId)
    .maybeSingle();
  if (venueError || !venue) {
    return json({ ok: false, error: "Venue not found" }, 404);
  }
  if (!venue.phone) {
    return json(
      {
        ok: false,
        code: "no_phone_on_record",
        error:
          "This venue has no Google-listed phone — use the email or manual fallback.",
      },
      409,
    );
  }

  // Owner check — never let a claim go through on an already-owned
  // venue. The lookup EF blocks the UI from getting here, but a
  // second guard keeps the path safe under stale clients.
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

  const channel = channelForCountry(venue.country);
  const code = randomSixDigits();
  const codeHash = await sha256Hex(code);
  // Mock mode when no Twilio token is set. Real Twilio integration
  // lands later; the shape of this EF doesn't change at that point —
  // mockCode just becomes null and the call actually places.
  const mockCode = Deno.env.get("TWILIO_AUTH_TOKEN") ? null : code;

  // Dedup: drop any prior pending claim by this caller on this venue
  // before inserting the new one. The partial unique index in
  // migration 0014 catches concurrent inserts.
  await admin
    .from("venue_verifications")
    .delete()
    .eq("venue_id", venueId)
    .eq("requester_id", userId)
    .eq("status", "pending");

  const { data: verification, error: insertError } = await admin
    .from("venue_verifications")
    .insert({
      venue_id: venueId,
      requester_id: userId,
      method: "ai_call",
      payload: {
        phoneCalled: venue.phone,
        channel,
        codeHash,
      },
      requester_email: requesterEmail,
      status: "pending",
    })
    .select("id")
    .single();
  if (insertError) {
    return json(
      { ok: false, error: `verification_insert: ${insertError.message}` },
      500,
    );
  }

  // TODO: when TWILIO_AUTH_TOKEN is wired, place the actual call/SMS
  // here. For now we return immediately so the UI can flip into the
  // OTP-entry state with the mock code visible.

  return json({
    ok: true,
    verificationId: verification.id,
    channel,
    phoneDialed: venue.phone,
    mockCode,
  });
});

// ── helpers ───────────────────────────────────────────────────────────

function randomSixDigits(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % 1_000_000).toString().padStart(6, "0");
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
