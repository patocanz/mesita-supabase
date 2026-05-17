// Supabase Edge Function — places-details
//
// Fetches a full Google Place by id. Field-mask is intentionally tight to
// keep the per-call cost down; anything extra we want from Google should be
// added here, not on the client.
//
// JWT-protected: clients must send the Supabase anon JWT in `Authorization`.
// Reads the Google key from the secret `GOOGLE_MAPS_PLATFORM_API_KEY`.
//
// Local:  supabase functions serve places-details
// Deploy: supabase functions deploy places-details

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DETAILS_BASE = "https://places.googleapis.com/v1/places";

const FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "addressComponents",
  "location",
  "rating",
  "userRatingCount",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "websiteUri",
  "regularOpeningHours.weekdayDescriptions",
  "types",
  "primaryType",
  "priceLevel",
  "googleMapsUri",
].join(",");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type AddressComponent = { longText?: string; shortText?: string; types?: string[] };
type GoogleDetails = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: AddressComponent[];
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  types?: string[];
  primaryType?: string;
  priceLevel?: string;
  googleMapsUri?: string;
};

type Body = { placeId?: string; sessionToken?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const apiKey = Deno.env.get("GOOGLE_MAPS_PLATFORM_API_KEY");
  if (!apiKey) {
    return jsonResponse(
      { ok: false, error: "Server missing GOOGLE_MAPS_PLATFORM_API_KEY secret" },
      500,
    );
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
  }

  const placeId = (body.placeId ?? "").toString();
  const sessionToken = (body.sessionToken ?? "").toString();
  if (!placeId) {
    return jsonResponse({ ok: false, error: "Missing placeId" }, 400);
  }
  if (!sessionToken) {
    return jsonResponse({ ok: false, error: "Missing sessionToken" }, 400);
  }

  try {
    const url = new URL(`${DETAILS_BASE}/${encodeURIComponent(placeId)}`);
    url.searchParams.set("sessionToken", sessionToken);

    const r = await fetch(url.toString(), {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
    });

    if (!r.ok) {
      const text = await r.text();
      return jsonResponse(
        { ok: false, error: `Google ${r.status}: ${text.slice(0, 240)}` },
        502,
      );
    }

    const data = (await r.json()) as GoogleDetails;
    return jsonResponse({
      ok: true,
      details: normalise(placeId, data),
      mock: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonResponse({ ok: false, error: message }, 502);
  }
});

function normalise(placeId: string, d: GoogleDetails) {
  const find = (type: string) =>
    d.addressComponents?.find((c) => c.types?.includes(type))?.longText ?? null;
  return {
    placeId: d.id ?? placeId,
    name: d.displayName?.text ?? "",
    formattedAddress: d.formattedAddress ?? "",
    location:
      d.location?.latitude != null && d.location?.longitude != null
        ? { lat: d.location.latitude, lng: d.location.longitude }
        : null,
    rating: d.rating ?? null,
    userRatingsTotal: d.userRatingCount ?? null,
    phone: d.nationalPhoneNumber ?? d.internationalPhoneNumber ?? null,
    website: d.websiteUri ?? null,
    openingHours: d.regularOpeningHours?.weekdayDescriptions ?? [],
    types: d.types ?? [],
    primaryType: d.primaryType ?? null,
    priceLevel: priceLevelFromString(d.priceLevel),
    googleMapsUri: d.googleMapsUri ?? null,
    city: find("locality") ?? find("administrative_area_level_2"),
    neighborhood:
      find("neighborhood") ?? find("sublocality_level_1") ?? find("sublocality"),
    country: find("country"),
  };
}

function priceLevelFromString(p: string | undefined): 1 | 2 | 3 | 4 | null {
  switch (p) {
    case "PRICE_LEVEL_FREE":
    case "PRICE_LEVEL_INEXPENSIVE":
      return 1;
    case "PRICE_LEVEL_MODERATE":
      return 2;
    case "PRICE_LEVEL_EXPENSIVE":
      return 3;
    case "PRICE_LEVEL_VERY_EXPENSIVE":
      return 4;
    default:
      return null;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
