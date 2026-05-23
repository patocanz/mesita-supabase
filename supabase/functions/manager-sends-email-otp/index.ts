// Supabase Edge Function — manager-sends-email-otp
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
// in the UI; manager-verifies-email closes the loop. Provider wiring
// (Resend / Postmark / etc.) lands later without changing the contract.
//
// The email NEVER comes from the user. We always send to the email
// stored on the venue row, captured at create time.
//
// Auth: any signed-in user. Pending-row dedup mirrors the phone path.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";
import { isEmailish } from "../_shared/input.ts";
import { isOnDomain } from "../_shared/onboarding.ts";
import { randomSixDigits, sha256Hex } from "../_shared/otp.ts";

type Body = { venueId?: string; requesterEmail?: string };

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
  if (!isEmailish(requesterEmail)) {
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

  const code = randomSixDigits();
  const codeHash = await sha256Hex(code);
  // Mock mode until a transactional provider is wired. Same contract
  // as the phone path: plain code in mockCode when not configured.
  const providerConfigured = !!Deno.env.get("RESEND_SUPABASE_API_KEY");
  const mockCode = providerConfigured ? null : code;

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
      method: "ai_email",
      payload: {
        emailSent: venue.email,
        websiteUrl: venue.website_url,
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

  // TODO: when RESEND_SUPABASE_API_KEY (or whichever provider) is set,
  // send the actual email here. For now we return immediately so the
  // UI can flip into the OTP-entry state with the mock code visible.

  return json({
    ok: true,
    verificationId: verification.id,
    sentTo: venue.email,
    mockCode,
  });
});

