// Supabase Edge Function — places-autocomplete
//
// Proxies Google Places API (New) Autocomplete so the Google key never
// leaves Supabase. The key is read from the secret `google_places_api_key`
// (set via Dashboard → Edge Functions → Secrets, or `supabase secrets set`).
//
// JWT-protected: clients must send the Supabase anon JWT in `Authorization`.
//
// Local:  supabase functions serve places-autocomplete
// Deploy: supabase functions deploy places-autocomplete

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
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const apiKey = Deno.env.get("google_places_api_key");
  if (!apiKey) {
    return jsonResponse(
      { ok: false, error: "Server missing google_places_api_key secret" },
      500,
    );
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
  }

  const input = (body.input ?? "").toString().trim();
  const sessionToken = (body.sessionToken ?? "").toString();

  if (input.length < 2) {
    return jsonResponse({ ok: true, predictions: [], mock: false });
  }
  if (!sessionToken) {
    return jsonResponse({ ok: false, error: "Missing sessionToken" }, 400);
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
        includedPrimaryTypes: [
          "restaurant",
          "bar",
          "cafe",
          "bakery",
          "night_club",
          "food",
        ],
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      return jsonResponse(
        { ok: false, error: `Google ${r.status}: ${text.slice(0, 240)}` },
        502,
      );
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
        mainText:
          p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
        secondaryText: p.structuredFormat?.secondaryText?.text ?? "",
      }))
      .filter((p) => p.placeId && p.mainText);

    return jsonResponse({ ok: true, predictions, mock: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonResponse({ ok: false, error: message }, 502);
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
