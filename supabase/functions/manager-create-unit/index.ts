// Supabase Edge Function — manager-create-unit
//
// Single self-contained workflow. The signed-in manager passes a Google
// Places `placeId`; this function enriches the venue from Google Places +
// Firecrawl (website) + Perplexity (brief) in parallel, synthesises the
// catalog row with OpenAI, then writes venues + venue_members via service
// role. NO calls to other Edge Functions.
//
// Local:  supabase functions serve manager-create-unit
// Deploy: supabase functions deploy manager-create-unit

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

// Google's regularOpeningHours.periods shape. `day` is 0..6 with Sunday = 0
// (matches JS Date.getDay()). A "24/7" venue returns a single period with an
// `open` but no `close`. Overnight ranges show up as open.day = N, close.day
// = N+1, which is what weeklyHoursFromPeriods has to handle.
type GooglePeriod = {
  open?: { day?: number; hour?: number; minute?: number };
  close?: { day?: number; hour?: number; minute?: number };
};

// Persisted shape for venues.hours (jsonb). Lowercase English day keys;
// closed days are simply omitted. Multiple ranges per day cover split
// shifts (lunch + dinner). Overnight ranges are clipped at 23:59 on the
// open day and resumed at 00:00 on the close day, so each entry is a same-
// day pair that's trivial to render.
type WeeklyHours = Partial<Record<DayKey, { open: string; close: string }[]>>;
type DayKey =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";
const DAY_KEYS: DayKey[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

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
  regularOpeningHours?: { weekdayDescriptions?: string[]; periods?: GooglePeriod[] };
  currentOpeningHours?: { weekdayDescriptions?: string[]; periods?: GooglePeriod[] };
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
  // Third-party secrets follow the `<VENDOR>_SUPABASE_API_KEY` convention
  // (server-only, stored in Supabase secrets). Browser-bound keys use
  // `NEXT_PUBLIC_<VENDOR>_BROWSER_KEY` and live on Vercel.
  const GOOGLE_KEY = Deno.env.get("GOOGLE_MAPS_PLATFORM_SUPABASE_API_KEY");
  const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_SUPABASE_API_KEY");
  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_SUPABASE_API_KEY");
  const OPENAI_KEY = Deno.env.get("OPENAI_SUPABASE_API_KEY");

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

  // ── Pre-flight dedupe ────────────────────────────────────────────────
  // Cheap SELECT before we spend Google + Firecrawl + Perplexity + OpenAI
  // quota on a venue that's already been onboarded. The insert below still
  // catches the race (unique constraint on google_place_id) — this is just
  // an optimisation for the common "manager clicks twice" case. Service
  // role: RLS would hide pending_review / paused / archived rows from the
  // anon path and we want to detect them all.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: existingByPlaceId } = await admin
    .from("venues")
    .select("id, slug, name, status, listing_type")
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (existingByPlaceId) {
    return json(
      {
        ok: false,
        code: "venue_already_exists",
        error:
          "This venue is already on Mesita. If you manage it, contact support to claim ownership.",
        existing: existingByPlaceId,
      },
      409,
    );
  }

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
  const [photosResult, firecrawlResult, perplexityResult, timezoneResult] = await Promise.allSettled([
    fetchGooglePhotos(details.photos ?? [], MAX_PHOTOS, GOOGLE_KEY),
    fetchFirecrawl(details.websiteUri, FIRECRAWL_KEY),
    fetchPerplexity(venueName, city, country, details.primaryTypeDisplayName?.text ?? null, PERPLEXITY_KEY),
    fetchTimezone(details.location?.latitude, details.location?.longitude, GOOGLE_KEY),
  ]);
  const googlePhotos = photosResult.status === "fulfilled" ? photosResult.value : [];
  const firecrawl = firecrawlResult.status === "fulfilled" ? firecrawlResult.value : null;
  const perplexity = perplexityResult.status === "fulfilled" ? perplexityResult.value : null;
  const timezone = timezoneResult.status === "fulfilled" ? timezoneResult.value : null;

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

  // ── Channel extraction ──
  // Walk every outbound link we can collect (Google's websiteUri +
  // googleMapsUri, plus the Firecrawl links[] array) and classify each by
  // hostname into one of our flat channel columns. Best-effort — anything
  // that doesn't match a known host is dropped. Email is pulled separately
  // from the Firecrawl markdown with a regex.
  const channels = classifyLinks([
    details.websiteUri,
    details.googleMapsUri,
    ...(firecrawl?.links ?? []),
  ]);
  const email = extractEmailFromMarkdown(firecrawl?.markdown ?? null);

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
  // `admin` was already instantiated above for the pre-flight placeId
  // dedupe — reuse the same client for writes.

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

  // Normalised weekly schedule for venues.hours (jsonb). Built from Google's
  // regularOpeningHours.periods; null when the place is permanently closed
  // or Google has no hours data.
  const hours = weeklyHoursFromPeriods(details.regularOpeningHours?.periods);

  const insertRow = {
    name: synth.name || venueName,
    slug,
    category: synth.category ?? details.primaryTypeDisplayName?.text ?? details.primaryType ?? null,
    vibe: synth.vibe ?? null,
    price_level: synth.price_level ?? priceLevelFromGoogle(details.priceLevel),
    // Defaults are deliberately conservative: the caller proved nothing
    // beyond "I have a Google placeId", so the venue lands hidden from the
    // public catalog (RLS read filter is status in ('active','lead')) and
    // ineligible for ticket creation (manager-create-ticket gates on
    // listing_type = 'partner'). Operations / the manager-claim flow flips
    // these once the caller is verified as the venue's operator.
    listing_type: "unclaimed" as const,
    status: "pending_review" as const,
    lat: details.location?.latitude ?? null,
    lng: details.location?.longitude ?? null,
    address,
    timezone,
    closes_at: closesAt,
    hours,
    phone: details.nationalPhoneNumber ?? details.internationalPhoneNumber ?? null,
    pitch: synth.pitch ?? details.editorialSummary?.text ?? null,
    story: synth.story ?? details.generativeSummary?.overview?.text ?? null,
    cashback_percent: 10,
    photos: photoUrls,
    google_place_id: details.id ?? placeId,
    // Every channel below is best-effort and may be null. classifyLinks
    // picks the shortest matching URL per host so we land profile roots
    // instead of post-deep-links; email comes from a regex over the
    // scraped homepage markdown.
    website_url: channels.website_url,
    instagram_url: channels.instagram_url,
    facebook_url: channels.facebook_url,
    tiktok_url: channels.tiktok_url,
    x_url: channels.x_url,
    youtube_url: channels.youtube_url,
    threads_url: channels.threads_url,
    reddit_url: channels.reddit_url,
    whatsapp_url: channels.whatsapp_url,
    opentable_url: channels.opentable_url,
    resy_url: channels.resy_url,
    uber_eats_url: channels.uber_eats_url,
    rappi_url: channels.rappi_url,
    didi_food_url: channels.didi_food_url,
    tripadvisor_url: channels.tripadvisor_url,
    google_maps_url: channels.google_maps_url,
    email,
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
        channelCount:
          Object.values(channels).filter((v) => !!v).length + (email ? 1 : 0),
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
// Google Time Zone API
// ───────────────────────────────────────────────────────────────────────────

// Returns an IANA tz id (e.g. "America/Monterrey") for the venue's lat/lng,
// or null on any failure. Uses the same Google key as Places — needs the
// "Time Zone API" enabled on the project (separate enable from Places).
// `timestamp` is required by Google but only matters for DST resolution; we
// pass "now" since we only consume timeZoneId.
async function fetchTimezone(
  lat: number | undefined,
  lng: number | undefined,
  apiKey: string,
): Promise<string | null> {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const url = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${ts}&key=${apiKey}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = (await r.json()) as { status?: string; timeZoneId?: string };
    if (d.status !== "OK") return null;
    return d.timeZoneId ?? null;
  } catch {
    return null;
  }
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

// ───────────────────────────────────────────────────────────────────────────
// Channel classification
// ───────────────────────────────────────────────────────────────────────────

type ChannelKey =
  | "website_url"
  | "instagram_url"
  | "facebook_url"
  | "tiktok_url"
  | "x_url"
  | "youtube_url"
  | "threads_url"
  | "reddit_url"
  | "whatsapp_url"
  | "opentable_url"
  | "resy_url"
  | "uber_eats_url"
  | "rappi_url"
  | "didi_food_url"
  | "tripadvisor_url"
  | "google_maps_url";

type Channels = Record<ChannelKey, string | null>;

// Hostname → channel column. The matcher accepts both exact hostnames and
// subdomain matches (`m.facebook.com` resolves to `facebook_url`). The
// `tripadvisor` and `didi` rules are intentionally loose because the TLD
// varies by country (`.com`, `.com.mx`, `.es`, `.com.ar`).
function matchChannel(host: string): ChannelKey | null {
  const h = host.replace(/^www\./, "").toLowerCase();
  if (h === "instagram.com" || h.endsWith(".instagram.com")) return "instagram_url";
  if (h === "facebook.com" || h.endsWith(".facebook.com")) return "facebook_url";
  if (h === "fb.com" || h.endsWith(".fb.com")) return "facebook_url";
  if (h === "tiktok.com" || h.endsWith(".tiktok.com")) return "tiktok_url";
  if (h === "twitter.com" || h.endsWith(".twitter.com")) return "x_url";
  if (h === "x.com" || h.endsWith(".x.com")) return "x_url";
  if (h === "youtube.com" || h.endsWith(".youtube.com")) return "youtube_url";
  if (h === "youtu.be") return "youtube_url";
  if (h === "threads.net" || h.endsWith(".threads.net")) return "threads_url";
  if (h === "threads.com" || h.endsWith(".threads.com")) return "threads_url";
  if (h === "reddit.com" || h.endsWith(".reddit.com")) return "reddit_url";
  if (h === "wa.me" || h.endsWith(".wa.me")) return "whatsapp_url";
  if (h === "whatsapp.com" || h.endsWith(".whatsapp.com")) return "whatsapp_url";
  if (h.startsWith("opentable.")) return "opentable_url";
  if (h === "resy.com" || h.endsWith(".resy.com")) return "resy_url";
  if (h === "ubereats.com" || h.endsWith(".ubereats.com")) return "uber_eats_url";
  if (h === "rappi.com" || h.endsWith(".rappi.com")) return "rappi_url";
  if (h.startsWith("rappi.com.")) return "rappi_url";
  if (h === "didi.com" || h.endsWith(".didi.com")) return "didi_food_url";
  if (h.startsWith("didifood.")) return "didi_food_url";
  if (h === "sindelantal.com.mx" || h.endsWith(".sindelantal.com.mx")) return "didi_food_url";
  if (h.startsWith("tripadvisor.")) return "tripadvisor_url";
  if (h === "google.com/maps" || h === "maps.google.com" || h.endsWith(".google.com/maps"))
    return "google_maps_url";
  if (h === "maps.app.goo.gl" || h === "goo.gl") return "google_maps_url";
  return null;
}

// Trim tracking junk + trailing slashes so two near-identical links from
// the same host collapse to one before we pick the shortest.
function canonicaliseUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // Strip noisy query params; keep anything that looks meaningful.
    const drop = ["ref", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid"];
    drop.forEach((k) => u.searchParams.delete(k));
    // Drop fragment — never identifies a profile root.
    u.hash = "";
    // Drop trailing slash on pathname so /casaluminar/ ≡ /casaluminar.
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

function classifyLinks(input: (string | null | undefined)[]): Channels {
  const buckets: Partial<Record<ChannelKey, string[]>> = {};
  // The non-social website also needs a home — googleMapsUri / websiteUri
  // come in here too. We treat anything classified as `google_maps_url` /
  // `instagram_url` / etc. through matchChannel, and anything that isn't
  // a known channel host but DOES look like a real website gets to fight
  // for the `website_url` slot.
  const websiteCandidates: string[] = [];

  for (const raw of input) {
    if (!raw) continue;
    const url = canonicaliseUrl(raw);
    if (!url) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    const channel = matchChannel(host);
    if (channel) {
      (buckets[channel] ??= []).push(url);
    } else {
      websiteCandidates.push(url);
    }
  }

  // Pick the shortest URL per channel — heuristic for "profile root over
  // deep link". Ties are broken by the first occurrence (which preserves
  // Google-provided URIs over Firecrawl-scraped ones).
  const pickShortest = (arr: string[] | undefined): string | null => {
    if (!arr || arr.length === 0) return null;
    let best = arr[0];
    for (const v of arr) {
      if (v.length < best.length) best = v;
    }
    return best;
  };

  const result: Channels = {
    website_url: pickShortest(websiteCandidates),
    instagram_url: pickShortest(buckets.instagram_url),
    facebook_url: pickShortest(buckets.facebook_url),
    tiktok_url: pickShortest(buckets.tiktok_url),
    x_url: pickShortest(buckets.x_url),
    youtube_url: pickShortest(buckets.youtube_url),
    threads_url: pickShortest(buckets.threads_url),
    reddit_url: pickShortest(buckets.reddit_url),
    whatsapp_url: pickShortest(buckets.whatsapp_url),
    opentable_url: pickShortest(buckets.opentable_url),
    resy_url: pickShortest(buckets.resy_url),
    uber_eats_url: pickShortest(buckets.uber_eats_url),
    rappi_url: pickShortest(buckets.rappi_url),
    didi_food_url: pickShortest(buckets.didi_food_url),
    tripadvisor_url: pickShortest(buckets.tripadvisor_url),
    google_maps_url: pickShortest(buckets.google_maps_url),
  };
  return result;
}

// One regex over the Firecrawl markdown. Skip obvious noise (no-reply,
// example.com, sentry / image-host garbage). Anything else — including
// gmail addresses — is fine; small venues often run on gmail.
function extractEmailFromMarkdown(md: string | null): string | null {
  if (!md) return null;
  const re = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const email = m[0].toLowerCase();
    if (email.startsWith("noreply@")) continue;
    if (email.startsWith("no-reply@")) continue;
    if (email.endsWith("@example.com")) continue;
    if (email.endsWith("@sentry.io")) continue;
    if (email.endsWith("@wixpress.com")) continue;
    if (email.endsWith("@wordpress.com")) continue;
    return email;
  }
  return null;
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
  if (!apiKey) return synthFallback(input, "no OPENAI_SUPABASE_API_KEY");

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
      console.error("[manager-create-unit] openai HTTP", r.status, errText);
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
      console.error("[manager-create-unit] openai parse", msg, content.slice(0, 200));
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
    console.error("[manager-create-unit] openai exception", msg);
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

function weeklyHoursFromPeriods(periods: GooglePeriod[] | undefined): WeeklyHours | null {
  if (!periods || periods.length === 0) return null;
  const out: WeeklyHours = {};

  // 24/7 venues come back as a single period with `open` only, day=0, hour=0.
  // Mirror that as every day 00:00→23:59 so consumers don't special-case.
  if (
    periods.length === 1 &&
    periods[0].open &&
    !periods[0].close &&
    (periods[0].open.hour ?? 0) === 0 &&
    (periods[0].open.minute ?? 0) === 0
  ) {
    for (const day of DAY_KEYS) {
      out[day] = [{ open: "00:00", close: "23:59" }];
    }
    return out;
  }

  for (const p of periods) {
    const oDay = p.open?.day;
    if (typeof oDay !== "number" || oDay < 0 || oDay > 6) continue;
    const openStr = hhmm(p.open?.hour, p.open?.minute);
    if (!openStr) continue;

    // No close → open-ended; record start only with a placeholder close.
    if (!p.close) {
      pushRange(out, DAY_KEYS[oDay], openStr, "23:59");
      continue;
    }

    const cDay = p.close.day;
    const closeStr = hhmm(p.close.hour, p.close.minute);
    if (typeof cDay !== "number" || !closeStr) continue;

    if (cDay === oDay) {
      pushRange(out, DAY_KEYS[oDay], openStr, closeStr);
    } else {
      // Overnight: split into open-day 23:59 + close-day 00:00 → close.
      // Mesita's UI shows hours per weekday, and a Friday 6pm–2am venue
      // should appear under Friday 18:00–23:59 AND Saturday 00:00–02:00.
      pushRange(out, DAY_KEYS[oDay], openStr, "23:59");
      if (closeStr !== "00:00") {
        pushRange(out, DAY_KEYS[cDay], "00:00", closeStr);
      }
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

function hhmm(hour: number | undefined, minute: number | undefined): string | null {
  if (typeof hour !== "number" || hour < 0 || hour > 23) return null;
  const m = typeof minute === "number" && minute >= 0 && minute <= 59 ? minute : 0;
  return `${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function pushRange(hours: WeeklyHours, day: DayKey, open: string, close: string): void {
  (hours[day] ??= []).push({ open, close });
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
