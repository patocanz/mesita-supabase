// Supabase Edge Function — manager-suggest-places
//
// Proxies Google Places API (New) Autocomplete so the Google key never
// leaves Supabase. The key is read from the secret
// `GOOGLE_MAPS_PLATFORM_SUPABASE_API_KEY` (set via Dashboard → Edge
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
// carries `inMesita: boolean` so the UI can badge it.
//
// IMPORTANT: this function always returns HTTP 200, even on Google
// failures. supabase-js's `functions.invoke` swallows the response body
// on non-2xx and surfaces a generic message, which makes real errors
// invisible. The body's `{ ok, error }` shape carries the real signal.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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
// Place ID directly through manager-create-unit.
const MESITA_PRIMARY_TYPES = [
  "restaurant",
  "bar",
  "cafe",
  "night_club",
  "bakery",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Body = { input?: string; sessionToken?: string };

type Prediction = {
  placeId: string;
  mainText: string;
  secondaryText: string;
  inMesita: boolean;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" });
  }

  const apiKey = Deno.env.get("GOOGLE_MAPS_PLATFORM_SUPABASE_API_KEY");
  if (!apiKey) {
    return jsonResponse({
      ok: false,
      code: "server_missing_key",
      error:
        "Mesita backend isn't configured for Google Places. Tell support — they need to set GOOGLE_MAPS_PLATFORM_SUPABASE_API_KEY.",
    });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" });
  }

  const input = (body.input ?? "").toString().trim();
  const sessionToken = (body.sessionToken ?? "").toString();

  if (input.length < 2) {
    return jsonResponse({ ok: true, predictions: [], mock: false });
  }
  if (!sessionToken) {
    return jsonResponse({ ok: false, error: "Missing sessionToken" });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  // Fire Google + Mesita searches in parallel. Either can fail
  // independently; we merge whatever comes back.
  const [googleResult, mesitaResult] = await Promise.allSettled([
    fetchGooglePredictions(input, sessionToken, apiKey),
    SUPABASE_URL && SERVICE_KEY
      ? fetchMesitaPredictions(SUPABASE_URL, SERVICE_KEY, input)
      : Promise.resolve([] as Prediction[]),
  ]);

  if (googleResult.status === "rejected" && mesitaResult.status === "rejected") {
    return jsonResponse({
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
    return jsonResponse(googleResult.value.errorEnvelope);
  }

  const googlePreds =
    googleResult.status === "fulfilled" ? googleResult.value.predictions : [];
  const mesitaPreds =
    mesitaResult.status === "fulfilled" ? mesitaResult.value : [];

  // Merge: Mesita-side hits take precedence (their inMesita=true wins
  // over a Google entry with the same placeId), then any remaining
  // Google entries follow. Stable order.
  const byPlaceId = new Map<string, Prediction>();
  for (const p of mesitaPreds) byPlaceId.set(p.placeId, p);
  for (const p of googlePreds) {
    const existing = byPlaceId.get(p.placeId);
    if (existing) {
      // Google's structured format is usually nicer text; keep Mesita's
      // inMesita flag and prefer Google's text when both exist.
      byPlaceId.set(p.placeId, { ...p, inMesita: existing.inMesita });
    } else {
      byPlaceId.set(p.placeId, p);
    }
  }
  // Already-in-Mesita predictions surface first so the operator sees
  // the existing profile before the long tail of Google matches.
  const predictions = Array.from(byPlaceId.values()).sort((a, b) => {
    if (a.inMesita === b.inMesita) return 0;
    return a.inMesita ? -1 : 1;
  });

  return jsonResponse({ ok: true, predictions, mock: false });
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
      inMesita: false,
    }))
    .filter((p) => p.placeId && p.mainText);
  return { predictions };
}

// ── Mesita-side fallback ──────────────────────────────────────────────

async function fetchMesitaPredictions(
  supabaseUrl: string,
  serviceKey: string,
  input: string,
): Promise<Prediction[]> {
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // ILIKE prefix-and-contains so "strana" finds both "Strana" and "Casa
  // Strana, Monterrey". Limit small — Google is the primary surface;
  // this is a fallback for the long-tail case where Google misses.
  const { data, error } = await admin
    .from("venues")
    .select("google_place_id, name, address")
    .ilike("name", `%${escapeIlike(input)}%`)
    .not("google_place_id", "is", null)
    .limit(8);
  if (error) {
    console.error("[manager-suggest-places] mesita search:", error.message);
    return [];
  }
  type Row = { google_place_id: string; name: string; address: string | null };
  return ((data ?? []) as Row[]).map<Prediction>((v) => ({
    placeId: v.google_place_id,
    mainText: v.name,
    secondaryText: v.address ?? "Already on Mesita",
    inMesita: true,
  }));
}

function escapeIlike(s: string): string {
  // % and _ are wildcards in ILIKE — escape so user input doesn't
  // accidentally match everything.
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
