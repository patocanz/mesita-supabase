// Supabase Edge Function — consumer-recommend-deck
//
// Returns a curated 20-card deck for the consumer swipe view. Anonymous
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
// Local:  supabase functions serve consumer-recommend-deck
// Deploy: supabase functions deploy consumer-recommend-deck

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  embedAndPersistVenues,
  embedSingle,
  rankByCosine,
  shouldEmbed,
} from "../_shared/embeddings.ts";
import { fetchCandidatePool } from "../_shared/recommender-pool.ts";

// Pool sizing — overfetch beyond `limit` so diversity trimming has slack.
const CANDIDATE_POOL = 200;
const OVERFETCH_MULTIPLIER = 2.5;
const MAX_PER_CATEGORY = 4; // diversity cap inside the final deck
const DEFAULT_LIMIT = 20;
const DEFAULT_RADIUS_KM = 25;
const LAZY_EMBED_BATCH = 50;

type Body = {
  lat?: number;
  lng?: number;
  radiusKm?: number;
  limit?: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

  // Caller is optional — we honour the bearer if present so we can read
  // the signed-in consumer's profile for personalisation, but the public
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
  // fetchCandidatePool also haversine-trims by radius — bounding-box
  // alone is coarse at higher latitudes.
  const poolRes = await fetchCandidatePool<VenueRow>(admin, {
    lat,
    lng,
    radiusKm,
    poolSize: CANDIDATE_POOL,
  });
  if (!poolRes.ok) {
    return json({ ok: false, error: `candidate_pool: ${poolRes.error}` }, 500);
  }
  const candidates = poolRes.rows;
  if (candidates.length === 0) {
    return json({ ok: true, deck: [], summary: { candidates: 0, embedded: 0 } });
  }

  // ── 2. Lazy embedding backfill ─────────────────────────────────────
  // Any candidate without an embedding (or with a stale hash) gets one
  // before ranking. Bounded so the first cold request doesn't take 30s.
  const needsEmbed = candidates.filter(shouldEmbed).slice(0, LAZY_EMBED_BATCH);
  let embeddedCount = 0;
  if (needsEmbed.length > 0 && OPENAI_KEY) {
    const patched = await embedAndPersistVenues(
      needsEmbed,
      admin,
      OPENAI_KEY,
      "consumer-recommend-deck",
    );
    embeddedCount = patched.size;
    for (const c of candidates) {
      const p = patched.get(c.id);
      if (p) {
        c.embedding = p.embedding;
        c.embedding_source_hash = p.hash;
      }
    }
  }

  // ── 3. Compose user-intent query ───────────────────────────────────
  const profile = userId && userClient ? await fetchConsumerProfile(userClient, userId) : null;
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
      const intentVec = await embedSingle(intent, OPENAI_KEY);
      ranked = rankByCosine(candidates, intentVec);
    } catch (err) {
      console.error("[consumer-recommend-deck] intent embed failed:", err);
      ranked = fallbackRank(candidates);
    }
  } else {
    ranked = fallbackRank(candidates);
  }

  // ── 5. Diversity + partner-first trim ──────────────────────────────
  // (radius trim already happened inside fetchCandidatePool)
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

type ConsumerProfile = {
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
  profile: ConsumerProfile | null;
  lat: number | null;
  lng: number | null;
  candidates: VenueRow[];
}): string {
  const parts: string[] = [];
  // Time-of-day handle. The Edge runtime is UTC; we don't know the
  // consumer's timezone, so this is rough — gives the embedder a flavour,
  // not a hard filter.
  const now = new Date();
  const hour = now.getUTCHours();
  if (hour < 11) parts.push("morning coffee and brunch energy");
  else if (hour < 16) parts.push("lunch and afternoon hangout vibes");
  else if (hour < 20) parts.push("golden hour rooftops and early dinner");
  else parts.push("dinner, cocktails, and late-night spots");

  if (profile?.country) parts.push(`a consumer from ${profile.country}`);
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
// Ranking
// ─────────────────────────────────────────────────────────────────────

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
// Misc
// ─────────────────────────────────────────────────────────────────────

async function fetchConsumerProfile(
  client: ReturnType<typeof createClient>,
  userId: string,
): Promise<ConsumerProfile | null> {
  const { data } = await client
    .from("consumers")
    .select("full_name, country, birthday, sex")
    .eq("id", userId)
    .maybeSingle();
  return (data as ConsumerProfile | null) ?? null;
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

