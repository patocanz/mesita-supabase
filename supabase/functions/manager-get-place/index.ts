// Supabase Edge Function — manager-get-place
//
// Fetches a full Google Place by id. Field-mask is intentionally tight to
// keep the per-call cost down; anything extra we want from Google should be
// added here, not on the client.
//
// JWT-protected: clients must send the Supabase anon JWT in `Authorization`.
// Reads the Google key from the secret `GOOGLE_MAPS_PLATFORM_SUPABASE_API_KEY`.
// (See manager-suggest-places for the naming convention.)
//
// Local:  supabase functions serve manager-get-place
// Deploy: supabase functions deploy manager-get-place

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";

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

// See manager-suggest-places for the rationale: this function always returns
// HTTP 200, even on Google failures. supabase-js's `functions.invoke`
// swallows the response body on non-2xx, so we keep the wire status at 200
// and rely on the `{ ok, error }` shape so the real Google error reaches
// the client.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" });
  }

  const apiKey = Deno.env.get("GOOGLE_MAPS_PLATFORM_SUPABASE_API_KEY");
  if (!apiKey) {
    return json({
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
    return json({ ok: false, error: "Invalid JSON" });
  }

  const placeId = (body.placeId ?? "").toString();
  const sessionToken = (body.sessionToken ?? "").toString();
  if (!placeId) {
    return json({ ok: false, error: "Missing placeId" });
  }
  if (!sessionToken) {
    return json({ ok: false, error: "Missing sessionToken" });
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
      const code = classifyGoogleError(r.status, text);
      return json({
        ok: false,
        code,
        error: friendlyGoogleError(code, r.status, text),
        httpStatus: r.status,
      });
    }

    const data = (await r.json()) as GoogleDetails;
    return json({
      ok: true,
      details: normalise(placeId, data),
      mock: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return json({
      ok: false,
      code: "network_error",
      error: `Couldn't reach Google: ${message}`,
    });
  }
});

function classifyGoogleError(status: number, body: string): string {
  if (status === 403) {
    if (/referer|referrer/i.test(body)) return "google_referrer_blocked";
    if (/api.+disabled|not.+enabled/i.test(body)) return "google_api_disabled";
    if (/quota|exceeded/i.test(body)) return "google_quota_exceeded";
    return "google_permission_denied";
  }
  if (status === 400) return "google_bad_request";
  if (status === 404) return "google_not_found";
  if (status === 429) return "google_rate_limited";
  if (status >= 500) return "google_unavailable";
  return "google_error";
}

function friendlyGoogleError(code: string, status: number, body: string): string {
  switch (code) {
    case "google_referrer_blocked":
      return "Google rejected the request — the API key has a referrer / IP restriction blocking server-to-server calls. Remove the HTTP-referrer restriction on the Mesita backend key.";
    case "google_api_disabled":
      return "Google Places API (New) isn't enabled on the configured key. Enable it in Google Cloud → APIs & Services.";
    case "google_quota_exceeded":
      return "The Google Places quota for today is exhausted. Try again later or raise the daily cap.";
    case "google_permission_denied":
      return "Google denied the request (permission). Check the API key + billing.";
    case "google_bad_request":
      return `Google rejected the lookup: ${body.slice(0, 200)}`;
    case "google_not_found":
      return "Google can't find that venue anymore — pick a different result.";
    case "google_rate_limited":
      return "Too many lookups in a short window. Wait a few seconds and try again.";
    case "google_unavailable":
      return "Google Places is unavailable right now (5xx). Try again in a moment.";
    default:
      return `Google ${status}: ${body.slice(0, 200)}`;
  }
}

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

