// Supabase Edge Function — recommender-rank-catalog (artificial caller)
//
// Builds a dynamically-curated catalog: up to N rows, each with its own
// LLM-proposed label/description/emoji + a cosine-ranked slice of the
// candidate pool. Categories are NOT a prebuilt taxonomy — they're
// proposed per request from the venue mix in the user's area plus user
// context (location, time, profile).
//
// Pipeline:
//   1. Pull a wider candidate pool (default 300) by bounding-box radius.
//   2. Lazily embed any candidates missing an embedding (batched, capped).
//   3. Ask an LLM to propose category buckets that would resonate with
//      THIS user given THIS pool — each bucket carries a label, a short
//      description, an emoji icon, and a semantic-search intent_query.
//   4. Embed each intent_query in one batched OpenAI call.
//   5. For each category, cosine-rank the candidate pool against its
//      intent vec and slice off the top N.
//   6. Cross-category dedupe so a venue appears in at most 2 buckets
//      (lets a really good place repeat once but not seven times).
//
// Auth: artificial caller — only invoked by natural-caller EFs (currently
// consumer-recommend-catalog) over the internal-call channel. verify_jwt
// is disabled at the gateway; the EF itself enforces the service-role
// bearer via requireInternalCaller.
//
// Deploy: supabase functions deploy recommender-rank-catalog

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import {
  EMBEDDING_DIMS,
  embedAndPersistVenues,
  embedBatch,
  rankByCosine,
  shouldEmbed,
} from "../_shared/embeddings.ts";
import { fetchCandidatePool } from "../_shared/recommender-pool.ts";

const CANDIDATE_POOL = 300;
const DEFAULT_RADIUS_KM = 25;
const DEFAULT_MAX_CATEGORIES = 10;
const DEFAULT_PER_CATEGORY = 10;
const MAX_PER_CATEGORY_CAP = 20;
const LAZY_EMBED_BATCH = 80;
const MAX_VENUE_REUSE = 2;

const CATEGORY_MODEL = "gpt-4o-mini";

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
  maxCategories?: number;
  perCategory?: number;
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

type ProposedCategory = {
  key: string;
  label: string;
  description: string;
  emoji: string;
  intent_query: string;
};

type BuiltCategory = {
  key: string;
  label: string;
  description: string;
  emoji: string;
  venues: Omit<VenueRow, "embedding" | "embedding_source_hash">[];
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
    /* empty body valid — anonymous catalog */
  }
  const lat = typeof body.lat === "number" && Number.isFinite(body.lat) ? body.lat : null;
  const lng = typeof body.lng === "number" && Number.isFinite(body.lng) ? body.lng : null;
  const radiusKm = clampPositive(body.radiusKm, DEFAULT_RADIUS_KM, 200);
  const maxCategories = clampInt(body.maxCategories, DEFAULT_MAX_CATEGORIES, 1, 12);
  const perCategory = clampInt(body.perCategory, DEFAULT_PER_CATEGORY, 1, MAX_PER_CATEGORY_CAP);
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
    return json({ ok: true, categories: [], summary: { candidates: 0 } });
  }

  // ── 2. Lazy embedding backfill ─────────────────────────────────────
  const needsEmbed = candidates.filter(shouldEmbed).slice(0, LAZY_EMBED_BATCH);
  let embeddedCount = 0;
  if (needsEmbed.length > 0 && OPENAI_KEY) {
    const patched = await embedAndPersistVenues(
      needsEmbed,
      admin,
      OPENAI_KEY,
      "recommender-rank-catalog",
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

  // ── 3. Propose dynamic categories with an LLM ──────────────────────
  let proposed: ProposedCategory[];
  if (OPENAI_KEY) {
    try {
      proposed = await proposeCategories({
        candidates,
        profile,
        lat,
        lng,
        maxCategories,
        apiKey: OPENAI_KEY,
      });
    } catch (err) {
      console.error("[recommender-rank-catalog] propose failed:", err);
      proposed = fallbackCategories(candidates, maxCategories);
    }
  } else {
    proposed = fallbackCategories(candidates, maxCategories);
  }

  if (proposed.length === 0) {
    return json({ ok: true, categories: [], summary: { candidates: candidates.length } });
  }

  // ── 4. Batch-embed all intent queries in ONE OpenAI call ───────────
  let intentVecs: number[][];
  if (OPENAI_KEY) {
    try {
      intentVecs = await embedBatch(proposed.map((c) => c.intent_query), OPENAI_KEY);
    } catch (err) {
      console.error("[recommender-rank-catalog] intent embed failed:", err);
      intentVecs = [];
    }
  } else {
    intentVecs = [];
  }

  // ── 5. Rank candidates per category + 6. cross-category dedupe ─────
  const usage = new Map<string, number>();
  const categories: BuiltCategory[] = [];
  for (let i = 0; i < proposed.length; i += 1) {
    const p = proposed[i];
    const vec = intentVecs[i];
    let ranked: VenueRow[];
    if (vec && vec.length === EMBEDDING_DIMS) {
      ranked = rankByCosine(candidates, vec);
    } else {
      // No vec → simple text-match fallback so the row still shows up.
      ranked = candidates.filter((v) =>
        (v.category ?? "").toLowerCase().includes(p.label.toLowerCase().split(" ")[0]) ||
        (v.vibe ?? "").toLowerCase().includes(p.label.toLowerCase().split(" ")[0]),
      );
    }

    const picked: VenueRow[] = [];
    for (const r of ranked) {
      if (picked.length >= perCategory) break;
      const used = usage.get(r.id) ?? 0;
      if (used >= MAX_VENUE_REUSE) continue;
      picked.push(r);
      usage.set(r.id, used + 1);
    }
    if (picked.length === 0) continue;
    categories.push({
      key: p.key,
      label: p.label,
      description: p.description,
      emoji: p.emoji,
      venues: picked.map(stripInternal),
    });
  }

  return json({
    ok: true,
    categories,
    summary: {
      candidates: candidates.length,
      embedded: embeddedCount,
      categoryCount: categories.length,
      caller: callerRes.callerName,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────
// Category proposal (LLM)
// ─────────────────────────────────────────────────────────────────────

async function proposeCategories({
  candidates,
  profile,
  lat,
  lng,
  maxCategories,
  apiKey,
}: {
  candidates: VenueRow[];
  profile: ConsumerProfile | null;
  lat: number | null;
  lng: number | null;
  maxCategories: number;
  apiKey: string;
}): Promise<ProposedCategory[]> {
  // We give the model a compact view of the pool so its categories are
  // grounded in venues that actually exist (not generic taxonomy). Keep
  // the payload modest — first 80 rows is plenty signal.
  const poolDigest = candidates.slice(0, 80).map((v) => ({
    name: v.name,
    category: v.category,
    vibe: v.vibe,
    price: v.price_level,
    listing_type: v.listing_type,
  }));

  const now = new Date();
  const userContext = {
    country: profile?.country ?? null,
    location: lat != null && lng != null ? { lat, lng } : null,
    utc_hour: now.getUTCHours(),
    weekday: now.toLocaleString("en", { weekday: "long" }),
    // Premium members get more aspirational, standout-leaning curation.
    membership: profile?.tier === "premium" ? "premium" : "free",
  };

  const system = [
    "You are Mesita's catalog curator. You see a real-time slice of nearby venues and one user's context.",
    "Propose up to N catalog rows that feel hand-curated for THIS user — not a generic taxonomy.",
    "Hard rules:",
    "  • Every category must be groundable in the pool (don't propose 'ramen' if there's no ramen).",
    "  • Labels must be specific and motivating: 'Polanco rooftops for golden hour' not 'Italian'.",
    "  • Descriptions are one short sentence, written like a venue card.",
    "  • Emoji must be a single character: 🌇 ✨ 🍷 ☕️ — not a sequence.",
    "  • intent_query is a SEMANTIC SEARCH PROMPT (one sentence, evocative) that will be embedded and",
    "    matched against venue text. Write it as the kind of thing a search engine could rank against,",
    "    e.g. 'cozy candlelit bistros perfect for a quiet weeknight date'.",
    "Return STRICT JSON only, shape:",
    `{ "categories": [{ "label": "...", "description": "...", "emoji": "x", "intent_query": "..." }, ...] }`,
  ].join("\n");

  const user = JSON.stringify(
    { maxCategories, userContext, pool: poolDigest },
    null,
    2,
  );

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CATEGORY_MODEL,
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`propose HTTP ${r.status}`);
  const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(content) as { categories?: Partial<ProposedCategory>[] };
  const items = (parsed.categories ?? [])
    .filter((c) => c && typeof c.label === "string" && typeof c.intent_query === "string")
    .slice(0, maxCategories)
    .map((c, idx) => ({
      key: slug(c.label ?? `cat-${idx}`),
      label: (c.label ?? "").slice(0, 80),
      description: (c.description ?? "").slice(0, 140),
      emoji: pickEmoji(c.emoji),
      intent_query: (c.intent_query ?? c.label ?? "").slice(0, 240),
    }));
  return items;
}

// Used if the LLM proposal fails: bucket by Google primary category.
function fallbackCategories(rows: VenueRow[], maxCategories: number): ProposedCategory[] {
  const byCat = new Map<string, VenueRow[]>();
  for (const r of rows) {
    const c = (r.category ?? "").toLowerCase().trim();
    if (!c) continue;
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(r);
  }
  return [...byCat.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxCategories)
    .map(([cat]) => ({
      key: slug(cat),
      label: cat.charAt(0).toUpperCase() + cat.slice(1),
      description: `Top ${cat} venues nearby`,
      emoji: "✨",
      intent_query: `${cat} venues with great vibe and worth the visit`,
    }));
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function pickEmoji(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "✨";
  const it = raw[Symbol.iterator]();
  const first = it.next();
  return first.done ? "✨" : (first.value as string);
}

function clampPositive(v: unknown, def: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function stripInternal(v: VenueRow): Omit<VenueRow, "embedding" | "embedding_source_hash"> {
  const { embedding: _e, embedding_source_hash: _h, ...rest } = v;
  void _e; void _h;
  return rest;
}
