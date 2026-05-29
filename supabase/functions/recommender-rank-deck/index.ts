// Supabase Edge Function — recommender-rank-deck (artificial caller)
//
// Pure ranking pipeline. Takes a location + optional consumer profile and
// returns a curated 20-card deck for the consumer swipe view. Anonymous
// requests are valid — discovery is public until sign-up, so the natural
// caller passes profile=null when there's no session.
//
// Pipeline:
//   1. Pull a bounded candidate pool by bounding-box radius (cheap).
//   2. Lazy-embed any candidates missing an embedding (single batched
//      OpenAI call, capped so first-cold-request stays sub-EF-timeout).
//   3. Compose a one-sentence intent query from the profile + location
//      + time of day + dominant categories in the pool.
//   4. Embed the intent once and ORDER BY cosine.
//   5. Diversify (no >4 cards in the same category) + trim to limit.
//
// Auth: artificial caller — only invoked by natural-caller EFs over the
// internal-call channel. verify_jwt is disabled at the gateway; the EF
// itself enforces the service-role bearer via requireInternalCaller.
//
// Deploy:    supabase functions deploy recommender-rank-deck

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import {
  embedAndPersistVenues,
  embedSingle,
  rankByCosine,
  shouldEmbed,
} from "../_shared/embeddings.ts";
import { fetchCandidatePool } from "../_shared/recommender-pool.ts";

const CANDIDATE_POOL = 200;
const MAX_PER_CATEGORY = 4;
const DEFAULT_LIMIT = 20;
const DEFAULT_RADIUS_KM = 25;
const LAZY_EMBED_BATCH = 50;

type ConsumerProfile = {
  full_name: string | null;
  country: string | null;
  birthday: string | null;
  sex: string | null;
  tier?: string | null;
};

type Body = {
  lat?: number | null;
  lng?: number | null;
  radiusKm?: number;
  limit?: number;
  profile?: ConsumerProfile | null;
};

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
  [key: string]: unknown;
  embedding: unknown | null;
  embedding_source_hash: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  const callerRes = requireInternalCaller(req, env);
  if (!callerRes.ok) return callerRes.response;

  const OPENAI_KEY = Deno.env.get("OPENAI_KEY");

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* empty body is valid — anonymous browse */
  }
  const lat = typeof body.lat === "number" && Number.isFinite(body.lat) ? body.lat : null;
  const lng = typeof body.lng === "number" && Number.isFinite(body.lng) ? body.lng : null;
  const radiusKm = clampPositive(body.radiusKm, DEFAULT_RADIUS_KM, 200);
  const limit = clampPositive(body.limit, DEFAULT_LIMIT, 50);
  const profile = body.profile ?? null;

  const admin = adminClient(env);

  // ── 1. Candidate pool ──────────────────────────────────────────────
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
  const needsEmbed = candidates.filter(shouldEmbed).slice(0, LAZY_EMBED_BATCH);
  let embeddedCount = 0;
  if (needsEmbed.length > 0 && OPENAI_KEY) {
    const patched = await embedAndPersistVenues(
      needsEmbed,
      admin,
      OPENAI_KEY,
      "recommender-rank-deck",
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
  const intent = composeIntent({ profile, lat, lng, candidates });

  // ── 4. Rank by embedding similarity (or fall back to partner-first) ──
  let ranked: VenueRow[];
  if (OPENAI_KEY) {
    try {
      const intentVec = await embedSingle(intent, OPENAI_KEY);
      ranked = rankByCosine(candidates, intentVec);
    } catch (err) {
      console.error("[recommender-rank-deck] intent embed failed:", err);
      ranked = fallbackRank(candidates);
    }
  } else {
    ranked = fallbackRank(candidates);
  }

  // ── 5. Tier boost + diversity + partner-first trim ──────────────────
  // Premium guests get a stronger partner-first deck (a real perk: better,
  // more rewarding recommendations). Free guests keep the pure relevance
  // order. The boost is a stable partial reorder, so within partners /
  // within non-partners the relevance ranking from step 4 is preserved.
  const boosted = applyTierBoost(ranked, profile?.tier ?? null);
  const deck = diversify(boosted, limit, MAX_PER_CATEGORY);

  return json({
    ok: true,
    deck: deck.map(stripInternal),
    summary: {
      candidates: candidates.length,
      embedded: embeddedCount,
      intent,
      caller: callerRes.callerName,
    },
  });
});

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
  if (profile?.tier === "premium") {
    parts.push("a Mesita Premium member who values standout, high-quality venues");
  }
  if (lat != null && lng != null) parts.push(`within ${DEFAULT_RADIUS_KM}km of this location`);

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
// Trim helpers
// ─────────────────────────────────────────────────────────────────────

// Premium overlay: stable partition that floats partner venues above
// non-partners while preserving the relevance order inside each group. A
// no-op for free / anonymous, so the deck only changes for Premium members.
function applyTierBoost(rows: VenueRow[], tier: string | null): VenueRow[] {
  if (tier !== "premium") return rows;
  const partners: VenueRow[] = [];
  const rest: VenueRow[] = [];
  for (const r of rows) {
    if (r.listing_type === "partner") partners.push(r);
    else rest.push(r);
  }
  return [...partners, ...rest];
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
  for (const r of tail) {
    if (out.length >= limit) break;
    out.push(r);
  }
  return out;
}

function clampPositive(v: unknown, def: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

function stripInternal(v: VenueRow): Omit<VenueRow, "embedding" | "embedding_source_hash"> {
  const { embedding: _e, embedding_source_hash: _h, ...rest } = v;
  void _e; void _h;
  return rest;
}
