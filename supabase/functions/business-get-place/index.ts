// Supabase Edge Function — business-get-place
//
// Fetches a full Google Place by id. Field-mask is intentionally tight to
// keep the per-call cost down; anything extra we want from Google should be
// added here, not on the client.
//
// JWT-protected: clients must send the Supabase anon JWT in `Authorization`.
// Reads the Google key from the secret `SUPA_GMP_KEY`.
// (See business-suggest-places for the naming convention.)
//
// Local:  supabase functions serve business-get-place
// Deploy: supabase functions deploy business-get-place

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  classifyGoogleError,
  friendlyGoogleError,
  GOOGLE_PLACES_DETAILS_BASE,
  readGooglePlacesKey,
} from "../_shared/google-places.ts";

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

// See business-suggest-places for the rationale: this function always returns
// HTTP 200, even on Google failures. supabase-js's `functions.invoke`
// swallows the response body on non-2xx, so we keep the wire status at 200
// and rely on the `{ ok, error }` shape so the real Google error reaches
// the client.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" });
  }

  const keyRes = readGooglePlacesKey();
  if (!keyRes.ok) return keyRes.response;
  const apiKey = keyRes.key;

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
    const url = new URL(`${GOOGLE_PLACES_DETAILS_BASE}/${encodeURIComponent(placeId)}`);
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

