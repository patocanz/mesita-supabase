// Supabase Edge Function — manager-lookup-venue
//
// Returns the Mesita state of a venue keyed by Google Place ID, so the
// /add page can show the right UI without redirecting:
//
//   not_in_mesita            — no venue row exists for this Place ID.
//                              Caller can ask manager-create-unit to
//                              generate one.
//   web_listed_unclaimed     — venue exists, listing_type='web', no
//                              owner. Caller can submit a verification.
//   pending_by_me            — venue exists, no owner, caller has a
//                              pending venue_verifications row.
//   pending_by_other         — venue exists, no owner, someone else has
//                              a pending verification (caller can still
//                              submit their own).
//   verified_partner         — venue exists and has an owner. Caller
//                              must use the contact / report-fraud flow.
//
// Every claim-able state (web_listed_unclaimed, pending_by_me,
// pending_by_other) also carries a `methods` block describing which
// verification paths the UI should surface:
//
//   methods.phone   — available when venues.phone is non-null.
//   methods.email   — available when venues.email is on-domain (its
//                     host matches the website_url host, ±www. and
//                     subdomain).
//   methods.manual  — always available. Region-bucketed contact details
//                     so the UI can pick WhatsApp (LatAm), SMS (US), or
//                     email-only based on the venue's country.
//
// Auth: any signed-in user.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = { placeId?: string };

const VENUE_COLUMNS =
  "id, slug, name, status, listing_type, address, phone, email, website_url, country, photos, category, vibe, cashback_percent, created_at, updated_at";

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

const OPS_EMAIL = "hello@mesita.ai";

type VenueRow = {
  id: string;
  phone: string | null;
  email: string | null;
  website_url: string | null;
  country: string | null;
};

type MethodsBlock = {
  phone: { available: boolean; displayPhone: string | null };
  email: { available: boolean; displayEmail: string | null };
  manual: {
    region: Region;
    whatsapp: string | null;
    sms: string | null;
    email: string;
  };
};

function regionForCountry(country: string | null): Region {
  if (!country) return "other";
  const c = country.toLowerCase();
  if (c === "united states" || c === "us" || c === "canada" || c === "ca") {
    return "us";
  }
  if (LATAM_COUNTRIES.has(c)) return "mx_latam";
  return "other";
}

// True when the email's domain matches the website's hostname, ignoring
// "www." on either side. Subdomain matches count in both directions so
// `hola@reservas.casaluminar.mx` against `https://casaluminar.mx` passes.
function isOnDomain(email: string, websiteUrl: string): boolean {
  const at = email.indexOf("@");
  if (at < 1) return false;
  const emailHost = email.slice(at + 1).toLowerCase();
  let siteHost: string;
  try {
    siteHost = new URL(websiteUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const stripWww = (h: string) => h.replace(/^www\./, "");
  const a = stripWww(emailHost);
  const b = stripWww(siteHost);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function methodsFor(venue: VenueRow): MethodsBlock {
  const phoneOk = !!venue.phone;
  const emailOk =
    !!venue.email && !!venue.website_url && isOnDomain(venue.email, venue.website_url);
  const region = regionForCountry(venue.country);
  const whatsapp = (Deno.env.get("MESITA_OPS_WHATSAPP") ?? "").trim() || null;
  const sms = (Deno.env.get("MESITA_OPS_SMS") ?? "").trim() || null;
  return {
    phone: {
      available: phoneOk,
      displayPhone: phoneOk ? venue.phone : null,
    },
    email: {
      available: emailOk,
      displayEmail: emailOk ? venue.email : null,
    },
    manual: {
      region,
      whatsapp: region === "mx_latam" ? whatsapp : null,
      sms: region === "us" ? sms : null,
      email: OPS_EMAIL,
    },
  };
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
  const placeId = (body.placeId ?? "").trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Venue row by Place ID.
  const { data: venue, error: venueError } = await admin
    .from("venues")
    .select(VENUE_COLUMNS)
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (venueError) {
    return json(
      { ok: false, error: `venue_lookup: ${venueError.message}` },
      500,
    );
  }
  if (!venue) {
    return json({ ok: true, state: "not_in_mesita", venue: null });
  }

  // 2. Owner check via venue_members.
  const { data: owner } = await admin
    .from("venue_members")
    .select("manager_id, role")
    .eq("venue_id", venue.id)
    .eq("role", "owner")
    .maybeSingle();

  if (owner) {
    const { data: ownerUser } = await admin.auth.admin.getUserById(
      owner.manager_id,
    );
    return json({
      ok: true,
      state: "verified_partner",
      venue,
      owner: {
        id: owner.manager_id,
        email: ownerUser?.user?.email ?? null,
      },
    });
  }

  // From here on the venue is claim-able. Compute the methods block
  // once so all three pending/unclaimed branches return it identically.
  const methods = methodsFor(venue as VenueRow);

  // 3. Pending claim by this caller.
  const { data: pendingForMe } = await admin
    .from("venue_verifications")
    .select(
      "id, method, payload, requester_email, status, reject_reason, decided_at, decided_via, created_at",
    )
    .eq("venue_id", venue.id)
    .eq("requester_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pendingForMe) {
    return json({
      ok: true,
      state: "pending_by_me",
      venue,
      verification: pendingForMe,
      methods,
    });
  }

  // 4. Pending claim from a different user.
  const { data: pendingByOther } = await admin
    .from("venue_verifications")
    .select("id")
    .eq("venue_id", venue.id)
    .eq("status", "pending")
    .neq("requester_id", userId)
    .limit(1)
    .maybeSingle();
  if (pendingByOther) {
    return json({ ok: true, state: "pending_by_other", venue, methods });
  }

  // 5. Default: unclaimed and unmolested.
  return json({ ok: true, state: "web_listed_unclaimed", venue, methods });
});
