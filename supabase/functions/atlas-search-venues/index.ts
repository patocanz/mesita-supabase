// Supabase Edge Function — atlas-search-venues (artificial caller)
//
// Part of the Atlas namespace (venue intelligence + encyclopaedia).
// Runs many Google Places Text Search queries in one batch and returns
// the union of Place IDs across all of them. Paginates each query up to
// the API max (3 pages × 20 = 60 results) and runs queries with bounded
// concurrency so a 50-query batch completes well inside the EF timeout.
//
// Returned places are enriched with Mesita-side existence + timestamps so
// the natural caller can render "already on Mesita" badges without a
// second round-trip.
//
// Auth: artificial caller — verify_jwt = false at the gateway; the EF
// itself enforces the service-role bearer via requireInternalCaller.
//
// Deploy: supabase functions deploy atlas-search-venues

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import {
  GOOGLE_PLACES_TEXT_SEARCH_URL,
  googleErrorFromResponse,
  readGooglePlacesKey,
} from "../_shared/google-places.ts";

const PAGE_SIZE = 20;
const MAX_PAGES = 3;
const MAX_RESULTS_PER_QUERY = PAGE_SIZE * MAX_PAGES; // 60

// Batch cap. With concurrency 10 and ~3 pages × ~500ms per query, 200
// queries land in roughly 30 seconds — comfortably inside the EF timeout
// while still meaningful for an operator pasting a large list of
// "cuisine × city" combinations.
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
  // Mesita-side enrichment, populated after the Google round-trip by
  // looking each Place ID up against public.venues.google_place_id.
  // Defaults to (false, null, null); the top-level mesitaLookupError
  // signals when the lookup couldn't run.
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
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" });

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  const callerRes = requireInternalCaller(req, env);
  if (!callerRes.ok) return callerRes.response;

  const keyRes = readGooglePlacesKey();
  if (!keyRes.ok) return keyRes.response;
  const apiKey = keyRes.key;

  const admin = adminClient(env);

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
        const places = await searchTextWithPagination(q, regionCode, maxResults, apiKey);
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
    Array.from({ length: Math.min(CONCURRENCY, queries.length) }, () => worker()),
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
  let mesitaLookupError: string | null = null;
  let mesitaMatchCount = 0;
  if (uniquePlaces.length > 0) {
    try {
      const ids = uniquePlaces.map((p) => p.id);
      const { data, error } = await admin
        .from("venues")
        .select("google_place_id, created_at, updated_at")
        .in("google_place_id", ids);
      if (error) {
        mesitaLookupError = `Mesita lookup failed: ${error.message}`;
      } else {
        const byId = new Map<string, { created_at: string; updated_at: string }>();
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
    caller: callerRes.callerName,
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

    const r = await fetch(GOOGLE_PLACES_TEXT_SEARCH_URL, {
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
      throw await googleErrorFromResponse(r);
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
        lat: typeof p.location?.latitude === "number" ? p.location.latitude : null,
        lng: typeof p.location?.longitude === "number" ? p.location.longitude : null,
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
