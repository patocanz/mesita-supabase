// Supabase Edge Function — atlas-suggest-venue (artificial caller)
//
// Part of the Atlas namespace (venue intelligence + encyclopaedia).
// Proxies Google Places (New) Autocomplete + a Mesita-side name ILIKE
// fallback in parallel, merges the two, and returns predictions tagged
// with per-row status (`not_in_mesita`, `web_listed`,
// `verified_partner_other`, `verified_partner_self`) so the UI can render
// the right badge.
//
// The Google key never leaves Supabase — natural-caller EFs (currently
// business-suggest-places, and any future consumer- or admin- surface)
// invoke this with the caller's user id and we own the rest.
//
// Auth: artificial caller — verify_jwt = false at the gateway; the EF
// itself enforces the service-role bearer via requireInternalCaller.
//
// Deploy: supabase functions deploy atlas-suggest-venue

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import {
  classifyGoogleError,
  escapeIlike,
  friendlyGoogleError,
  GOOGLE_PLACES_AUTOCOMPLETE_URL,
  MESITA_PRIMARY_TYPES,
  readGooglePlacesKey,
} from "../_shared/google-places.ts";

type Body = {
  input?: string;
  sessionToken?: string;
  // Caller-provided user id (the natural caller resolved this from the
  // end-user JWT). When null, we can't flag verified_partner_self — only
  // _other for any owned row.
  callerUserId?: string | null;
};

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
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  const callerRes = requireInternalCaller(req, env);
  if (!callerRes.ok) return callerRes.response;

  const keyRes = readGooglePlacesKey();
  if (!keyRes.ok) return keyRes.response;
  const apiKey = keyRes.key;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" });
  }
  const input = (body.input ?? "").toString().trim();
  const sessionToken = (body.sessionToken ?? "").toString();
  const callerUserId = body.callerUserId ?? null;

  if (input.length < 2) return json({ ok: true, predictions: [] });
  if (!sessionToken) return json({ ok: false, error: "Missing sessionToken" });

  const admin = adminClient(env);

  // Fire Google + Mesita searches in parallel. Either can fail
  // independently; we merge whatever comes back.
  const [googleResult, mesitaResult] = await Promise.allSettled([
    fetchGooglePredictions(input, sessionToken, apiKey),
    fetchMesitaPredictions(admin, input, callerUserId),
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
  if (googleResult.status === "fulfilled" && googleResult.value.errorEnvelope) {
    return json(googleResult.value.errorEnvelope);
  }

  const googlePreds = googleResult.status === "fulfilled" ? googleResult.value.predictions : [];
  const mesitaPreds = mesitaResult.status === "fulfilled" ? mesitaResult.value : [];

  // Merge: Mesita-side hits take precedence (status wins for matching
  // placeId), then any remaining Google entries follow. Google's
  // structured text is nicer, so we keep its mainText/secondaryText but
  // graft Mesita's status on top when the placeId is in both sources.
  const byPlaceId = new Map<string, Prediction>();
  for (const p of mesitaPreds) byPlaceId.set(p.placeId, p);
  for (const p of googlePreds) {
    const existing = byPlaceId.get(p.placeId);
    byPlaceId.set(p.placeId, existing ? { ...p, status: existing.status } : p);
  }

  // Backfill status for predictions Google returned but the ILIKE
  // fallback missed (e.g., "Strana San Pedro" vs the venue named just
  // "Strana"). Keys off placeId directly so the substring miss doesn't
  // matter.
  const orphanPlaceIds = Array.from(byPlaceId.values())
    .filter((p) => p.status === "not_in_mesita")
    .map((p) => p.placeId);
  if (orphanPlaceIds.length > 0) {
    const statusByPlaceId = await enrichByPlaceIds(admin, orphanPlaceIds, callerUserId);
    for (const [placeId, status] of statusByPlaceId) {
      const existing = byPlaceId.get(placeId);
      if (!existing) continue;
      byPlaceId.set(placeId, { ...existing, status });
    }
  }

  const predictions = Array.from(byPlaceId.values()).sort((a, b) => {
    const aIn = a.status !== "not_in_mesita";
    const bIn = b.status !== "not_in_mesita";
    return aIn === bIn ? 0 : aIn ? -1 : 1;
  });

  return json({ ok: true, predictions, caller: callerRes.callerName });
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
  const r = await fetch(GOOGLE_PLACES_AUTOCOMPLETE_URL, {
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
  // Strana, Monterrey". Limit small — Google is the primary surface; this
  // is a fallback for the long-tail case where Google misses.
  const { data, error } = await admin
    .from("venues")
    .select("id, google_place_id, name, address")
    .ilike("name", `%${escapeIlike(input)}%`)
    .not("google_place_id", "is", null)
    .limit(8);
  if (error) {
    console.error("[atlas-suggest-venue] mesita search:", error.message);
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
    console.error("[atlas-suggest-venue] placeId enrichment:", error.message);
    return new Map();
  }
  type Row = { id: string; google_place_id: string };
  return statusesForVenues(admin, (data ?? []) as Row[], callerId);
}

// One owner-lookup pass over a venue-row set, returning the per-placeId
// PredictionStatus. `web_listed` for unowned rows;
// `verified_partner_self/_other` for owned ones depending on whether the
// caller (resolved by the natural EF before this call) is the owner.
async function statusesForVenues(
  admin: ReturnType<typeof createClient>,
  rows: Array<{ id: string; google_place_id: string }>,
  callerId: string | null,
): Promise<Map<string, PredictionStatus>> {
  if (rows.length === 0) return new Map();
  const { data, error } = await admin
    .from("venue_members")
    .select("venue_id, business_id")
    .in("venue_id", rows.map((r) => r.id))
    .eq("role", "owner");
  if (error) {
    console.error("[atlas-suggest-venue] owner lookup:", error.message);
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
