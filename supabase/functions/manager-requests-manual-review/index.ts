// Supabase Edge Function — manager-requests-manual-review
//
// Always-available fallback for /add ownership verification. Used when:
//
//   * the venue has no Google-listed phone, AND
//   * no on-domain email was discovered on the website
//
// …or any operator who'd rather talk to a human. Unlike ai_call and
// ai_email, this path NEVER auto-grants ownership. It writes a pending
// venue_verifications row (method='manual_contact') so the admin queue
// sees the request, and returns the Mesita ops contact details the UI
// renders as deep-link buttons.
//
// Region routing (off the venue's country):
//   MX / LatAm (long list)  →  WhatsApp as primary, email floor
//   US / CA                  →  SMS as primary, email floor
//   anything else / null     →  email only
//
// For now WhatsApp and SMS are placeholders — the buttons render off
// optional env vars (MESITA_OPS_WHATSAPP, MESITA_OPS_SMS) and when those
// are unset only the email button is shown. Email defaults to
// hello@mesita.ai. The UI uses these to build mailto:/wa.me:/sms: links;
// no provider integration runs here.
//
// Auth: any signed-in user.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = { venueId?: string; requesterEmail?: string; note?: string };

type Region = "mx_latam" | "us" | "other";

const LATAM_COUNTRIES = new Set([
  "mexico",
  "argentina",
  "colombia",
  "chile",
  "peru",
  "uruguay",
  "brazil",
  "ecuador",
  "bolivia",
  "paraguay",
  "venezuela",
  "guatemala",
  "costa rica",
  "panama",
  "dominican republic",
  "el salvador",
  "honduras",
  "nicaragua",
  "puerto rico",
]);

function regionForCountry(country: string | null): Region {
  if (!country) return "other";
  const c = country.toLowerCase();
  if (c === "united states" || c === "us" || c === "canada" || c === "ca") {
    return "us";
  }
  if (LATAM_COUNTRIES.has(c)) return "mx_latam";
  return "other";
}

// Ops contact destinations. Email is hard-baked so the floor always
// works; WhatsApp/SMS are env-driven so we can flip them on without
// a redeploy when real numbers exist.
const OPS_EMAIL = "hello@mesita.ai";

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
  const note = (body.note ?? "").trim().slice(0, 500);
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
    .select("id, name, country")
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

  const region = regionForCountry(venue.country);
  const whatsapp = (Deno.env.get("MESITA_OPS_WHATSAPP") ?? "").trim() || null;
  const sms = (Deno.env.get("MESITA_OPS_SMS") ?? "").trim() || null;

  // Dedup: drop any prior pending row by this caller on this venue
  // before inserting the new one. Same pattern as the OTP EFs.
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
      method: "manual_contact",
      payload: {
        region,
        note: note || null,
        // Mirror the resolved contact set on the row so admins reviewing
        // this later see exactly which channels we offered.
        offered: {
          whatsapp: region === "mx_latam" ? whatsapp : null,
          sms: region === "us" ? sms : null,
          email: OPS_EMAIL,
        },
      },
      requester_email: requesterEmail,
      // manual_contact never auto-verifies; the row sits in the admin
      // queue until a human flips it via admin-decide-verification.
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

  return json({
    ok: true,
    verificationId: verification.id,
    region,
    contact: {
      whatsapp: region === "mx_latam" ? whatsapp : null,
      sms: region === "us" ? sms : null,
      email: OPS_EMAIL,
    },
    venueName: venue.name,
  });
});
