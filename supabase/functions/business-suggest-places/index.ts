// Supabase Edge Function — business-suggest-places
//
// Proxies Google Places API (New) Autocomplete so the Google key never
// leaves Supabase. The key is read from the secret
// `SUPA_GMP_KEY` (set via Dashboard → Edge
// Functions → Secrets, or `supabase secrets set`).
//
// Naming convention for third-party secrets:
//   `<VENDOR>_SUPABASE_API_KEY`  (server-side, lives in Supabase secrets)
//   `NEXT_PUBLIC_<VENDOR>_BROWSER_KEY`  (client-side, lives in Vercel)
//
// JWT-protected: clients must send the Supabase anon JWT in `Authorization`.
//
// Also runs a Mesita-side name ILIKE search in parallel so already-
// onboarded venues surface even when Google autocomplete misses (Google
// is picky about city qualifiers, accents, etc.). Each prediction
// carries a `status` so the UI can render the right per-row badge
// (not_in_mesita / web_listed / verified_partner_other /
// verified_partner_self).
//
// IMPORTANT: this function always returns HTTP 200, even on Google
// failures. supabase-js's `functions.invoke` swallows the response body
// on non-2xx and surfaces a generic message, which makes real errors
// invisible. The body's `{ ok, error }` shape carries the real signal.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";

// Restrict Google autocomplete to F&B / nightlife primary types so
// non-hospitality matches (tire shops, mechanics, pharmacies, hardware
// stores…) don't pollute the picker. Google's API caps this at 5 from
// Table A, so we pick the broadest 5 that cover Mesita's universe.
// Trade-off: cuisine-specific Table A types (italian_restaurant,
// mexican_restaurant, sushi_restaurant, …) get filtered out because
// each place has exactly one primary type. The Mesita-side ILIKE
// fallback below still surfaces them once they've been onboarded —
// and a new cuisine-specific place can be added by pasting the Google
// Place ID directly through business-create-unit.
const MESITA_PRIMARY_TYPES = [
  "restaurant",
  "bar",
  "cafe",
  "night_club",
  "bakery",
];

type Body = { input?: string; sessionToken?: string };

// Mirrors the lookup EF's coarse states, plus a self/other split for the
// owned case so the picker can say "you own this" without a second
// round-trip.
type PredictionStatus =
  | "not_in_mesita"
  | "web_listed"
  | "verified_partner_other"
  | "verified_partner_self";

type Prediction = {
  placeId: string;
  mainText: string;
  secondaryText: string;
  status: PredictionStatus;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" });
  }

  const apiKey = Deno.env.get("SUPA_GMP_KEY");
  if (!apiKey) {
    return json({
      ok: false,
      code: "server_missing_key",
      error:
        "Mesita backend isn't configured for Google Places. Tell support — they need to set SUPA_GMP_KEY.",
    });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" });
  }

  const input = (body.input ?? "").toString().trim();
  const sessionToken = (body.sessionToken ?? "").toString();

  if (input.length < 2) {
    return json({ ok: true, predictions: [] });
  }
  if (!sessionToken) {
    return json({ ok: false, error: "Missing sessionToken" });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const admin =
    SUPABASE_URL && SERVICE_KEY
      ? createClient(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  // We need the caller's id to flag verified_partner_self vs _other on
  // the Mesita-side matches. An unauthenticated call still gets useful
  // predictions — ownership flagging just degrades to "_other" because
  // there's no caller to compare against.
  let userId: string | null = null;
  const authHeader = req.headers.get("Authorization") ?? "";
  if (SUPABASE_URL && ANON_KEY && authHeader.startsWith("Bearer ")) {
    try {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data } = await userClient.auth.getUser();
      userId = data.user?.id ?? null;
    } catch (err) {
      console.error("[business-suggest-places] auth.getUser:", err);
    }
  }

  // Fire Google + Mesita searches in parallel. Either can fail
  // independently; we merge whatever comes back.
  const [googleResult, mesitaResult] = await Promise.allSettled([
    fetchGooglePredictions(input, sessionToken, apiKey),
    admin ? fetchMesitaPredictions(admin, input, userId) : Promise.resolve([] as Prediction[]),
  ]);

  if (googleResult.status === "rejected" && mesitaResult.status === "rejected") {
    return json({
      ok: false,
      code: "network_error",
      error:
        googleResult.reason instanceof Error
          ? googleResult.reason.message
          : "Search failed.",
    });
  }
  // If Google explicitly returned an error envelope (not just rejected),
  // surface that — Mesita fallback alone isn't enough for the operator
  // to know their search worked.
  if (googleResult.status === "fulfilled" && googleResult.value.errorEnvelope) {
    return json(googleResult.value.errorEnvelope);
  }

  const googlePreds =
    googleResult.status === "fulfilled" ? googleResult.value.predictions : [];
  const mesitaPreds =
    mesitaResult.status === "fulfilled" ? mesitaResult.value : [];

  // Merge: Mesita-side hits take precedence (their status wins over a
  // Google entry with the same placeId), then any remaining Google
  // entries follow. Google's structured text is usually nicer, so we
  // keep its mainText/secondaryText but graft Mesita's status on top
  // when the placeId is in both sources.
  const byPlaceId = new Map<string, Prediction>();
  for (const p of mesitaPreds) byPlaceId.set(p.placeId, p);
  for (const p of googlePreds) {
    const existing = byPlaceId.get(p.placeId);
    byPlaceId.set(p.placeId, existing ? { ...p, status: existing.status } : p);
  }

  // Backfill status for predictions Google returned but the ILIKE
  // fallback missed. The ILIKE matches against the raw input, so a query
  // like "Strana San Pedro" doesn't catch a venue named just "Strana"
  // even though Google's placeId is in our DB. This second pass keys
  // off Google's placeId directly and overwrites status accordingly.
  const orphanPlaceIds = Array.from(byPlaceId.values())
    .filter((p) => p.status === "not_in_mesita")
    .map((p) => p.placeId);
  if (orphanPlaceIds.length > 0 && admin) {
    const statusByPlaceId = await enrichByPlaceIds(admin, orphanPlaceIds, userId);
    for (const [placeId, status] of statusByPlaceId) {
      const existing = byPlaceId.get(placeId);
      if (!existing) continue;
      byPlaceId.set(placeId, { ...existing, status });
    }
  }

  // Already-in-Mesita predictions surface first so the operator sees
  // the existing profile before the long tail of Google matches.
  const predictions = Array.from(byPlaceId.values()).sort((a, b) => {
    const aIn = a.status !== "not_in_mesita";
    const bIn = b.status !== "not_in_mesita";
    return aIn === bIn ? 0 : aIn ? -1 : 1;
  });

  return json({ ok: true, predictions });
});

// ── Google ────────────────────────────────────────────────────────────

async function fetchGooglePredictions(
  input: string,
  sessionToken: string,
  apiKey: string,
): Promise<{
  predictions: Prediction[];
  errorEnvelope?: Record<string, unknown>;
}> {
  const r = await fetch(AUTOCOMPLETE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
    },
    body: JSON.stringify({
      input,
      sessionToken,
      includedPrimaryTypes: MESITA_PRIMARY_TYPES,
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    const code = classifyGoogleError(r.status, text);
    return {
      predictions: [],
      errorEnvelope: {
        ok: false,
        code,
        error: friendlyGoogleError(code, r.status, text),
        httpStatus: r.status,
      },
    };
  }

  const data = (await r.json()) as {
    suggestions?: Array<{
      placePrediction?: {
        placeId: string;
        structuredFormat?: {
          mainText?: { text?: string };
          secondaryText?: { text?: string };
        };
        text?: { text?: string };
      };
    }>;
  };

  const predictions = (data.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map<Prediction>((p) => ({
      placeId: p.placeId,
      mainText: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
      secondaryText: p.structuredFormat?.secondaryText?.text ?? "",
      status: "not_in_mesita",
    }))
    .filter((p) => p.placeId && p.mainText);
  return { predictions };
}

// ── Mesita-side fallback ──────────────────────────────────────────────

async function fetchMesitaPredictions(
  admin: ReturnType<typeof createClient>,
  input: string,
  callerId: string | null,
): Promise<Prediction[]> {
  // ILIKE prefix-and-contains so "strana" finds both "Strana" and "Casa
  // Strana, Monterrey". Limit small — Google is the primary surface;
  // this is a fallback for the long-tail case where Google misses.
  const { data, error } = await admin
    .from("venues")
    .select("id, google_place_id, name, address")
    .ilike("name", `%${escapeIlike(input)}%`)
    .not("google_place_id", "is", null)
    .limit(8);
  if (error) {
    console.error("[business-suggest-places] mesita search:", error.message);
    return [];
  }
  type Row = {
    id: string;
    google_place_id: string;
    name: string;
    address: string | null;
  };
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return [];

  const statuses = await statusesForVenues(admin, rows, callerId);
  return rows.map<Prediction>((v) => ({
    placeId: v.google_place_id,
    mainText: v.name,
    secondaryText: v.address ?? "Already on Mesita",
    status: statuses.get(v.google_place_id) ?? "web_listed",
  }));
}

function escapeIlike(s: string): string {
  // % and _ are wildcards in ILIKE — escape so user input doesn't
  // accidentally match everything.
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Resolves a placeId list against Mesita venues + venue_members. Used
// to backfill status for Google-sourced predictions the ILIKE fallback
// missed because the input string didn't match the venue name.
async function enrichByPlaceIds(
  admin: ReturnType<typeof createClient>,
  placeIds: string[],
  callerId: string | null,
): Promise<Map<string, PredictionStatus>> {
  const { data, error } = await admin
    .from("venues")
    .select("id, google_place_id")
    .in("google_place_id", placeIds);
  if (error) {
    console.error(
      "[business-suggest-places] placeId enrichment:",
      error.message,
    );
    return new Map();
  }
  type Row = { id: string; google_place_id: string };
  return statusesForVenues(admin, (data ?? []) as Row[], callerId);
}

// One owner-lookup pass over a venue-row set, returning the per-placeId
// PredictionStatus. Both the ILIKE search and the placeId backfill route
// through this so the status math + the venue_members query live in one
// place. `web_listed` for unowned rows, `verified_partner_self/_other`
// for owned ones depending on whether the caller is the owner.
async function statusesForVenues(
  admin: ReturnType<typeof createClient>,
  rows: Array<{ id: string; google_place_id: string }>,
  callerId: string | null,
): Promise<Map<string, PredictionStatus>> {
  if (rows.length === 0) return new Map();
  const { data, error } = await admin
    .from("venue_members")
    .select("venue_id, business_id")
    .in(
      "venue_id",
      rows.map((r) => r.id),
    )
    .eq("role", "owner");
  if (error) {
    console.error("[business-suggest-places] owner lookup:", error.message);
  }
  const ownerByVenue = new Map<string, string>();
  for (const m of (data ?? []) as Array<{
    venue_id: string;
    business_id: string;
  }>) {
    ownerByVenue.set(m.venue_id, m.business_id);
  }
  const out = new Map<string, PredictionStatus>();
  for (const v of rows) {
    const ownerId = ownerByVenue.get(v.id);
    out.set(
      v.google_place_id,
      ownerId
        ? callerId && ownerId === callerId
          ? "verified_partner_self"
          : "verified_partner_other"
        : "web_listed",
    );
  }
  return out;
}

// ── Google error classification ───────────────────────────────────────

function classifyGoogleError(status: number, body: string): string {
  if (status === 403) {
    if (/referer|referrer/i.test(body)) return "google_referrer_blocked";
    if (/api.+disabled|not.+enabled/i.test(body)) return "google_api_disabled";
    if (/quota|exceeded/i.test(body)) return "google_quota_exceeded";
    return "google_permission_denied";
  }
  if (status === 400) return "google_bad_request";
  if (status === 429) return "google_rate_limited";
  if (status >= 500) return "google_unavailable";
  return "google_error";
}

function friendlyGoogleError(code: string, status: number, body: string): string {
  switch (code) {
    case "google_referrer_blocked":
      return "Google rejected the request — the API key has a referrer / IP restriction blocking server-to-server calls. Remove the HTTP-referrer restriction on the Mesita backend key (the browser key keeps its restriction).";
    case "google_api_disabled":
      return "Google Places API (New) isn't enabled on the configured key. Enable it in Google Cloud → APIs & Services.";
    case "google_quota_exceeded":
      return "The Google Places quota for today is exhausted. Try again later or raise the daily cap in Google Cloud.";
    case "google_permission_denied":
      return "Google denied the request (permission). Check that the API key is valid and the project is billing-enabled.";
    case "google_bad_request":
      return `Google rejected the search: ${body.slice(0, 200)}`;
    case "google_rate_limited":
      return "Too many searches in a short window. Wait a few seconds and try again.";
    case "google_unavailable":
      return "Google Places is unavailable right now (5xx). Try again in a moment.";
    default:
      return `Google ${status}: ${body.slice(0, 200)}`;
  }
}
