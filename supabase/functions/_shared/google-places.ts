// Shared helpers for Google Places API (New) calls. Every Mesita EF that
// hits Google Places does the same three things — read the SUPA_GMP_KEY
// secret, classify the response body into an error code, and translate
// that code into operator-friendly copy. Keeping them in one place means
// a new error case (a deprecation, a billing change) gets handled once.
//
// The actual endpoint calls (Autocomplete, Text Search, Place Details)
// live in the artificial-caller `places-*` EFs that import from here.

import { json } from "./http.ts";

const GOOGLE_PLACES_KEY_ENV = "SUPA_GMP_KEY";

// Restrict Google autocomplete + text-search to F&B / nightlife primary
// types so non-hospitality matches (tire shops, mechanics, pharmacies,
// hardware stores…) don't pollute the picker. Google caps this at 5 from
// Table A; we pick the broadest 5 that cover Mesita's universe. Trade-off:
// cuisine-specific Table A types (italian_restaurant, mexican_restaurant,
// sushi_restaurant, …) get filtered out because each place has exactly one
// primary type. The Mesita-side ILIKE fallback in atlas-suggest-venue
// still surfaces them once they've been onboarded.
export const MESITA_PRIMARY_TYPES = [
  "restaurant",
  "bar",
  "cafe",
  "night_club",
  "bakery",
];

// Endpoint URLs for the three Places (New) surfaces we use.
export const GOOGLE_PLACES_AUTOCOMPLETE_URL =
  "https://places.googleapis.com/v1/places:autocomplete";
export const GOOGLE_PLACES_TEXT_SEARCH_URL =
  "https://places.googleapis.com/v1/places:searchText";
export const GOOGLE_PLACES_DETAILS_BASE =
  "https://places.googleapis.com/v1/places";

type GoogleErrorCode =
  | "google_referrer_blocked"
  | "google_api_disabled"
  | "google_quota_exceeded"
  | "google_permission_denied"
  | "google_bad_request"
  | "google_not_found"
  | "google_rate_limited"
  | "google_unavailable"
  | "google_error";

// Reads SUPA_GMP_KEY, returning a typed error envelope when missing so the
// EF can early-return. Wire status is always 200 — supabase-js's invoke
// helper swallows non-2xx bodies and surfaces a generic message, hiding
// the real problem from operators.
export function readGooglePlacesKey():
  | { ok: true; key: string }
  | { ok: false; response: Response } {
  const key = Deno.env.get(GOOGLE_PLACES_KEY_ENV);
  if (!key) {
    return {
      ok: false,
      response: json({
        ok: false,
        code: "server_missing_key",
        error:
          "Mesita backend isn't configured for Google Places. Tell support — they need to set SUPA_GMP_KEY.",
      }),
    };
  }
  return { ok: true, key };
}

export function classifyGoogleError(status: number, body: string): GoogleErrorCode {
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

export function friendlyGoogleError(
  code: GoogleErrorCode,
  status: number,
  body: string,
): string {
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
      return `Google rejected the request: ${body.slice(0, 200)}`;
    case "google_not_found":
      return "Google can't find that venue anymore — pick a different result.";
    case "google_rate_limited":
      return "Too many requests in a short window. Wait a few seconds and try again.";
    case "google_unavailable":
      return "Google Places is unavailable right now (5xx). Try again in a moment.";
    default:
      return `Google ${status}: ${body.slice(0, 200)}`;
  }
}

// Throws an Error with the classified message — used by code paths that
// can't gracefully degrade per-call (e.g., admin-search-places' per-query
// worker, where one bad query shouldn't crash the batch but should be
// reported alongside the others).
export async function googleErrorFromResponse(r: Response): Promise<Error> {
  const text = await r.text();
  const code = classifyGoogleError(r.status, text);
  return new Error(friendlyGoogleError(code, r.status, text));
}

// % and _ are wildcards in ILIKE — escape so user input doesn't accidentally
// match everything. Lives here because every Places fallback EF needs it.
export function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
