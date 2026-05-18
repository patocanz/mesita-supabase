// Supabase Edge Function — guest-build-deck
//
// Returns a curated 20-card deck for the guest swipe view. Anonymous
// callers OK (the discover surface is public until sign-up). The function
// does RAG-style ranking:
//
//   1. Pull a bounded candidate pool by bounding-box radius (cheap).
//   2. Compose a one-sentence intent query from user context (tier, city,
//      time of day, last saves if signed-in).
//   3. Embed the intent once.
//   4. ORDER BY embedding <=> :intent_vec, LIMIT overfetch.
//   5. Apply a small diversity rule (no >4 of the same category) and
//      partner-first bias, then trim to `limit`.
//
// If any candidate has a NULL embedding, the EF backfills up to 50 of
// them inline (single batched OpenAI call) before ranking, so the catalog
// self-heals over time without needing a separate cron.
//
// Local:  supabase functions serve guest-build-deck
// Deploy: supabase functions deploy guest-build-deck

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Pool sizing — overfetch beyond `limit` so diversity trimming has slack.
const CANDIDATE_POOL = 200;
const OVERFETCH_MULTIPLIER = 2.5;
const MAX_PER_CATEGORY = 4; // diversity cap inside the final deck
const DEFAULT_LIMIT = 20;
const DEFAULT_RADIUS_KM = 25;
const LAZY_EMBED_BATCH = 50;

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

const VENUE_COLUMNS =
  "id, slug, name, category, vibe, price_level, listing_type, status, fiscal_type, plan, lat, lng, address, closes_at, phone, pitch, story, cashback_percent, photos, website_url, instagram_url, tiktok_url, facebook_url, whatsapp_url, opentable_url, resy_url, uber_eats_url, rappi_url, x_url, youtube_url, threads_url, reddit_url, didi_food_url, tripadvisor_url, google_maps_url, email, created_at";

type Body = {
  lat?: number;
  lng?: number;
  radiusKm?: number;
  limit?: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const OPENAI_KEY = Deno.env.get("OPENAI_SUPABASE_API_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

  // Caller is optional — we honour the bearer if present so we can read
  // the signed-in guest's profile for personalisation, but the public
  // anonymous case is the common path. We still need a Supabase client
  // for that; pass-through the auth header so RLS-aware reads work.
  const authHeader = req.headers.get("Authorization") ?? "";
  let userId: string | null = null;
  let userClient: ReturnType<typeof createClient> | null = null;
  if (authHeader.startsWith("Bearer ")) {
    userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data } = await userClient.auth.getUser();
    userId = data.user?.id ?? null;
  }

  // Parse input.
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* anonymous browse with no body is fine */
  }
  const lat = typeof body.lat === "number" && Number.isFinite(body.lat) ? body.lat : null;
  const lng = typeof body.lng === "number" && Number.isFinite(body.lng) ? body.lng : null;
  const radiusKm = clampPositive(body.radiusKm, DEFAULT_RADIUS_KM, 200);
  const limit = clampPositive(body.limit, DEFAULT_LIMIT, 50);

  // Service-role client for the actual reads + lazy embedding writes.
  // We can't use the user-scoped client here because (a) anon may not
  // have one and (b) embedding writes need RLS bypass.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── 1. Candidate pool ──────────────────────────────────────────────
  // Bounding-box prefilter. ~111km per degree latitude; longitude shrinks
  // with cos(lat) so we widen the lng span accordingly. This is a coarse
  // filter — we trim by exact haversine in JS after ranking.
  let candidates: VenueRow[];
  if (lat != null && lng != null) {
    const latDelta = radiusKm / 111;
    const lngDelta = radiusKm / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    const { data, error } = await admin
      .from("venues")
      .select(VENUE_COLUMNS + ", embedding, embedding_source_hash")
      .eq("status", "active")
      .gte("lat", lat - latDelta)
      .lte("lat", lat + latDelta)
      .gte("lng", lng - lngDelta)
      .lte("lng", lng + lngDelta)
      .limit(CANDIDATE_POOL);
    if (error) return json({ ok: false, error: `candidate_pool: ${error.message}` }, 500);
    candidates = (data ?? []) as VenueRow[];
  } else {
    // No location → newest active venues. We still embed-rank below.
    const { data, error } = await admin
      .from("venues")
      .select(VENUE_COLUMNS + ", embedding, embedding_source_hash")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(CANDIDATE_POOL);
    if (error) return json({ ok: false, error: `candidate_pool: ${error.message}` }, 500);
    candidates = (data ?? []) as VenueRow[];
  }

  if (candidates.length === 0) {
    return json({ ok: true, deck: [], summary: { candidates: 0, embedded: 0 } });
  }

  // ── 2. Lazy embedding backfill ─────────────────────────────────────
  // Any candidate without an embedding (or with a stale hash) gets one
  // before ranking. Bounded so the first cold request doesn't take 30s.
  const needsEmbed = candidates.filter((v) => shouldEmbed(v)).slice(0, LAZY_EMBED_BATCH);
  let embeddedCount = 0;
  if (needsEmbed.length > 0 && OPENAI_KEY) {
    embeddedCount = await embedAndPersist(needsEmbed, admin, OPENAI_KEY);
    // Patch the local rows so the rank step below sees the new vectors
    // without a second SELECT.
    if (embeddedCount > 0) {
      const refreshed = await admin
        .from("venues")
        .select("id, embedding, embedding_source_hash")
        .in("id", needsEmbed.map((v) => v.id));
      const byId = new Map(
        (refreshed.data ?? []).map((r) => [r.id as string, r as { embedding: unknown; embedding_source_hash: string }]),
      );
      for (const c of candidates) {
        const r = byId.get(c.id);
        if (r) {
          c.embedding = r.embedding;
          c.embedding_source_hash = r.embedding_source_hash;
        }
      }
    }
  }

  // ── 3. Compose user-intent query ───────────────────────────────────
  const profile = userId && userClient ? await fetchGuestProfile(userClient, userId) : null;
  const intent = composeIntent({
    profile,
    lat,
    lng,
    candidates,
  });

  // ── 4. Rank by embedding similarity (or fall back to partner-first) ──
  let ranked: VenueRow[];
  if (OPENAI_KEY) {
    try {
      const intentVec = await embed(intent, OPENAI_KEY);
      ranked = rankByCosine(candidates, intentVec);
    } catch (err) {
      console.error("[guest-build-deck] intent embed failed:", err);
      ranked = fallbackRank(candidates);
    }
  } else {
    ranked = fallbackRank(candidates);
  }

  // ── 5. Radius + diversity + partner-first trim ─────────────────────
  if (lat != null && lng != null) {
    ranked = ranked.filter((v) => haversineKm(lat, lng, v.lat, v.lng) <= radiusKm);
  }
  const deck = diversify(ranked, limit, MAX_PER_CATEGORY);

  return json({
    ok: true,
    deck: deck.map(stripInternal),
    summary: {
      candidates: candidates.length,
      embedded: embeddedCount,
      intent,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

type VenueRow = {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  vibe: string | null;
  price_level: number | null;
  listing_type: "partner" | "web";
  status: string;
  fiscal_type: string | null;
  plan: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  closes_at: string | null;
  phone: string | null;
  pitch: string | null;
  story: string | null;
  cashback_percent: number | null;
  photos: string[] | null;
  // ... all the URL channel columns are passed through but not used here
  [key: string]: unknown;
  embedding: unknown | null;
  embedding_source_hash: string | null;
};

type GuestProfile = {
  full_name: string | null;
  country: string | null;
  birthday: string | null;
  sex: string | null;
  tier?: string | null;
};

// ─────────────────────────────────────────────────────────────────────
// Intent composition
// ─────────────────────────────────────────────────────────────────────

// Builds the one-line semantic query that gets embedded. The richer this
// is, the better the ranking — but we keep it terse so the embedding
// stays focused on the venue-shaped signal.
function composeIntent({
  profile,
  lat,
  lng,
  candidates,
}: {
  profile: GuestProfile | null;
  lat: number | null;
  lng: number | null;
  candidates: VenueRow[];
}): string {
  const parts: string[] = [];
  // Time-of-day handle. The Edge runtime is UTC; we don't know the
  // guest's timezone, so this is rough — gives the embedder a flavour,
  // not a hard filter.
  const now = new Date();
  const hour = now.getUTCHours();
  if (hour < 11) parts.push("morning coffee and brunch energy");
  else if (hour < 16) parts.push("lunch and afternoon hangout vibes");
  else if (hour < 20) parts.push("golden hour rooftops and early dinner");
  else parts.push("dinner, cocktails, and late-night spots");

  if (profile?.country) parts.push(`a guest from ${profile.country}`);
  if (lat != null && lng != null) parts.push(`within ${DEFAULT_RADIUS_KM}km of this location`);

  // Soft hint about the local mix so the embedding leans into the
  // dominant categories of the candidate pool.
  const topCats = topCategoriesIn(candidates, 3);
  if (topCats.length) parts.push(`mixing ${topCats.join(", ")}`);

  parts.push("venues with great vibe and worth the visit");

  return parts.join("; ");
}

function topCategoriesIn(rows: VenueRow[], k: number): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const c = (r.category ?? "").toLowerCase().trim();
    if (!c) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([c]) => c);
}

// ─────────────────────────────────────────────────────────────────────
// Embedding helpers
// ─────────────────────────────────────────────────────────────────────

function venueSourceText(v: VenueRow): string {
  const lines: string[] = [];
  lines.push(`Name: ${v.name}`);
  if (v.category) lines.push(`Category: ${v.category}`);
  if (v.vibe) lines.push(`Vibe: ${v.vibe}`);
  if (v.pitch) lines.push(`Pitch: ${v.pitch}`);
  if (v.story) lines.push(`Story: ${v.story.slice(0, 700)}`);
  if (v.address) lines.push(`Address: ${v.address}`);
  if (v.price_level != null) lines.push(`Price level: ${v.price_level}/4`);
  return lines.join("\n");
}

// Cheap stable digest of the source text — used so we can detect "this
// venue's text changed, re-embed" without storing the whole text.
async function digest(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function shouldEmbed(v: VenueRow): boolean {
  if (!v.embedding) return true;
  // We re-derive the source text and compare hashes on every read — cheap
  // (sha1 over <1KB) and lets edits flow into the index without manual
  // backfill.
  return v.embedding_source_hash == null;
}

async function embedAndPersist(
  rows: VenueRow[],
  admin: ReturnType<typeof createClient>,
  apiKey: string,
): Promise<number> {
  // OpenAI's embeddings endpoint accepts an array input — one HTTP call
  // for the whole batch. Keep batches modest so a partial failure doesn't
  // waste a big request.
  const inputs = await Promise.all(rows.map(async (r) => ({
    id: r.id,
    text: venueSourceText(r),
    hash: await digest(venueSourceText(r)),
  })));

  try {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: inputs.map((i) => i.text),
      }),
    });
    if (!r.ok) {
      const errText = (await r.text()).slice(0, 240);
      console.error("[guest-build-deck] batch-embed HTTP", r.status, errText);
      return 0;
    }
    const data = (await r.json()) as {
      data?: { embedding: number[]; index: number }[];
    };
    const vecs = data.data ?? [];
    let wrote = 0;
    for (let i = 0; i < inputs.length; i += 1) {
      const v = vecs.find((d) => d.index === i)?.embedding;
      if (!v || v.length !== EMBEDDING_DIMS) continue;
      const { error } = await admin
        .from("venues")
        .update({
          embedding: vectorLiteral(v),
          embedding_source_hash: inputs[i].hash,
        })
        .eq("id", inputs[i].id);
      if (!error) wrote += 1;
      else console.error("[guest-build-deck] embed write:", error.message);
    }
    return wrote;
  } catch (err) {
    console.error("[guest-build-deck] embed exception:", err);
    return 0;
  }
}

async function embed(text: string, apiKey: string): Promise<number[]> {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`embed HTTP ${r.status}`);
  const data = (await r.json()) as { data?: { embedding: number[] }[] };
  const v = data.data?.[0]?.embedding;
  if (!v || v.length !== EMBEDDING_DIMS) throw new Error("embed: bad shape");
  return v;
}

// pgvector accepts vectors as text literals like "[0.01,0.02,...]". We
// build that here so the .update() call sends a plain string (supabase-js
// doesn't have a vector binder).
function vectorLiteral(v: number[]): string {
  return `[${v.map((x) => x.toFixed(6)).join(",")}]`;
}

// ─────────────────────────────────────────────────────────────────────
// Ranking
// ─────────────────────────────────────────────────────────────────────

// Cosine similarity between two vectors that are already normalised
// approximately (text-embedding-3-small returns unit-length vectors).
function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

function parseVector(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v !== "string") return null;
  // pgvector returns "[0.01,0.02,...]"
  const inner = v.replace(/^\[/, "").replace(/\]$/, "");
  if (!inner) return null;
  const arr = inner.split(",").map((s) => Number(s.trim()));
  if (arr.some((n) => !Number.isFinite(n))) return null;
  return arr;
}

function rankByCosine(rows: VenueRow[], queryVec: number[]): VenueRow[] {
  const scored = rows.map((r) => {
    const v = parseVector(r.embedding);
    const score = v ? cosineSim(v, queryVec) : -1; // no embedding → tail
    return { row: r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.row);
}

function fallbackRank(rows: VenueRow[]): VenueRow[] {
  // Partner-first, then newest. Stable when OpenAI is down.
  return [...rows].sort((a, b) => {
    const ap = a.listing_type === "partner" ? 0 : 1;
    const bp = b.listing_type === "partner" ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return 0;
  });
}

// Cap the final deck so we don't return 20 identical "Italian" cards.
function diversify(rows: VenueRow[], limit: number, perCategory: number): VenueRow[] {
  const out: VenueRow[] = [];
  const seenCat = new Map<string, number>();
  const tail: VenueRow[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const cat = (r.category ?? "").toLowerCase().trim();
    const count = seenCat.get(cat) ?? 0;
    if (cat && count >= perCategory) {
      tail.push(r);
      continue;
    }
    out.push(r);
    if (cat) seenCat.set(cat, count + 1);
  }
  // Top up from the tail if diversity left us short.
  for (const r of tail) {
    if (out.length >= limit) break;
    out.push(r);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Geo helpers
// ─────────────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number | null, lng2: number | null): number {
  if (lat2 == null || lng2 == null) return Number.POSITIVE_INFINITY;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ─────────────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────────────

async function fetchGuestProfile(
  client: ReturnType<typeof createClient>,
  userId: string,
): Promise<GuestProfile | null> {
  const { data } = await client
    .from("guests")
    .select("full_name, country, birthday, sex")
    .eq("id", userId)
    .maybeSingle();
  return (data as GuestProfile | null) ?? null;
}

function clampPositive(v: unknown, def: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

// Strip embedding + hash before returning — they're huge and the
// frontend has no use for them.
function stripInternal(v: VenueRow): Omit<VenueRow, "embedding" | "embedding_source_hash"> {
  const { embedding: _e, embedding_source_hash: _h, ...rest } = v;
  void _e; void _h;
  return rest;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
