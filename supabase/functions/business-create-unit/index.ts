// Supabase Edge Function — business-create-unit
//
// Single self-contained workflow. The signed-in business passes a Google
// Places `placeId`; this function enriches the venue from Google Places +
// Firecrawl (website) + Perplexity (brief) in parallel, synthesises the
// catalog row with OpenAI, then writes venues + venue_members via service
// role. NO calls to other Edge Functions.
//
// Local:  supabase functions serve business-create-unit
// Deploy: supabase functions deploy business-create-unit

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { isOnDomain } from "../_shared/onboarding.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";
import { classifyLinks } from "../_shared/channels.ts";
import { firecrawlScrape } from "../_shared/firecrawl.ts";
import { fetchVenueCategories, inferVenueCategory } from "../_shared/categories.ts";

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
  "reviews",
  "photos",
].join(",");

// Sourcing budget: how many candidate photo URLs we collect from Google CSE
// + Firecrawl + Google Places before any quality pass.
const MAX_PHOTOS = 20;
// What we actually persist after the gpt-4o-mini vision ranking. Half the
// candidate pool is dropped on purpose — the swipe-card cover and gallery
// only show a handful, so the floor 10 are dead weight that slow loads and
// dilute the venue's first impression.
const MAX_PHOTOS_TO_KEEP = 10;

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
// shifts (lunch + dinner). Overnight ranges live on the opening day with
// `close <= open` semantically meaning the close time is the next day —
// a single entry per overnight shift, not a Mon-23:59 + Tue-00:00 pair.
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
  // Up to 5 real reviews from Google Place Details. Mapped into the
  // google_reviews jsonb column — real authors/ratings/quotes only.
  reviews?: {
    rating?: number;
    text?: { text?: string };
    originalText?: { text?: string };
    relativePublishTimeDescription?: string;
    authorAttribution?: { displayName?: string };
  }[];
  photos?: { name?: string; widthPx?: number; heightPx?: number; authorAttributions?: { displayName?: string }[] }[];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Third-party secrets follow the `<VENDOR>_SUPABASE_API_KEY` convention
  // (server-only, stored in Supabase secrets). Browser-bound keys use
  // `NEXT_PUBLIC_<VENDOR>_BROWSER_KEY` and live on Vercel.
  // Google Maps Platform key. Cloud secret is GMP_KEY; SUPA_GMP_KEY kept as a
  // fallback for older environments that haven't been renamed yet.
  const GOOGLE_KEY = Deno.env.get("GMP_KEY") ?? Deno.env.get("SUPA_GMP_KEY");
  const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_KEY");
  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_KEY");
  const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
  // Google Custom Search (image search) for venue marketing-grade photos.
  // Independent of Google Maps Platform: it needs its own API key + a
  // Programmable Search Engine ID configured to "search the entire web"
  // with image search ON. Optional — when either secret is missing we
  // simply skip this enrichment source.
  const GOOGLE_CSE_KEY = Deno.env.get("GOOGLE_CSE_SUPABASE_API_KEY");
  const GOOGLE_CSE_ID = Deno.env.get("GOOGLE_CSE_ID");

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
  const bodyRes = await readJson<EnrichBody>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const placeId = (bodyRes.body.placeId ?? "").toString().trim();
  if (!placeId) return json({ ok: false, error: "placeId is required" }, 400);

  // ── Pre-flight dedupe ────────────────────────────────────────────────
  // Cheap SELECT before we spend Google + Firecrawl + Perplexity + OpenAI
  // quota on a venue that's already been onboarded. The insert below still
  // catches the race (unique constraint on google_place_id) — this is just
  // an optimisation for the common "business clicks twice" case. Service
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
    // Surface transient Google outages as 503 so the operator UI can
    // distinguish them from a genuine bad-request (502). Body carries
    // the pre-classified friendly message; no raw JSON is bubbled up.
    return json(
      { ok: false, code: details.transient ? "google_unavailable" : "google_error", error: details.error },
      details.transient ? 503 : 502,
    );
  }

  // Google Business is the spine: a venue that Google can't give a name,
  // coordinates, and an address for is not a real listing and must NOT enter
  // Mesita. These fields are non-nullable on the profile — reject here rather
  // than inserting a half-null row the consumer app then has to special-case.
  const venueName = details.displayName?.text ?? "";
  if (!venueName) {
    return json(
      { ok: false, code: "google_spine_incomplete", error: "Place has no display name on Google — can't list it." },
      422,
    );
  }
  if (details.location?.latitude == null || details.location?.longitude == null) {
    return json(
      { ok: false, code: "google_spine_incomplete", error: "Place has no coordinates on Google — can't list it." },
      422,
    );
  }
  const address = details.formattedAddress ?? null;
  if (!address) {
    return json(
      { ok: false, code: "google_spine_incomplete", error: "Place has no address on Google — can't list it." },
      422,
    );
  }
  const city = findAddressComponent(details.addressComponents, ["locality", "administrative_area_level_2"]);
  const country = findAddressComponent(details.addressComponents, ["country"]);

  // ── Step 2: Parallel enrichment (best-effort, all may individually fail) ──
  // Photo sources, in priority order:
  //   1. Google Custom Search (image search) — usually marketing-grade
  //      shots from press, blogs, IG mirrors; quality > Google Places.
  //   2. Firecrawl — images scraped from the venue's own website.
  //   3. Google Places photos — last resort. They're user-generated,
  //      tend to be dim phone shots, but they cover venues that have
  //      no website and no press.
  // We put the better source first so the swipe-card cover photo
  // (photos[0]) is the best image we can find.
  const [
    placesPhotosResult,
    cseImagesResult,
    firecrawlResult,
    perplexityResult,
    timezoneResult,
  ] = await Promise.allSettled([
    fetchGooglePhotos(details.photos ?? [], MAX_PHOTOS, GOOGLE_KEY),
    fetchCseImages(venueName, city, country, GOOGLE_CSE_KEY, GOOGLE_CSE_ID),
    fetchFirecrawl(details.websiteUri, FIRECRAWL_KEY),
    fetchPerplexity(venueName, city, country, details.primaryTypeDisplayName?.text ?? null, PERPLEXITY_KEY),
    fetchTimezone(details.location?.latitude, details.location?.longitude, GOOGLE_KEY),
  ]);
  const placesPhotos = placesPhotosResult.status === "fulfilled" ? placesPhotosResult.value : [];
  const cseImages = cseImagesResult.status === "fulfilled" ? cseImagesResult.value : [];
  const firecrawl = firecrawlResult.status === "fulfilled" ? firecrawlResult.value : null;
  const perplexity = perplexityResult.status === "fulfilled" ? perplexityResult.value : null;
  const timezone = timezoneResult.status === "fulfilled" ? timezoneResult.value : null;

  // Merge sources in priority order with URL-dedup. Stops at MAX_PHOTOS.
  const photos: { photoUri: string }[] = [];
  const seen = new Set<string>();
  const push = (uri: string) => {
    if (photos.length >= MAX_PHOTOS) return;
    if (seen.has(uri)) return;
    photos.push({ photoUri: uri });
    seen.add(uri);
  };
  for (const img of cseImages) push(img);
  if (firecrawl?.markdown) {
    for (const uri of extractImagesFromMarkdown(firecrawl.markdown)) push(uri);
  }
  for (const p of placesPhotos) push(p.photoUri);

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
  const email = extractEmailFromMarkdown(
    firecrawl?.markdown ?? null,
    channels.website_url ?? details.websiteUri ?? null,
  );

  // ── Step 3: OpenAI synthesis (catalog row) ──
  // synthesiseVenue writes the catalog fields (name, vibe, pitch, story).
  // Photo VISION RANKING is intentionally NOT done here: Atlas owns the image
  // funnel (atlas-enrich-profile gathers Google/website/Instagram, vision-
  // analyzes, then sorts by the experience rubric). Create just SEEDS the raw
  // candidate photos in source-priority order so the venue has a gallery the
  // instant it's created, even if the async enrich is slow or fails.
  const candidateUrls = photos.map((p) => p.photoUri).filter(Boolean);
  // Instagram follower count is a strong "is this place culturally relevant?"
  // signal on the Place page's Signals tile. Fetch it in parallel with the
  // synth so it doesn't add latency. Best-effort: if Instagram blocks Firecrawl
  // or the regex misses, the value stays null and the UI shows the note.
  const instagramFollowersPromise = fetchInstagramFollowers(
    channels.instagram_url ?? null,
    FIRECRAWL_KEY,
  );

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
  const instagramFollowers = await instagramFollowersPromise;

  // ── Category inference (dynamic, from the live venue_categories table) ──
  // The category vocabulary is editable, so we read every slug at run time and
  // let the classifier pick one — never a hardcoded list. Falls back to the
  // OpenAI synth guess / Google's primary type when inference is unavailable
  // (no key, lookup error, or no confident match against the live slugs).
  const categoryList = await fetchVenueCategories(admin);
  const inferredCategory = await inferVenueCategory(OPENAI_KEY, categoryList, {
    name: venueName,
    address,
    googlePrimaryType: details.primaryType ?? null,
    googlePrimaryTypeDisplay: details.primaryTypeDisplayName?.text ?? null,
    googleTypes: details.types ?? [],
    editorialSummary:
      details.editorialSummary?.text ??
      details.generativeSummary?.overview?.text ??
      null,
    description: perplexity?.brief?.summary ?? null,
  });
  const resolvedCategorySlug =
    inferredCategory ??
    synth.category ??
    details.primaryTypeDisplayName?.text ??
    details.primaryType ??
    null;
  const resolvedCategoryLabel = categoryLabelForSlug(
    categoryList,
    resolvedCategorySlug,
  );

  // ── Step 4: Persist (service role; RLS allows reads only) ──
  // `admin` was already instantiated above for the pre-flight placeId
  // dedupe — reuse the same client for writes.

  const { error: businessError } = await admin
    .from("businesses")
    .upsert({ id: userId, email: userEmail }, { onConflict: "id" });
  if (businessError) {
    return json({ ok: false, error: `business_upsert: ${businessError.message}` }, 500);
  }

  const slug = await ensureUniqueSlug(admin, synth.slug);

  // Seed the gallery with the raw candidates in source-priority order
  // (CSE > Firecrawl > Places), capped at the keep budget. Atlas re-gathers,
  // vision-analyzes and re-sorts this set right after create, so the final
  // ordering is owned by the enricher — this is just the immediate seed.
  const photoUrls = candidateUrls.slice(0, MAX_PHOTOS_TO_KEEP);

  const closesAt =
    synth.closes_at ?? closesAtFromHours(details.regularOpeningHours?.weekdayDescriptions ?? []);

  // Normalised weekly schedule for venues.hours (jsonb). Built from Google's
  // regularOpeningHours.periods; null when the place is permanently closed
  // or Google has no hours data.
  const hours = weeklyHoursFromPeriods(details.regularOpeningHours?.periods);

  const insertRow = {
    name: synth.name || venueName,
    slug,
    category: resolvedCategorySlug,
    category_label:
      resolvedCategoryLabel ?? humanizeCategoryFallback(resolvedCategorySlug),
    vibe: synth.vibe ?? null,
    price_level: synth.price_level ?? priceLevelFromGoogle(details.priceLevel),
    // Created venues are publicly discoverable but not yet claimed by
    // anyone. RLS shows status in ('active','lead'); ticket creation
    // gates on listing_type='partner' so unclaimed web listings stay
    // bookable-blocked until the owner verifies + upgrades. The owning
    // venue_members row is NOT created here — that only lands when
    // admin-decide-verification approves an ownership claim.
    listing_type: "web" as const,
    status: "active" as const,
    lat: details.location?.latitude ?? null,
    lng: details.location?.longitude ?? null,
    address,
    timezone,
    closes_at: closesAt,
    hours,
    phone: details.nationalPhoneNumber ?? details.internationalPhoneNumber ?? null,
    // country is the long-form name Google returns ("Mexico",
    // "United States", etc.). The lookup EF normalises this into a
    // region bucket so the manual-fallback card can pick the right
    // contact channel (WhatsApp for LatAm, SMS for US, email floor).
    country,
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
    // Signal columns surfaced on the Place page's Signals tiles. The
    // mesita_* counterparts are populated by aggregation jobs later; the
    // Google + Instagram values come straight from the enrichment pass.
    google_stars_overall: details.rating ?? null,
    google_review_count: details.userRatingCount ?? null,
    // Real reviews straight from Google Place Details (up to 5). Qualitative
  // profile fields (details{}, summary, products, popular_times) are filled
    // separately by the atlas-enrich-profile agent after insert.
    google_reviews: mapGoogleReviews(details.reviews),
    editorial_summary: details.editorialSummary?.text ?? null,
    instagram_followers_count: instagramFollowers,
  };

  let { data: venue, error: venueError } = await admin
    .from("venues")
    .insert(insertRow)
    .select("id, slug, name, status")
    .single();

  // Backward compatibility: some remote projects may still be warming schema
  // cache or missing the category_label column migration. Retry without that
  // field so venue creation remains available.
  if (venueError && isMissingCategoryLabelColumnError(venueError)) {
    const { category_label: _ignored, ...legacyInsertRow } = insertRow;
    const retry = await admin
      .from("venues")
      .insert(legacyInsertRow)
      .select("id, slug, name, status")
      .single();
    venue = retry.data;
    venueError = retry.error;
  }
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

  // Intentionally no venue_members insert. The caller becomes the
  // owner only when admin-decide-verification approves their ownership
  // claim — until then, the venue is publicly listed but unowned, and
  // the caller can't manage anything on it.

  // One-run completion: hand the fresh venue to the profile-enricher agent
  // so the qualitative fields (details{}, summary, products, popular times,
  // zone/city, established_year, executive_chef) land before we return.
  // Best-effort — the venue already exists; a failed/timed-out enrich just
  // leaves those nullable fields empty (admin-enrich-venue can re-run).
  let profileEnrichError: string | null = null;
  if (SUPABASE_URL && ANON_KEY && SERVICE_KEY) {
    try {
      const enrichRes = await invokeArtificialCaller(
        { url: SUPABASE_URL, anonKey: ANON_KEY, serviceKey: SERVICE_KEY },
        "business-create-unit",
        "atlas-enrich-profile",
        {
          venue_id: venue.id,
          name: venue.name,
          address,
          category: insertRow.category,
        },
      );
      if (!enrichRes.ok) profileEnrichError = enrichRes.error;
    } catch (err) {
      profileEnrichError = err instanceof Error ? err.message : "enrich_failed";
    }
  }

  return json(
    {
      ok: true,
      venue,
      enrichment: {
        google: true,
        profileEnriched: !profileEnrichError,
        profileEnrichError,
        // photoCount = seed photos persisted at create. Atlas re-gathers +
        // vision-ranks asynchronously, so this is the pre-enrich seed count.
        photoCount: photoUrls.length,
        photoCandidates: candidateUrls.length,
        // Photo vision ranking is owned by Atlas (atlas-enrich-profile) now.
        photoRanked: false,
        firecrawl: !!firecrawl?.markdown,
        perplexity: !!perplexity?.brief,
        openai: synth.source === "openai",
        openaiError: synth.synthError,
        channelCount:
          Object.values(channels).filter((v) => !!v).length + (email ? 1 : 0),
        googleRating: details.rating ?? null,
        googleReviewCount: details.userRatingCount ?? null,
        instagramFollowers,
      },
    },
    201,
  );
});

// Maps Google Place Details reviews (up to 5) into the google_reviews jsonb
// shape the consumer venue-detail modal renders: { author, rating, quote,
// date }. Returns null when Google returned no reviews so the column stays
// honestly empty rather than [].
function mapGoogleReviews(
  reviews: GoogleDetails["reviews"],
): { author: string; rating: number; quote: string; date: string }[] | null {
  if (!Array.isArray(reviews) || reviews.length === 0) return null;
  const mapped = reviews
    .map((r) => ({
      author: r.authorAttribution?.displayName ?? "Google reviewer",
      rating: typeof r.rating === "number" ? r.rating : 0,
      quote: (r.text?.text ?? r.originalText?.text ?? "").trim(),
      date: r.relativePublishTimeDescription ?? "",
    }))
    .filter((r) => r.quote.length > 0);
  return mapped.length > 0 ? mapped : null;
}

function isMissingCategoryLabelColumnError(err: { message?: string } | null): boolean {
  if (!err?.message) return false;
  return (
    err.message.includes("category_label") &&
    (err.message.includes("schema cache") || err.message.includes("column"))
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Google Places
// ───────────────────────────────────────────────────────────────────────────

// Google Places (New) occasionally returns 5xx during regional hiccups.
// One retry with a short wait covers the typical transient case without
// adding meaningful latency on the happy path. The returned `error`
// shape is friendly (already classified) so the caller can surface it
// directly to the operator.
async function fetchGoogleDetails(
  placeId: string,
  apiKey: string,
): Promise<GoogleDetails | { error: string; transient: boolean }> {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=es-MX&regionCode=MX`;
  const doFetch = () =>
    fetch(url, {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": GOOGLE_FIELD_MASK,
      },
    });

  let r = await doFetch();
  if (r.status >= 500 && r.status < 600) {
    await new Promise((res) => setTimeout(res, 800));
    r = await doFetch();
  }

  if (!r.ok) {
    const text = await r.text();
    const transient = r.status >= 500 && r.status < 600;
    const friendly = transient
      ? "Google Places is temporarily unavailable. Try again in a few seconds."
      : r.status === 429
        ? "Google Places rate-limited the request. Try again in a moment."
        : r.status === 404
          ? "Google couldn't find that place. Try searching again."
          : `Google rejected the request (${r.status}). ${text.slice(0, 160)}`;
    return { error: friendly, transient };
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
// Google Custom Search — image search
// ───────────────────────────────────────────────────────────────────────────
//
// Why this exists: Google Places returns 10 photos at best, mostly
// user-uploaded reviews — low-res, badly lit, weird angles. Custom Search
// over the open web pulls marketing-grade shots from press, blogs, IG
// mirrors, etc. Quality dominates on average.
//
// Setup notes (one-time):
//   1. Cloud Console → enable "Custom Search API" on a project.
//   2. Create an API key restricted to that API.
//   3. https://cse.google.com → create a new Programmable Search Engine
//      with "Search the entire web" enabled and "Image search" turned on.
//      Copy the CX (engine) ID.
//   4. supabase secrets set:
//        GOOGLE_CSE_SUPABASE_API_KEY=<api key>
//        GOOGLE_CSE_ID=<cx>
//
// Cost: 100 free queries/day, then $5/1000. We call this once per
// create_unit invocation, so a small venue rollout stays well inside
// the free tier; a city-wide push needs the paid tier billed monthly.
//
// Returns `[]` (gracefully) when either secret is missing or the API
// errors. Photos from other sources still flow through.
async function fetchCseImages(
  venueName: string,
  city: string | null,
  country: string | null,
  apiKey: string | undefined,
  cseId: string | undefined,
): Promise<string[]> {
  if (!apiKey || !cseId) return [];
  // Build a city-scoped query so 'La Casa' in Monterrey doesn't pull
  // photos of 'La Casa' in Madrid.
  const parts = [venueName];
  if (city) parts.push(city);
  if (country && country !== city) parts.push(country);
  const q = parts.join(" ");
  // num=10 is the max per request. Order by relevance (default).
  const url =
    "https://www.googleapis.com/customsearch/v1" +
    `?key=${encodeURIComponent(apiKey)}` +
    `&cx=${encodeURIComponent(cseId)}` +
    `&q=${encodeURIComponent(q)}` +
    "&searchType=image" +
    "&num=10" +
    "&safe=active" +
    "&imgSize=large";
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const d = (await r.json()) as {
      items?: { link?: string; mime?: string }[];
    };
    if (!d.items) return [];
    return d.items
      .filter(
        (it) =>
          typeof it.link === "string" &&
          it.link.startsWith("https://") &&
          // Drop obvious non-photo formats. CSE sometimes returns SVG /
          // ICO from logos which we don't want as venue covers.
          !/\.(svg|ico)(\?|$)/i.test(it.link) &&
          (it.mime ? it.mime.startsWith("image/") : true),
      )
      .map((it) => it.link!) as string[];
  } catch {
    return [];
  }
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


// Score-and-pick over every email in the Firecrawl markdown.
//
// Why scoring vs. "first match wins": venue pages often include a
// developer's personal gmail in attribution somewhere ("site by
// jdoe@gmail.com") long before the venue's own contact address. We
// prefer the one most likely to belong to the venue: on-domain >
// generic provider (gmail/hotmail/etc., which small venues do run on)
// > anything else. Junk patterns (noreply, sentry, wix placeholders)
// are rejected outright.
//
// `websiteUrl` is the venue's primary website; passing null skips the
// on-domain bonus and falls back to free-provider preference.
function extractEmailFromMarkdown(
  md: string | null,
  websiteUrl: string | null,
): string | null {
  if (!md) return null;
  const re = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  let best: { email: string; score: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const email = m[0].toLowerCase();
    if (isJunkEmail(email)) continue;
    const score = scoreEmail(email, websiteUrl);
    if (!best || score > best.score) best = { email, score };
  }
  return best?.email ?? null;
}

function isJunkEmail(email: string): boolean {
  if (email.startsWith("noreply@")) return true;
  if (email.startsWith("no-reply@")) return true;
  if (email.endsWith("@example.com")) return true;
  if (email.endsWith("@sentry.io")) return true;
  if (email.endsWith("@wixpress.com")) return true;
  if (email.endsWith("@wordpress.com")) return true;
  return false;
}

// Higher is better. On-domain wins because it qualifies the venue for
// the ai_email auto-verify path; free-provider is the small-venue
// reality (info@venue.mx is rare, info.venue@gmail.com common).
function scoreEmail(email: string, websiteUrl: string | null): number {
  if (websiteUrl && isOnDomain(email, websiteUrl)) return 100;
  const at = email.indexOf("@");
  if (at >= 0 && FREE_EMAIL_PROVIDERS.has(email.slice(at + 1))) return 50;
  return 1;
}

const FREE_EMAIL_PROVIDERS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "outlook.com",
  "yahoo.com",
  "yahoo.com.mx",
  "icloud.com",
  "live.com",
  "live.com.mx",
  "msn.com",
  "protonmail.com",
  "proton.me",
]);

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
  // Keep footer + header chrome (onlyMainContent:false): venue contact details
  // (email, phone, social icons) almost always live in the footer. Firecrawl
  // bills per page, so the extra bytes are free.
  const scraped = await firecrawlScrape(apiKey, websiteUri, {
    formats: ["markdown", "links"],
    onlyMainContent: false,
    excludeTags: ["nav"],
    timeout: 20000,
  });
  if (!scraped) return null;
  return {
    markdown: scraped.markdown.slice(0, 16000),
    links: scraped.links.slice(0, 40),
  };
}

// Best-effort scrape of an Instagram profile page to extract follower
// count. Returns null on anything that goes wrong — missing key, missing
// URL, Firecrawl error, IG blocking the bot, regex miss. The Signals tile
// already renders a "couldn't pull this" note in that case.
//
// Why this exists separately from fetchFirecrawl: that helper rejects
// social URLs deliberately (homepage scrape isn't the right input for
// an Instagram timeline). For follower count we DO want the Instagram
// page itself, so we wrap a parallel Firecrawl call here.
async function fetchInstagramFollowers(
  igUrl: string | null,
  apiKey: string | undefined,
): Promise<number | null> {
  if (!igUrl || !apiKey) return null;
  const scraped = await firecrawlScrape(apiKey, igUrl, {
    formats: ["markdown"],
    onlyMainContent: false,
    timeout: 15000,
  });
  if (!scraped) return null;
  return parseInstagramFollowers(scraped.markdown);
}

// Pulls a follower count out of an Instagram profile markdown dump. The
// canonical place is the og:description meta — "X Followers, Y Following,
// Z Posts" — which Firecrawl renders as plain text. We also accept the
// "X Followers" snippet that appears in-page on the profile header.
// Returns null when nothing recognisable shows up.
export function parseInstagramFollowers(markdown: string): number | null {
  if (!markdown) return null;
  // Match "12.3K Followers", "12,345 Followers", "1.2M Followers", etc.
  // Look for the first occurrence so the og:description "X Followers, Y
  // Following" pattern wins over any noisy in-body matches.
  const m = markdown.match(/([\d][\d.,]*\s*[KkMm]?)\s*Followers/);
  if (!m) return null;
  let raw = m[1].trim().toLowerCase().replace(/,/g, "");
  let mult = 1;
  if (raw.endsWith("k")) {
    mult = 1_000;
    raw = raw.slice(0, -1);
  } else if (raw.endsWith("m")) {
    mult = 1_000_000;
    raw = raw.slice(0, -1);
  }
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1e10) return null;
  return Math.round(n * mult);
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
  if (!apiKey) return synthFallback(input, "no OPENAI_KEY");

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
      console.error("[business-create-unit] openai HTTP", r.status, errText);
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
      console.error("[business-create-unit] openai parse", msg, content.slice(0, 200));
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
    console.error("[business-create-unit] openai exception", msg);
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

    // Same-day or overnight — both store as one range on the opening day.
    // For overnight, close ≤ open is the next-day-close signal the UI and
    // any time-window math read from. Splitting at midnight is what used
    // to make a 6pm–2am venue render as two confusing rows; one range
    // tells the truth in one place.
    pushRange(out, DAY_KEYS[oDay], openStr, closeStr);
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

function categoryLabelForSlug(
  categories: { slug: string; label: string }[],
  slug: string | null,
): string | null {
  if (!slug) return null;
  const trimmed = slug.trim();
  if (!trimmed) return null;
  const hit = categories.find((c) => c.slug === trimmed);
  return hit?.label ?? null;
}

function humanizeCategoryFallback(category: string | null): string | null {
  if (!category) return null;
  const trimmed = category.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

