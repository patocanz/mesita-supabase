// Supabase Edge Function — business-sends-phone-otp
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
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { isEmailish } from "../_shared/input.ts";
import {
  insertPendingOtpVerification,
  randomSixDigits,
  sha256Hex,
} from "../_shared/otp.ts";

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

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const venueId = (body.venueId ?? "").trim();
  const requesterEmail = (body.requesterEmail ?? "").trim().toLowerCase();
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (!isEmailish(requesterEmail)) {
    return json(
      { ok: false, error: "requesterEmail must look like name@domain.tld" },
      400,
    );
  }

  const admin = adminClient(envRes.env);

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
    .select("business_id")
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

  const insertRes = await insertPendingOtpVerification(admin, {
    venueId,
    userId,
    requesterEmail,
    method: "ai_call",
    payload: { phoneCalled: venue.phone, channel },
    codeHash,
  });
  if (!insertRes.ok) return insertRes.response;

  // TODO: when TWILIO_AUTH_TOKEN is wired, place the actual call/SMS
  // here. For now we return immediately so the UI can flip into the
  // OTP-entry state with the mock code visible.

  return json({
    ok: true,
    verificationId: insertRes.verificationId,
    channel,
    phoneDialed: venue.phone,
    mockCode,
  });
});

