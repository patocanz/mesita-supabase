// Supabase Edge Function — business-sends-email-otp
//
// Phase 1 of the automatic-email path for /add ownership verification.
// Sends a 6-digit OTP to the venue's Firecrawl-discovered email — but
// only when that email is **on-domain**, i.e. its host matches the
// venue's own website_url. A gmail/hotmail/etc. address scraped from
// the site doesn't qualify; the manual fallback covers those.
//
// On-domain rule: email host == website host (both stripped of "www.").
// We also accept exact subdomain matches in either direction, so
// "hola@reservas.casaluminar.mx" against website "casaluminar.mx" still
// passes. That window is intentionally wide — a venue's own subdomain
// is still the venue.
//
// Mock mode: no transactional email provider is wired yet, so the
// plaintext code is returned in `mockCode`. The operator types it back
// in the UI; business-verifies-email closes the loop. Provider wiring
// (Resend / Postmark / etc.) lands later without changing the contract.
//
// The email NEVER comes from the user. We always send to the email
// stored on the venue row, captured at create time.
//
// Auth: any signed-in user. Pending-row dedup mirrors the phone path.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { isEmailish } from "../_shared/input.ts";
import { isOnDomain } from "../_shared/onboarding.ts";
import {
  insertPendingOtpVerification,
  randomSixDigits,
  sha256Hex,
} from "../_shared/otp.ts";

type Body = { venueId?: string; requesterEmail?: string };

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
    .select("id, email, website_url")
    .eq("id", venueId)
    .maybeSingle();
  if (venueError || !venue) {
    return json({ ok: false, error: "Venue not found" }, 404);
  }
  if (!venue.email || !venue.website_url) {
    return json(
      {
        ok: false,
        code: "no_on_domain_email",
        error:
          "This venue has no on-domain email on file — use the phone or manual fallback.",
      },
      409,
    );
  }
  if (!isOnDomain(venue.email, venue.website_url)) {
    return json(
      {
        ok: false,
        code: "email_not_on_domain",
        error:
          "The venue's email isn't on the same domain as its website — use the manual fallback.",
      },
      409,
    );
  }

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

  const code = randomSixDigits();
  const codeHash = await sha256Hex(code);
  // Mock mode until a transactional provider is wired. Same contract
  // as the phone path: plain code in mockCode when not configured.
  const providerConfigured = !!Deno.env.get("RESEND_SUPABASE_API_KEY");
  const mockCode = providerConfigured ? null : code;

  const insertRes = await insertPendingOtpVerification(admin, {
    venueId,
    userId,
    requesterEmail,
    method: "ai_email",
    payload: { emailSent: venue.email, websiteUrl: venue.website_url },
    codeHash,
  });
  if (!insertRes.ok) return insertRes.response;

  // TODO: when RESEND_SUPABASE_API_KEY (or whichever provider) is set,
  // send the actual email here. For now we return immediately so the
  // UI can flip into the OTP-entry state with the mock code visible.

  return json({
    ok: true,
    verificationId: insertRes.verificationId,
    sentTo: venue.email,
    mockCode,
  });
});

