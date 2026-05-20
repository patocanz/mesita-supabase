// Supabase Edge Function — admin-search-places
//
// Runs many Google Places Text Search queries in one batch and returns
// the union of Place IDs across all of them. Paginates each query up to
// the API max (3 pages × 20 = 60 results) and runs queries with bounded
// concurrency so a 50-query batch completes well inside the EF timeout.
//
// Admin auth: `x-admin-key` header must equal the `ADMIN_ACCESS_KEY`
// Supabase secret. There is no JWT — the admin app stores the key in an
// HttpOnly cookie and forwards it server-side via a Next.js route. JWT
// verification is therefore disabled on this function in config.toml.
//
// Google key: `GOOGLE_MAPS_PLATFORM_SUPABASE_API_KEY` (same secret used
// by manager-suggest-places / manager-get-place). The key never leaves
// Supabase — clients call this EF, this EF calls Google.
//
// Wire status is always 200 with a `{ ok, ... }` body — same shape as the
// other Places proxies. supabase-js's invoke helper swallows non-2xx
// bodies, so meaningful errors travel in the body, not the HTTP status.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

// Per-query pagination cap. Google Places Text Search v1 returns up to
// 20 results per page and exposes at most ~60 results (3 pages) per
// query — anything beyond that requires query refinement, not deeper
// pagination.
const PAGE_SIZE = 20;
const MAX_PAGES = 3;
const MAX_RESULTS_PER_QUERY = PAGE_SIZE * MAX_PAGES; // 60

// Batch cap. With concurrency 10 and ~3 pages × ~500ms per query, 200
// queries land in roughly 30 seconds — comfortably inside the EF
// timeout while still meaningful for an operator pasting a large list
// of "cuisine × city" combinations.
const MAX_QUERIES_PER_BATCH = 200;
const CONCURRENCY = 10;

type RequestBody = {
  queries?: string[];
  regionCode?: string;
  maxResultsPerQuery?: number;
};

type PlaceLite = {
  id: string;
  displayName: string;
  formattedAddress: string;
  lat: number | null;
  lng: number | null;
  // Mesita-side enrichment populated after the Google round-trip, by
  // looking each Place ID up against public.venues.google_place_id.
  // Defaults to (false, null, null) and stays that way if the lookup
  // can't run (missing service-role secret, DB timeout, etc.) — the
  // top-level mesitaLookupError signals that case to the caller.
  existsInMesita: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type QueryResult = {
  query: string;
  places: PlaceLite[];
  truncated: boolean;
  error: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" });
  }

  // --- Auth: admin key ---
  const expectedAdminKey = Deno.env.get("ADMIN_ACCESS_KEY");
  if (!expectedAdminKey) {
    return json({
      ok: false,
      code: "server_missing_admin_key",
      error:
        "Mesita backend isn't configured for admin actions. Tell support — they need to set ADMIN_ACCESS_KEY.",
    });
  }
  const providedAdminKey = req.headers.get("x-admin-key") ?? "";
  if (providedAdminKey !== expectedAdminKey) {
    return json({ ok: false, code: "unauthorized", error: "Unauthorized" });
  }

  // --- Google key ---
  const googleKey = Deno.env.get("GOOGLE_MAPS_PLATFORM_SUPABASE_API_KEY");
  if (!googleKey) {
    return json({
      ok: false,
      code: "server_missing_google_key",
      error:
        "Mesita backend isn't configured for Google Places. Tell support — they need to set GOOGLE_MAPS_PLATFORM_SUPABASE_API_KEY.",
    });
  }

  // --- Parse body ---
  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON" });
  }

  const queries = Array.from(
    new Set(
      (body.queries ?? [])
        .map((q) => (typeof q === "string" ? q.trim() : ""))
        .filter((q) => q.length > 0),
    ),
  );
  if (queries.length === 0) {
    return json({ ok: false, error: "queries: empty" });
  }
  if (queries.length > MAX_QUERIES_PER_BATCH) {
    return json({
      ok: false,
      error: `queries: max ${MAX_QUERIES_PER_BATCH} per batch (got ${queries.length})`,
    });
  }

  const regionCode = ((body.regionCode ?? "MX") || "MX").toUpperCase();
  const maxResults = Math.min(
    MAX_RESULTS_PER_QUERY,
    Math.max(1, body.maxResultsPerQuery ?? MAX_RESULTS_PER_QUERY),
  );

  // --- Run queries with bounded concurrency ---
  const results = new Array<QueryResult>(queries.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= queries.length) return;
      const q = queries[i];
      try {
        const places = await searchTextWithPagination(
          q,
          regionCode,
          maxResults,
          googleKey,
        );
        results[i] = {
          query: q,
          places,
          truncated: places.length >= maxResults,
          error: null,
        };
      } catch (err) {
        results[i] = {
          query: q,
          places: [],
          truncated: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queries.length) }, () =>
      worker(),
    ),
  );

  // --- Dedupe ---
  const seen = new Set<string>();
  const uniquePlaces: PlaceLite[] = [];
  for (const r of results) {
    for (const p of r.places) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        uniquePlaces.push(p);
      }
    }
  }

  // --- Enrich with Mesita existence + timestamps ---
  //
  // Bulk SELECT against public.venues, keyed by google_place_id. The
  // column carries a UNIQUE constraint so the lookup is index-backed.
  // Failures here don't fail the whole request — Google results stand
  // alone — they just travel back as `mesitaLookupError` so the UI can
  // warn. The dedupe above only kept the first PlaceLite per id in
  // uniquePlaces, but the same id may appear in multiple queries'
  // .places arrays as separate objects, so we apply the enrichment by
  // walking every reference instead of relying on object identity.
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  let mesitaLookupError: string | null = null;
  let mesitaMatchCount = 0;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    mesitaLookupError =
      "Supabase service-role secrets aren't set — couldn't check which places are already in Mesita.";
  } else if (uniquePlaces.length > 0) {
    try {
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const ids = uniquePlaces.map((p) => p.id);
      const { data, error } = await admin
        .from("venues")
        .select("google_place_id, created_at, updated_at")
        .in("google_place_id", ids);
      if (error) {
        mesitaLookupError = `Mesita lookup failed: ${error.message}`;
      } else {
        const byId = new Map<
          string,
          { created_at: string; updated_at: string }
        >();
        for (const row of data ?? []) {
          if (row.google_place_id) {
            byId.set(row.google_place_id, {
              created_at: row.created_at,
              updated_at: row.updated_at,
            });
          }
        }
        const applyEnrichment = (p: PlaceLite) => {
          const hit = byId.get(p.id);
          if (!hit) return;
          p.existsInMesita = true;
          p.createdAt = hit.created_at;
          p.updatedAt = hit.updated_at;
        };
        for (const p of uniquePlaces) applyEnrichment(p);
        for (const r of results) for (const p of r.places) applyEnrichment(p);
        mesitaMatchCount = byId.size;
      }
    } catch (err) {
      mesitaLookupError =
        err instanceof Error
          ? `Mesita lookup threw: ${err.message}`
          : `Mesita lookup threw: ${String(err)}`;
    }
  }

  return json({
    ok: true,
    queries: results,
    uniquePlaces,
    uniqueCount: uniquePlaces.length,
    regionCode,
    maxResultsPerQuery: maxResults,
    mesitaMatchCount,
    mesitaLookupError,
  });
});

async function searchTextWithPagination(
  textQuery: string,
  regionCode: string,
  maxResults: number,
  apiKey: string,
): Promise<PlaceLite[]> {
  const out: PlaceLite[] = [];
  let pageToken: string | undefined;
  let pagesFetched = 0;
  const wantedPages = Math.ceil(maxResults / PAGE_SIZE);

  while (pagesFetched < wantedPages && out.length < maxResults) {
    const body: Record<string, unknown> = {
      textQuery,
      pageSize: Math.min(PAGE_SIZE, maxResults - out.length),
    };
    if (regionCode) body.regionCode = regionCode;
    if (pageToken) body.pageToken = pageToken;

    const r = await fetch(TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,nextPageToken",
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const text = await r.text();
      throw new Error(googleErrorMessage(r.status, text));
    }

    const data = (await r.json()) as {
      places?: Array<{
        id?: string;
        displayName?: { text?: string };
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
      }>;
      nextPageToken?: string;
    };

    for (const p of data.places ?? []) {
      if (!p.id) continue;
      out.push({
        id: p.id,
        displayName: p.displayName?.text ?? "",
        formattedAddress: p.formattedAddress ?? "",
        lat:
          typeof p.location?.latitude === "number" ? p.location.latitude : null,
        lng:
          typeof p.location?.longitude === "number"
            ? p.location.longitude
            : null,
        existsInMesita: false,
        createdAt: null,
        updatedAt: null,
      });
      if (out.length >= maxResults) break;
    }

    pageToken = data.nextPageToken;
    pagesFetched++;
    if (!pageToken) break;
  }

  return out;
}

function googleErrorMessage(status: number, body: string): string {
  const snippet = body.slice(0, 200);
  if (status === 403) {
    if (/referer|referrer/i.test(body)) {
      return "Google rejected server-to-server call (referrer restriction on the API key). Remove the HTTP-referrer restriction on the Mesita backend key.";
    }
    if (/api.+disabled|not.+enabled/i.test(body)) {
      return "Google Places API (New) is not enabled on the configured key.";
    }
    if (/quota|exceeded/i.test(body)) {
      return "Google Places quota exceeded for today.";
    }
    return `Google denied request: ${snippet}`;
  }
  if (status === 400) return `Google rejected query: ${snippet}`;
  if (status === 429) return "Google rate-limited the request — try again with fewer queries or wait a few seconds.";
  if (status >= 500) return "Google Places is unavailable right now (5xx).";
  return `Google ${status}: ${snippet}`;
}
