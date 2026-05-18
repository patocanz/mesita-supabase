// Supabase Edge Function — places-autocomplete
//
// Proxies Google Places API (New) Autocomplete so the Google key never
// leaves Supabase. The key is read from the secret `GOOGLE_MAPS_SUPABASE_KEY`
// (set via Dashboard → Edge Functions → Secrets, or `supabase secrets set`).
//
// Naming convention for third-party keys: `<VENDOR>_<AUDIENCE>_KEY`.
//   - `<AUDIENCE>` is SUPABASE when the key lives in Supabase secrets
//     (server-only) or BROWSER when it lives in Vercel as NEXT_PUBLIC_*.
//   - No `PLATFORM`, no `API` — both are redundant.
//
// JWT-protected: clients must send the Supabase anon JWT in `Authorization`.
//
// IMPORTANT: this function always returns HTTP 200, even on Google failures.
// supabase-js's `functions.invoke` swallows the response body on non-2xx
// and surfaces a generic "Edge Function returned a non-2xx status code" to
// the client, which makes real errors invisible. By keeping the wire status
// at 200 and using the body's `{ ok, error }` shape, the existing client
// helper (`if (!data?.ok) throw new Error(data.error)`) shows the real
// message. The body still carries a `httpStatus` field for telemetry.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Body = { input?: string; sessionToken?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" });
  }

  const apiKey = Deno.env.get("GOOGLE_MAPS_SUPABASE_KEY");
  if (!apiKey) {
    return jsonResponse({
      ok: false,
      code: "server_missing_key",
      error:
        "Mesita backend isn't configured for Google Places. Tell support — they need to set GOOGLE_MAPS_SUPABASE_KEY.",
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

  try {
    const r = await fetch(AUTOCOMPLETE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
      },
      body: JSON.stringify({
        input,
        sessionToken,
        // Note: we don't constrain by includedPrimaryTypes — Google's
        // autocomplete is best when allowed to match anything the user
        // typed, and we filter venue-eligible types on the details side
        // anyway. A previous version of this function limited to
        // ["restaurant", "bar", "cafe", "bakery", "night_club"] which
        // dropped valid Mexican venues whose primary type didn't match
        // Google's English-centric taxonomy (e.g. "La Bocana" → typed
        // as `food` only, no autocomplete results).
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      const code = classifyGoogleError(r.status, text);
      return jsonResponse({
        ok: false,
        code,
        error: friendlyGoogleError(code, r.status, text),
        httpStatus: r.status,
      });
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
      .map((p) => ({
        placeId: p.placeId,
        mainText: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
        secondaryText: p.structuredFormat?.secondaryText?.text ?? "",
      }))
      .filter((p) => p.placeId && p.mainText);

    return jsonResponse({ ok: true, predictions, mock: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonResponse({
      ok: false,
      code: "network_error",
      error: `Couldn't reach Google: ${message}`,
    });
  }
});

// Map a raw Google status + body into a small enum the client can branch on
// if it cares. Mostly here so we can tell "key restriction" apart from
// "service down".
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
  // Always 200 on the wire — see top-of-file comment.
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
