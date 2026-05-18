// Supabase Edge Function — venues-enrich-create
//
// Single self-contained workflow. The signed-in manager passes a Google
// Places `placeId`; this function enriches the venue from Google Places +
// Firecrawl (website) + Perplexity (brief) in parallel, synthesises the
// catalog row with OpenAI, then writes venues + venue_members via service
// role. NO calls to other Edge Functions.
//
// Local:  supabase functions serve venues-enrich-create
// Deploy: supabase functions deploy venues-enrich-create

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GOOGLE_FIELD_MASK = [
  "id",
  "displayName",
  "primaryType",
  "primaryTypeDisplayName",
  "types",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "formattedAddress",
  "addressComponents",
  "location",
  "rating",
  "userRatingCount",
  "googleMapsUri",
  "websiteUri",
  "regularOpeningHours",
  "currentOpeningHours",
  "priceLevel",
  "businessStatus",
  "editorialSummary",
  "generativeSummary",
  "reviewSummary",
  "photos",
].join(",");

const MAX_PHOTOS = 20;

type EnrichBody = { placeId?: string };

type GoogleDetails = {
  id?: string;
  displayName?: { text?: string };
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  types?: string[];
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  formattedAddress?: string;
  addressComponents?: { types?: string[]; longText?: string }[];
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  websiteUri?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[]; periods?: unknown[] };
  currentOpeningHours?: { weekdayDescriptions?: string[]; periods?: unknown[] };
  priceLevel?: string;
  businessStatus?: string;
  editorialSummary?: { text?: string };
  generativeSummary?: { overview?: { text?: string }; description?: { text?: string } };
  reviewSummary?: { text?: { text?: string } };
  photos?: { name?: string; widthPx?: number; heightPx?: number; authorAttributions?: { displayName?: string }[] }[];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Third-party secrets follow the `<VENDOR>_SUPABASE_KEY` convention —
  // no PLATFORM, no API. Audience is SUPABASE (server-only); browser keys
  // use `NEXT_PUBLIC_<VENDOR>_BROWSER_KEY` and live on Vercel.
  const GOOGLE_KEY = Deno.env.get("GOOGLE_MAPS_SUPABASE_KEY");
  const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_SUPABASE_KEY");
  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_SUPABASE_KEY");
  const OPENAI_KEY = Deno.env.get("OPENAI_SUPABASE_KEY");

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !GOOGLE_KEY) {
    return json({ ok: false, error: "Server misconfigured (missing core secrets)" }, 500);
  }

  // Authenticate caller.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ ok: false, error: "Missing bearer token" }, 401);
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return json({ ok: false, error: "Invalid session" }, 401);
  }
  const userId = userData.user.id;
  const userEmail = userData.user.email ?? null;

  // Parse input.
  let body: EnrichBody = {};
  try {
    body = (await req.json()) as EnrichBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const placeId = (body.placeId ?? "").toString().trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  // ── Step 1: Google Places details (blocking — everything else needs it) ──
  const details = await fetchGoogleDetails(placeId, GOOGLE_KEY);
  if ("error" in details) {
    return json({ ok: false, error: `google_details: ${details.error}` }, 502);
  }

  const venueName = details.displayName?.text ?? "";
  if (!venueName) {
    return json({ ok: false, error: "Place has no display name" }, 422);
  }
  const city = findAddressComponent(details.addressComponents, ["locality", "administrative_area_level_2"]);
  const country = findAddressComponent(details.addressComponents, ["country"]);
  const address = details.formattedAddress ?? null;

  // ── Step 2: Parallel enrichment (best-effort, all may individually fail) ──
  const [photosResult, firecrawlResult, perplexityResult] = await Promise.allSettled([
    fetchGooglePhotos(details.photos ?? [], MAX_PHOTOS, GOOGLE_KEY),
    fetchFirecrawl(details.websiteUri, FIRECRAWL_KEY),
    fetchPerplexity(venueName, city, country, details.primaryTypeDisplayName?.text ?? null, PERPLEXITY_KEY),
  ]);
  const googlePhotos = photosResult.status === "fulfilled" ? photosResult.value : [];
  const firecrawl = firecrawlResult.status === "fulfilled" ? firecrawlResult.value : null;
  const perplexity = perplexityResult.status === "fulfilled" ? perplexityResult.value : null;

  // Google caps the Places response at 10 photos. Supplement from the
  // scraped website until we hit MAX_PHOTOS.
  const photos: { photoUri: string }[] = [...googlePhotos];
  if (firecrawl?.markdown && photos.length < MAX_PHOTOS) {
    const seen = new Set(photos.map((p) => p.photoUri));
    for (const uri of extractImagesFromMarkdown(firecrawl.markdown)) {
      if (photos.length >= MAX_PHOTOS) break;
      if (seen.has(uri)) continue;
      photos.push({ photoUri: uri });
      seen.add(uri);
    }
  }

  // ── Step 3: OpenAI synthesis (optional — falls back to heuristics) ──
  const synth = await synthesiseVenue(
    {
      name: venueName,
      city,
      country,
      address,
      googlePrimaryType: details.primaryType ?? null,
      googlePrimaryTypeDisplay: details.primaryTypeDisplayName?.text ?? null,
      googleTypes: details.types ?? [],
      googleEditorial: details.editorialSummary?.text ?? null,
      googleGenerative:
        details.generativeSummary?.overview?.text ??
        details.generativeSummary?.description?.text ??
        null,
      googleReviewSummary: details.reviewSummary?.text?.text ?? null,
      googleHours: details.regularOpeningHours?.weekdayDescriptions ?? [],
      googlePriceLevel: priceLevelFromGoogle(details.priceLevel),
      firecrawlMarkdown: firecrawl?.markdown ?? null,
      perplexityBrief: perplexity?.brief ?? null,
    },
    OPENAI_KEY,
  );

  // ── Step 4: Persist (service role; RLS allows reads only) ──
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: managerError } = await admin
    .from("managers")
    .upsert({ id: userId, email: userEmail }, { onConflict: "id" });
  if (managerError) {
    return json({ ok: false, error: `manager_upsert: ${managerError.message}` }, 500);
  }

  const slug = await ensureUniqueSlug(admin, synth.slug);

  const photoUrls = photos.map((p) => p.photoUri).filter(Boolean).slice(0, 20);

  const closesAt =
    synth.closes_at ?? closesAtFromHours(details.regularOpeningHours?.weekdayDescriptions ?? []);

  const insertRow = {
    name: synth.name || venueName,
    slug,
    category: synth.category ?? details.primaryTypeDisplayName?.text ?? details.primaryType ?? null,
    vibe: synth.vibe ?? null,
    price_level: synth.price_level ?? priceLevelFromGoogle(details.priceLevel),
    listing_type: "partner" as const,
    status: "active" as const,
    lat: details.location?.latitude ?? null,
    lng: details.location?.longitude ?? null,
    address,
    timezone: null,
    closes_at: closesAt,
    phone: details.nationalPhoneNumber ?? details.internationalPhoneNumber ?? null,
    pitch: synth.pitch ?? details.editorialSummary?.text ?? null,
    story: synth.story ?? details.generativeSummary?.overview?.text ?? null,
    cashback_percent: 10,
    photos: photoUrls,
    google_place_id: details.id ?? placeId,
  };

  const { data: venue, error: venueError } = await admin
    .from("venues")
    .insert(insertRow)
    .select("id, slug, name, status")
    .single();
  if (venueError) {
    // Unique-violation on google_place_id → already onboarded by someone.
    if (venueError.code === "23505" && /google_place_id/.test(venueError.message)) {
      const existing = await admin
        .from("venues")
        .select("id, slug, name, status, listing_type")
        .eq("google_place_id", details.id ?? placeId)
        .maybeSingle();
      return json(
        {
          ok: false,
          code: "venue_already_exists",
          error:
            "This venue is already on Mesita. If you manage it, contact support to claim ownership.",
          existing: existing.data ?? null,
        },
        409,
      );
    }
    // Unique-violation on slug → very likely two venues with the same name.
    if (venueError.code === "23505" && /\bslug\b/.test(venueError.message)) {
      return json(
        {
          ok: false,
          code: "slug_already_taken",
          error:
            "A venue with this URL slug already exists. Try renaming slightly or contact support.",
        },
        409,
      );
    }
    return json(
      { ok: false, error: `venue_insert: ${venueError.message}`, code: venueError.code ?? null },
      400,
    );
  }

  const { error: memberError } = await admin.from("venue_members").insert({
    venue_id: venue.id,
    manager_id: userId,
    role: "owner",
  });
  if (memberError) {
    await admin.from("venues").delete().eq("id", venue.id);
    return json({ ok: false, error: `member_link: ${memberError.message}` }, 500);
  }

  return json(
    {
      ok: true,
      venue,
      enrichment: {
        google: true,
        photoCount: photoUrls.length,
        firecrawl: !!firecrawl?.markdown,
        perplexity: !!perplexity?.brief,
        openai: synth.source === "openai",
        openaiError: synth.synthError,
      },
    },
    201,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Google Places
// ───────────────────────────────────────────────────────────────────────────

async function fetchGoogleDetails(
  placeId: string,
  apiKey: string,
): Promise<GoogleDetails | { error: string }> {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=es-MX&regionCode=MX`;
  const r = await fetch(url, {
    headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": GOOGLE_FIELD_MASK },
  });
  if (!r.ok) {
    const text = await r.text();
    return { error: `${r.status}: ${text.slice(0, 240)}` };
  }
  return (await r.json()) as GoogleDetails;
}

async function fetchGooglePhotos(
  photos: NonNullable<GoogleDetails["photos"]>,
  max: number,
  apiKey: string,
): Promise<{ photoUri: string }[]> {
  if (!photos.length) return [];
  const top = photos.slice(0, max);
  const settled = await Promise.allSettled(
    top.map(async (p) => {
      if (!p.name) throw new Error("photo missing name");
      const r = await fetch(
        `https://places.googleapis.com/v1/${p.name}/media?maxHeightPx=1600&skipHttpRedirect=true`,
        { headers: { "X-Goog-Api-Key": apiKey } },
      );
      if (!r.ok) throw new Error(`photo HTTP ${r.status}`);
      const d = (await r.json()) as { photoUri?: string };
      if (!d.photoUri) throw new Error("photo missing uri");
      return { photoUri: d.photoUri };
    }),
  );
  return settled
    .filter((s): s is PromiseFulfilledResult<{ photoUri: string }> => s.status === "fulfilled")
    .map((s) => s.value);
}

// ───────────────────────────────────────────────────────────────────────────
// Firecrawl
// ───────────────────────────────────────────────────────────────────────────

const SOCIAL_HOSTS = [
  "instagram.com",
  "facebook.com",
  "fb.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "linkedin.com",
  "linktr.ee",
];

function isSocialUrl(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname.replace(/^www\./, "");
    return SOCIAL_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

function extractImagesFromMarkdown(md: string): string[] {
  if (!md) return [];
  const out: string[] = [];
  const re = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const uri = m[1];
    if (looksLikeImageAsset(uri)) out.push(uri);
  }
  return out;
}

function looksLikeImageAsset(uri: string): boolean {
  try {
    const u = new URL(uri);
    // HTTPS only — mixed-content http:// images break on production hosts
    // and Next.js Image rejects them by default.
    if (u.protocol !== "https:") return false;
    const lower = u.pathname.toLowerCase();
    return (
      lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg") ||
      lower.endsWith(".png") ||
      lower.endsWith(".webp") ||
      lower.endsWith(".avif") ||
      lower.endsWith(".gif") ||
      lower.includes("cloudinary") ||
      lower.includes("/image")
    );
  } catch {
    return false;
  }
}

async function fetchFirecrawl(
  websiteUri: string | undefined,
  apiKey: string | undefined,
): Promise<{ markdown: string; links: string[] } | null> {
  if (!websiteUri || !apiKey) return null;
  if (isSocialUrl(websiteUri)) return null;
  try {
    const r = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: websiteUri,
        formats: ["markdown", "links"],
        onlyMainContent: true,
        timeout: 20000,
      }),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      data?: { markdown?: string; links?: string[] };
    };
    return {
      markdown: (d.data?.markdown ?? "").slice(0, 12000),
      links: (d.data?.links ?? []).slice(0, 20),
    };
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Perplexity
// ───────────────────────────────────────────────────────────────────────────

type PerplexityBrief = {
  summary?: string;
  vibe?: string[];
  audience?: string[];
  must_try?: string[];
  price_perception?: string;
  best_times?: string[];
};

async function fetchPerplexity(
  name: string,
  city: string | null,
  country: string | null,
  category: string | null,
  apiKey: string | undefined,
): Promise<{ brief: PerplexityBrief } | null> {
  if (!apiKey) return null;
  const label = [name, city, country].filter(Boolean).join(", ");
  const prompt =
    `Investiga el establecimiento "${label}"${category ? ` (${category})` : ""}.` +
    " Responde SOLO con un objeto JSON estricto (sin markdown, sin texto extra) con esta forma:" +
    `\n{\n  "summary": "3-5 oraciones en espanol describiendo el lugar, su propuesta y para quien es",\n` +
    `  "vibe": ["palabras clave del ambiente"],\n` +
    `  "audience": ["descripciones cortas del cliente objetivo"],\n` +
    `  "must_try": ["platillos o bebidas representativos"],\n` +
    `  "price_perception": "que dicen los clientes sobre la relacion precio-valor",\n` +
    `  "best_times": ["momentos ideales para visitar"]\n}`;
  try {
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = (data.choices?.[0]?.message?.content ?? "").trim();
    const cleaned = content
      .replace(/^```json\s*\n?/i, "")
      .replace(/^```\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
    try {
      return { brief: JSON.parse(cleaned) as PerplexityBrief };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// OpenAI synthesis
// ───────────────────────────────────────────────────────────────────────────

type SynthInput = {
  name: string;
  city: string | null;
  country: string | null;
  address: string | null;
  googlePrimaryType: string | null;
  googlePrimaryTypeDisplay: string | null;
  googleTypes: string[];
  googleEditorial: string | null;
  googleGenerative: string | null;
  googleReviewSummary: string | null;
  googleHours: string[];
  googlePriceLevel: number | null;
  firecrawlMarkdown: string | null;
  perplexityBrief: PerplexityBrief | null;
};

type SynthOutput = {
  name: string;
  slug: string;
  category: string | null;
  vibe: string | null;
  price_level: number | null;
  pitch: string | null;
  story: string | null;
  closes_at: string | null;
  source: "openai" | "fallback";
  synthError: string | null;
};

async function synthesiseVenue(input: SynthInput, apiKey: string | undefined): Promise<SynthOutput> {
  if (!apiKey) return synthFallback(input, "no OPENAI_SUPABASE_KEY");

  const prompt = [
    "You are normalising a venue for the Mesita catalog. Output STRICT JSON only, no markdown.",
    "Schema:",
    "{",
    '  "name": "string (clean display name)",',
    '  "slug": "string (lowercase, kebab-case, no accents)",',
    '  "category": "string (one short word like \'mediterranean\', \'italian\', \'cafe\', \'bar\', \'mexican\')",',
    '  "vibe": "string (one short word like \'rooftop\', \'cozy\', \'romantic\', \'speakeasy\', \'casual\')",',
    '  "price_level": "integer 1..4 (1 cheap, 4 fine dining)",',
    '  "pitch": "string (one-line tagline, max 120 chars, written like a venue card)",',
    '  "story": "string (one paragraph max 500 chars in the venue\'s likely tone)",',
    '  "closes_at": "string HH:MM 24h, or null if unknown"',
    "}",
    "",
    `Raw data:`,
    JSON.stringify(input, null, 2),
  ].join("\n");

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              "Return only valid JSON matching the requested schema. Never include explanatory text.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!r.ok) {
      const errText = (await r.text()).slice(0, 240);
      console.error("[venues-enrich-create] openai HTTP", r.status, errText);
      return synthFallback(input, `openai_http_${r.status}: ${errText}`);
    }
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    let parsed: Partial<SynthOutput>;
    try {
      parsed = JSON.parse(content) as Partial<SynthOutput>;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "parse error";
      console.error("[venues-enrich-create] openai parse", msg, content.slice(0, 200));
      return synthFallback(input, `openai_parse: ${msg}`);
    }
    return {
      name: (parsed.name ?? input.name).trim() || input.name,
      slug: slugify(parsed.slug ?? input.name).slice(0, 80) || slugify(input.name),
      category: cleanShortString(parsed.category) ?? null,
      vibe: cleanShortString(parsed.vibe) ?? null,
      price_level: clampInt(parsed.price_level, 1, 4) ?? input.googlePriceLevel,
      pitch: cleanLongString(parsed.pitch, 140),
      story: cleanLongString(parsed.story, 600),
      closes_at: cleanShortString(parsed.closes_at, 5) ?? null,
      source: "openai",
      synthError: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "openai exception";
    console.error("[venues-enrich-create] openai exception", msg);
    return synthFallback(input, `openai_exception: ${msg}`);
  }
}

function synthFallback(input: SynthInput, reason: string): SynthOutput {
  return {
    name: input.name,
    slug: slugify(input.name).slice(0, 80),
    category: input.googlePrimaryTypeDisplay ?? input.googlePrimaryType ?? null,
    vibe: null,
    price_level: input.googlePriceLevel,
    pitch: input.googleEditorial?.slice(0, 140) ?? null,
    story: input.googleGenerative?.slice(0, 600) ?? null,
    closes_at: closesAtFromHours(input.googleHours),
    source: "fallback",
    synthError: reason,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function findAddressComponent(
  components: GoogleDetails["addressComponents"],
  types: string[],
): string | null {
  if (!components) return null;
  for (const type of types) {
    const found = components.find((c) => c.types?.includes(type));
    if (found?.longText) return found.longText;
  }
  return null;
}

function priceLevelFromGoogle(p?: string): number | null {
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

function closesAtFromHours(weekdayDescriptions: string[]): string | null {
  // Best-effort: "Friday: 6:00 PM – 2:00 AM" → "02:00"
  for (const line of weekdayDescriptions) {
    const m = line.match(/[-–—]\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const mm = m[2];
      const ampm = m[3]?.toUpperCase();
      if (ampm === "PM" && h < 12) h += 12;
      if (ampm === "AM" && h === 12) h = 0;
      return `${String(h).padStart(2, "0")}:${mm}`;
    }
  }
  return null;
}

function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function ensureUniqueSlug(
  admin: ReturnType<typeof createClient>,
  base: string,
): Promise<string> {
  let candidate = base || `venue-${Date.now()}`;
  for (let i = 0; i < 5; i += 1) {
    const { data } = await admin.from("venues").select("id").eq("slug", candidate).maybeSingle();
    if (!data) return candidate;
    candidate = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return `${base}-${Date.now()}`;
}

function clampInt(n: unknown, lo: number, hi: number): number | null {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
}

function cleanShortString(v: unknown, maxLen = 40): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function cleanLongString(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
