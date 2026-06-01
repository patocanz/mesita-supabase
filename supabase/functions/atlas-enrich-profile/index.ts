// Supabase Edge Function — atlas-enrich-profile (artificial caller / agent)
//
// Atlas is THE caller/orchestrator for venue profile enrichment. The natural
// caller (business-create-unit) seeds the venue from Google Places, then hands
// it to this agent, which runs the full Atlas pipeline end to end:
//
//   ① SOURCES (tier-gated)   Perplexity channel discovery → Apify (Google Maps
//                            reviews+photos, Instagram, Facebook) → Firecrawl
//                            website. Google/Mesita = spine (always); the
//                            social/website/SERP layer is gated by tier ≥ 2.
//   ② IMAGE FUNNEL           gather per source → SAVE (pre-select, per-source
//                            caps, ≤50 total) → ANALYZE (vision describes each)
//                            → SORT (text model ranks by the experience rubric)
//                            → write the ordered photo set.
//   ③ SYNTHESIS              OpenAI "Research Backbone" — reads ONLY the gathered
//                            material (no web → can't drift) into the canonical
//                            profile JSON. Model from the 'synthesis quality' param.
//   ④ COST CAP               stop spending once the per-run USD cap is hit.
//
// CONFIG: every knob lives in app_settings and is read at run time (the DB is
// the single source of truth; callers don't pass overrides). Every source is
// best-effort and independent; whatever fails degrades to null.
//
// Agent contract: verify_jwt=false; requireInternalCaller gates the
// service-role bearer. Invoked by business-create-unit (on create) and
// admin-enrich-venue (re-run). Writes the venue row + enrichment_sources.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import {
  APIFY_ACTORS,
  instagramHandleFromUrl,
  runApifyActor,
} from "../_shared/apify.ts";
import { firecrawlScrape, firecrawlSearch } from "../_shared/firecrawl.ts";
import {
  domainOf,
  facebookPageFromUrl,
  pickChannel,
  pickFacebook,
  pickInstagram,
  pickWebsite,
  validHost,
} from "../_shared/channels.ts";
import { fetchVenueCategories, inferVenueCategory } from "../_shared/categories.ts";

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";
// sonar-pro searches harder than base sonar (which returns null too often on
// venues whose socials clearly exist). Perplexity is the FALLBACK candidate
// source — Firecrawl Search runs first.
const PERPLEXITY_MODEL = "sonar-pro";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Vision + sort always run on the cheap multimodal model — image work doesn't
// need the synthesis-quality tier (which governs only the profile text model).
const VISION_MODEL = "gpt-4o-mini";

// Synthesis model by the admin 'synthesis quality' param. Synthesis reads only
// the gathered source material (no web) — that's why it's OpenAI, not Perplexity
// (which would re-search and drift). GPT-5.x not yet on the API, so 'high' maps
// to the best available today.
const QUALITY_MODEL: Record<string, string> = {
  economy: "gpt-4o-mini",
  standard: "gpt-4o",
  high: "gpt-4o",
};

// Source steps beyond the Google/Mesita spine (Instagram, Facebook, Website,
// SERP) are all tier 2 in the Atlas catalog, so the whole social/website/SERP
// layer is gated by ceiling >= 2.
const SOCIAL_LAYER_TIER = 2;

// OpenTable (reservations) + UberEats (delivery) link resolution is tier 3 in
// the Atlas catalog, so it's gated by ceiling >= 3.
const RESERVATION_DELIVERY_TIER = 3;

// Hard ceiling on photos persisted to the venue, regardless of per-source caps.
// Safety ceiling on the gathered candidate pool before save (the real,
// source-independent save cap is atlas_save_total_images, applied at the end).
const PHOTO_CEILING = 50;

// Public bucket where ephemeral source images (Instagram, website) are
// re-hosted so the gallery survives the source URL expiring / hotlink-blocking.
const IMAGE_BUCKET = "venue-images";

// Rough per-call cost estimates (USD). Approximate but enough to make the
// per-run cap meaningful — it's a safety valve, not billing.
const COST = {
  compass: 0.05, // Apify Google Maps (reviews + images)
  instagram: 0.02, // Apify IG profile scraper
  // Identity verification of the IG candidate: the LLM judge plus, worst case,
  // a Perplexity fallback + a second IG scrape. Bundled into the IG reservation.
  instagramVerify: 0.04,
  facebook: 0.02, // Apify FB pages scraper
  firecrawl: 0.01, // Firecrawl scrape
  perplexity: 0.01, // Perplexity sonar / Serper
  synthesisEconomy: 0.005, // gpt-4o-mini synthesis
  synthesisStandard: 0.03, // gpt-4o synthesis
  visionPerImage: 0.002, // gpt-4o-mini vision, one image (detail:low)
  sort: 0.003, // gpt-4o-mini text sort
} as const;

type Body = { venue_id?: string };

// Atlas writes a venue description at most this long. The column + the
// business Place editor accept up to 2000 chars; Atlas fills the first half
// and leaves the business room to expand it.
const ATLAS_DESCRIPTION_MAX = 1000;

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    zone: { type: ["string", "null"] },
    city: { type: ["string", "null"] },
    established_year: { type: ["integer", "null"] },
    executive_chef: { type: ["string", "null"] },
    editorial_summary: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    details: {
      type: "object",
      properties: {
        dining_style: { type: ["string", "null"] },
        dress_code: { type: ["string", "null"] },
        service_options: { type: "array", items: { type: "string" } },
        reservations: { type: ["string", "null"] },
        payment_methods: { type: "array", items: { type: "string" } },
        parking: { type: ["string", "null"] },
        amenities: { type: "array", items: { type: "string" } },
        accessibility: { type: "array", items: { type: "string" } },
        dietary_options: { type: "array", items: { type: "string" } },
        good_for: { type: "array", items: { type: "string" } },
        languages: { type: "array", items: { type: "string" } },
        kid_friendly: { type: ["boolean", "null"] },
        pet_friendly: { type: ["boolean", "null"] },
      },
    },
    menus: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                price: { type: ["string", "null"] },
                description: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
    popular_times: {
      type: "array",
      items: {
        type: "object",
        properties: {
          day: { type: "string" },
          range: { type: "string" },
        },
      },
    },
  },
} as const;

const CHANNELS_SCHEMA = {
  type: "object",
  properties: {
    instagram_url: { type: ["string", "null"] },
    facebook_url: { type: ["string", "null"] },
    website_url: { type: ["string", "null"] },
  },
} as const;

const DELIVERY_CHANNELS_SCHEMA = {
  type: "object",
  properties: {
    opentable_url: { type: ["string", "null"] },
    uber_eats_url: { type: ["string", "null"] },
  },
} as const;

type ProfileResult = {
  zone?: string | null;
  city?: string | null;
  established_year?: number | null;
  executive_chef?: string | null;
  editorial_summary?: string | null;
  description?: string | null;
  details?: Record<string, unknown> | null;
  menus?: unknown[] | null;
  popular_times?: unknown[] | null;
};

// One photo candidate + which source it came from (drives the per-source
// analyze caps in the funnel).
type Img = { url: string; source: "google" | "website" | "instagram" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const callerRes = requireInternalCaller(req, envRes.env);
  if (!callerRes.ok) return callerRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const venueId = (body.venue_id ?? "").toString().trim();
  if (!venueId) return json({ ok: false, error: "venue_id is required" }, 400);

  const admin = adminClient(envRes.env);
  const { data: row } = await admin
    .from("venues")
    .select(
      "name, address, city, category, instagram_url, facebook_url, website_url, google_place_id, google_stars_overall, google_review_count, editorial_summary, photos",
    )
    .eq("id", venueId)
    .maybeSingle();
  if (!row) return json({ ok: false, error: "Venue not found" }, 404);

  // ── Admin config (app_settings) ──────────────────────────────────────────
  // The Atlas admin console tunes these. The agent reads them at run time;
  // callers don't pass overrides (the DB is the single source of truth).
  const { data: cfg } = await admin
    .from("app_settings")
    .select(
      [
        "atlas_source_tier_ceiling",
        "atlas_synthesis_quality",
        "atlas_gather_google_images",
        "atlas_gather_website_images",
        "atlas_gather_instagram_posts",
        "atlas_save_total_images",
        "atlas_image_vision_enabled",
        "atlas_analyze_google_images",
        "atlas_analyze_website_images",
        "atlas_analyze_instagram_images",
        "atlas_image_analysis_prompt",
        "atlas_image_sorting_prompt",
        "atlas_per_run_cost_cap_usd",
        "atlas_website_crawl_max_pages",
      ].join(", "),
    )
    .eq("id", 1)
    .maybeSingle();

  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const tierCeiling = num(cfg?.atlas_source_tier_ceiling, 3);
  const synthesisQuality =
    (cfg?.atlas_synthesis_quality as string | undefined) ?? "economy";
  // GATHER caps — how many to PULL per source before anything else.
  const gatherGoogleImages = num(cfg?.atlas_gather_google_images, 10);
  const gatherWebsiteImages = num(cfg?.atlas_gather_website_images, 10);
  const gatherInstagramPosts = num(cfg?.atlas_gather_instagram_posts, 10);
  // How many website pages to crawl for images (homepage + internal links).
  const websiteCrawlMaxPages = Math.max(1, num(cfg?.atlas_website_crawl_max_pages, 5));
  // SAVE cap — final count persisted to the venue, SOURCE-INDEPENDENT, applied
  // after analyze + rubric sort.
  const saveTotalImages = num(cfg?.atlas_save_total_images, 20);
  const visionEnabled = (cfg?.atlas_image_vision_enabled as boolean) ?? true;
  // ANALYZE caps — how many of the gathered images per source go to vision.
  const analyzeGoogleImages = num(cfg?.atlas_analyze_google_images, 10);
  const analyzeWebsiteImages = num(cfg?.atlas_analyze_website_images, 10);
  const analyzeInstagramImages = num(cfg?.atlas_analyze_instagram_images, 10);
  const imageAnalysisPrompt =
    (cfg?.atlas_image_analysis_prompt as string | undefined)?.trim() ||
    "Describe this venue photo: subject (ambiance / interior / exterior / food / people / detail), visual quality, lighting, and whether it is representative and appealing. Be concise and factual.";
  const imageSortingPrompt =
    (cfg?.atlas_image_sorting_prompt as string | undefined)?.trim() ||
    "Rank these venue photos best to worst for a should-we-go-tonight decision. We sell EXPERIENCES: weight beautiful place / ambiance / vibe shots EQUALLY with food. Favor visual quality, representativeness, and a balanced mix. Drop duplicates, blurry, dark, or text-heavy images.";
  const costCapUsd = num(Number(cfg?.atlas_per_run_cost_cap_usd), 1.0) || 1.0;
  // Whole social/website layer runs only when the ceiling allows tier 2.
  const socialLayer = tierCeiling >= SOCIAL_LAYER_TIER;
  // OpenTable + UberEats link resolution runs only when the ceiling allows tier 3.
  const reservationDeliveryLayer = tierCeiling >= RESERVATION_DELIVERY_TIER;

  const PERPLEXITY_KEY = Deno.env.get("PERPLEXITY_KEY");
  const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
  const APIFY_KEY = Deno.env.get("APIFY_KEY");
  const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_KEY");

  const sources: Record<string, unknown> = {};
  const update: Record<string, unknown> = { enriched_at: new Date().toISOString() };

  // ── Cost cap ────────────────────────────────────────────────────────────────
  // Reserve budget BEFORE running each step, in priority order. A step that
  // doesn't fit the remaining budget is disabled (skipped) — so the run never
  // exceeds the per-run USD cap.
  let plannedUsd = 0;
  const cost: Record<string, number> = {};
  const reserve = (label: string, c: number): boolean => {
    if (plannedUsd + c > costCapUsd) return false;
    plannedUsd += c;
    cost[label] = c;
    return true;
  };

  // ── Channel discovery ────────────────────────────────────────────────────
  // The columns may already carry socials harvested from the venue's website
  // at create time. For any channel still missing, ask Perplexity to resolve
  // the canonical URL from search, then host-validate it before trusting it.
  let resolvedInstagram =
    typeof row.instagram_url === "string" && row.instagram_url
      ? row.instagram_url
      : null;
  let resolvedFacebook =
    typeof row.facebook_url === "string" && row.facebook_url
      ? row.facebook_url
      : null;
  let resolvedWebsite =
    typeof row.website_url === "string" && row.website_url
      ? row.website_url
      : null;
  let resolvedOpenTable =
    typeof row.opentable_url === "string" && row.opentable_url
      ? row.opentable_url
      : null;
  let resolvedUberEats =
    typeof row.uber_eats_url === "string" && row.uber_eats_url
      ? row.uber_eats_url
      : null;

  // Synthesis is core — reserve it first so the profile always gets written.
  const synthCost =
    synthesisQuality === "economy"
      ? COST.synthesisEconomy
      : COST.synthesisStandard;
  const runSynthesis = !!OPENAI_KEY && reserve("synthesis", synthCost);

  // Run discovery whenever a channel is still missing.
  const needsDiscovery =
    socialLayer &&
    (!!FIRECRAWL_KEY || !!PERPLEXITY_KEY) &&
    (!resolvedInstagram ||
      !resolvedFacebook ||
      !resolvedWebsite ||
      (reservationDeliveryLayer && (!resolvedOpenTable || !resolvedUberEats)));
  const runDiscovery = needsDiscovery && reserve("discovery", COST.perplexity);

  if (runDiscovery) {
    // Channel links resolve in the Atlas order: whatever Google already gave
    // us (passed in via `have`) → Firecrawl Search on "<name> <city> <network>"
    // → Perplexity as the last-resort fallback. Each result is host-validated
    // and normalised to the canonical profile URL before we trust it.
    const found = await resolveChannels({
      firecrawlKey: FIRECRAWL_KEY,
      perplexityKey: PERPLEXITY_KEY,
      name: row.name as string,
      city: (row.city as string | null) ?? null,
      locationLine: [row.address, row.city].filter(Boolean).join(", "),
      category: (row.category as string | null) ?? null,
      resolveReservationDelivery: reservationDeliveryLayer,
      have: {
        instagram: resolvedInstagram,
        facebook: resolvedFacebook,
        website: resolvedWebsite,
        opentable: resolvedOpenTable,
        uberEats: resolvedUberEats,
      },
    });
    if (!resolvedInstagram && found.instagram_url) resolvedInstagram = found.instagram_url;
    if (!resolvedFacebook && found.facebook_url) resolvedFacebook = found.facebook_url;
    if (!resolvedWebsite && found.website_url) resolvedWebsite = found.website_url;
    if (reservationDeliveryLayer) {
      if (!resolvedOpenTable && found.opentable_url) resolvedOpenTable = found.opentable_url;
      if (!resolvedUberEats && found.uber_eats_url) resolvedUberEats = found.uber_eats_url;
    }
    sources.discovery = {
      ok: true,
      via: found.via,
      instagram: !!resolvedInstagram,
      facebook: !!resolvedFacebook,
      website: !!resolvedWebsite,
      opentable: !!resolvedOpenTable,
      ubereats: !!resolvedUberEats,
    };
  }

  // Persist any newly resolved channel so future reads + re-runs have them.
  // NOTE: instagram_url is deliberately NOT persisted here — for a generic
  // name the searched candidate may be a different same-named account, so we
  // only persist it AFTER the IG scrape verifies it belongs to this venue
  // (see the Instagram gather step below).
  if (resolvedFacebook && resolvedFacebook !== row.facebook_url) {
    update.facebook_url = resolvedFacebook;
  }
  if (resolvedWebsite && resolvedWebsite !== row.website_url) {
    update.website_url = resolvedWebsite;
  }
  // OpenTable + UberEats are host-validated directory links (no per-venue
  // identity check the way Instagram needs), so they persist straight away.
  if (resolvedOpenTable && resolvedOpenTable !== row.opentable_url) {
    update.opentable_url = resolvedOpenTable;
  }
  if (resolvedUberEats && resolvedUberEats !== row.uber_eats_url) {
    update.uber_eats_url = resolvedUberEats;
  }

  const igHandle = instagramHandleFromUrl(resolvedInstagram);
  // A Facebook page slug is a strong Instagram-handle candidate: venues almost
  // always reuse the same handle across networks (fb.com/Stranasanpedro ⇒ try
  // instagram.com/Stranasanpedro). profile.php?id= pages and anything with
  // non-handle characters are rejected so we never feed Apify junk.
  const fbHandleCandidate = fbSlugCandidate(resolvedFacebook);
  const placeId =
    typeof row.google_place_id === "string" ? row.google_place_id : null;

  // ── Reserve budget for the gather steps (priority: reviews → IG → website →
  //    vision → FB). Anything that doesn't fit is skipped. ───────────────────
  const runReviews =
    !!APIFY_KEY && !!placeId && reserve("apify_google", COST.compass);
  // Run IG whenever we have ANY way to reach a candidate — not only a handle
  // Google/Firecrawl already resolved. A no-website venue (e.g. a nightclub)
  // often isn't surfaced by Firecrawl's IG search, but its Facebook slug or a
  // Perplexity lookup still gets us there. Every candidate is verify-gated
  // below, so widening the gate never attaches a wrong account.
  const canDiscoverIg = !!igHandle || !!fbHandleCandidate || !!PERPLEXITY_KEY;
  const runInstagram =
    socialLayer && !!APIFY_KEY && canDiscoverIg &&
    reserve("apify_instagram", COST.instagram + COST.instagramVerify);
  const runWebsite =
    socialLayer && !!FIRECRAWL_KEY && !!resolvedWebsite &&
    reserve("firecrawl", COST.firecrawl * websiteCrawlMaxPages + COST.sort);
  const maxVisionImages = visionEnabled
    ? analyzeGoogleImages + analyzeWebsiteImages + analyzeInstagramImages
    : 0;
  const runVision =
    visionEnabled &&
    !!OPENAI_KEY &&
    maxVisionImages > 0 &&
    reserve("vision", maxVisionImages * COST.visionPerImage + COST.sort);
  const runFacebook =
    socialLayer && !!APIFY_KEY && !!resolvedFacebook && reserve("apify_facebook", COST.facebook);

  // ── Gather (concurrent) ──────────────────────────────────────────────────
  // Run the live fetches that weren't budget-capped.
  let igBio = "";
  let igFollowers: number | null = null;
  let fbFollowers: number | null = null;
  let fbRating: number | null = null;
  let siteMarkdown = "";
  let googleReviewsText = "";
  let reviews: Record<string, unknown>[] = [];
  let reviewCount: number | null = null;
  let googleImages: string[] = [];
  let websiteImages: string[] = [];
  let instagramImages: string[] = [];
  // Only set once the scraped IG profile verifies as THIS venue's account.
  let verifiedInstagramUrl: string | null = null;

  await Promise.all([
    // Apify Google Maps → ALL reviews (Places caps at ~5) + venue PHOTOS in one
    // run. Spine-tier. maxImages drives the Google image bucket; reviews capped
    // at 100 for the EF wall-clock (a safety bound, not a product cap).
    (async () => {
      if (!runReviews) return;
      const items = await runApifyActor<Record<string, unknown>>(
        APIFY_ACTORS.googleMaps,
        {
          placeIds: [placeId],
          maxReviews: 100,
          maxImages: Math.max(0, gatherGoogleImages),
          language: "es",
          reviewsSort: "newest",
          reviewsPersonalData: true,
        },
        APIFY_KEY!,
        60000,
      );
      const p = items?.[0] as Record<string, unknown> | undefined;
      const raw = Array.isArray(p?.reviews) ? (p!.reviews as Record<string, unknown>[]) : [];
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
      reviews = raw
        .slice(0, 100)
        .map((r) => ({
          author: str(r.name) ?? str(r.reviewerName),
          rating: numOf(r.stars) ?? numOf(r.rating) ?? numOf(r.starRating),
          text: str(r.text) ?? str(r.textTranslated) ?? str(r.reviewText),
          published: str(r.publishedAtDate) ?? str(r.publishAt) ?? str(r.publishedAt),
        }))
        .filter((r) => r.text || r.rating != null);
      reviewCount = numOf(p?.reviewsCount);
      const withText = reviews.filter((r) => r.text);
      googleReviewsText = withText
        .slice(0, 12)
        .map((r) => `(${r.rating ?? "?"}★) ${r.text}`)
        .join("\n")
        .slice(0, 3000);
      // Google photos straight from the same run (durable lh3 URLs).
      const imgs = Array.isArray(p?.imageUrls) ? (p!.imageUrls as unknown[]) : [];
      googleImages = imgs
        .filter((u): u is string => typeof u === "string" && u.startsWith("http"))
        .slice(0, gatherGoogleImages);
      sources.apify_google_reviews = {
        ok: reviews.length > 0,
        count: reviews.length,
        with_text: withText.length,
        images: googleImages.length,
        sample_keys: raw[0] ? Object.keys(raw[0]).slice(0, 25) : [],
      };
    })(),
    // Apify → Instagram: followers + bio + post IMAGES (top by likes).
    // IDENTITY-CHECKED but GENEROUS: we scrape the candidate and confirm it's
    // this venue's OR its brand's account (website-domain match, FB-slug
    // agreement, brand-name match, else a true-biased LLM judge) — a franchise's
    // single brand account is a valid result. We try candidates in order — the
    // Firecrawl/Google handle, then the Facebook slug reused as a handle, then a
    // Perplexity-resolved handle — and keep the first that passes. Only a
    // genuinely dead/nonexistent handle is dropped: a missing IG is the worse
    // miss, so when in doubt we attach the brand account rather than nothing.
    (async () => {
      if (!runInstagram) return;
      const venueCtx = {
        name: row.name as string,
        locationLine: [row.address, row.city].filter(Boolean).join(", "),
        website: resolvedWebsite,
        facebook: resolvedFacebook,
        category: (row.category as string | null) ?? null,
      };
      const tried = new Set<string>();
      // corroborateFb=true means the candidate was found INDEPENDENTLY (Firecrawl
      // /Google/Perplexity), so agreement with the Facebook slug is real
      // corroboration. The candidate we DERIVE from the Facebook slug can't use
      // FB to vouch for itself (circular), so that one must clear the website
      // match or the LLM judge instead.
      const attempt = async (handle: string | null, corroborateFb = true) => {
        if (!handle || tried.has(handle.toLowerCase())) return null;
        tried.add(handle.toLowerCase());
        const items = await runApifyActor<Record<string, unknown>>(
          APIFY_ACTORS.instagramProfile,
          { usernames: [handle] },
          APIFY_KEY!,
        );
        const p = items?.[0];
        // For a NONEXISTENT handle the scraper still returns a non-null object —
        // the username echoed back with every data field null/empty. Treat that
        // empty stub as not-found so a dead handle (e.g. a guessed FB-slug that
        // isn't a real IG account) never reaches the identity judge and gets
        // falsely "verified". A real venue account always has at least followers.
        if (!p || isDeadIgStub(p)) return null;
        const ok = await igProfileMatchesVenue(p, venueCtx, OPENAI_KEY, corroborateFb);
        return { handle, p, ok };
      };

      // 1) The Firecrawl/Google candidate (independent → FB corroboration ok).
      let chosen = await attempt(igHandle);
      // 2) The Facebook slug reused as an IG handle. Derived from FB, so it
      //    can't corroborate via FB — it leans on the website match / judge.
      if (!chosen?.ok) {
        const alt = await attempt(fbHandleCandidate, false);
        chosen = alt?.ok ? alt : (chosen ?? alt);
      }
      // 3) Last resort: ask Perplexity for the right account + verify it.
      if (!chosen?.ok && PERPLEXITY_KEY) {
        const pp = await discoverChannelsPerplexity(
          PERPLEXITY_KEY,
          venueCtx.name,
          venueCtx.locationLine,
          venueCtx.category,
        );
        const alt = await attempt(instagramHandleFromUrl(pp?.instagram_url ?? null));
        chosen = alt?.ok ? alt : (chosen ?? alt);
      }

      if (chosen?.ok) {
        const p = chosen.p;
        verifiedInstagramUrl = `https://www.instagram.com/${chosen.handle}`;
        igFollowers = numOf(p.followersCount);
        if (typeof p.biography === "string") igBio = p.biography;
        const posts = Array.isArray(p.latestPosts)
          ? (p.latestPosts as Record<string, unknown>[])
          : [];
        instagramImages = posts
          // Videos are kept: their `displayUrl` is the cover frame, so we
          // analyze it as a photo rather than dropping the post.
          .filter(
            (po) =>
              typeof po.displayUrl === "string" &&
              (po.displayUrl as string).startsWith("http"),
          )
          .sort((a, b) => (numOf(b.likesCount) ?? 0) - (numOf(a.likesCount) ?? 0))
          .slice(0, gatherInstagramPosts)
          .map((po) => po.displayUrl as string);
        sources.apify_instagram = {
          handle: chosen.handle,
          ok: true,
          verified: true,
          posts: posts.length,
          images: instagramImages.length,
        };
      } else {
        // No account passed identity verification — attach nothing.
        sources.apify_instagram = {
          ok: false,
          reason: chosen ? "unverified" : "not_found",
          candidate: igHandle ?? fbHandleCandidate,
          tried: [...tried],
        };
      }
    })(),
    // Apify → Facebook (followers + rating).
    (async () => {
      if (!runFacebook) return;
      const items = await runApifyActor<Record<string, unknown>>(
        APIFY_ACTORS.facebookPages,
        { startUrls: [{ url: resolvedFacebook }] },
        APIFY_KEY!,
      );
      const p = items?.[0];
      if (p) {
        fbFollowers = numOf(p.followers) ?? numOf(p.likes);
        const rating = numOf(p.rating) ?? numOf(p.overallStarRating);
        if (rating != null && rating >= 0 && rating <= 5) fbRating = rating;
        sources.apify_facebook = { ok: true };
      } else {
        sources.apify_facebook = { ok: false };
      }
    })(),
    // Firecrawl → website markdown (menu grounding) + website IMAGES.
    // Crawl up to N pages (homepage + internal links), collect EVERY <img>
    // with its alt/dimensions/page context, then ask an LLM to rank them
    // hero-first (square dimensions prioritised; logos/icons/sprites dropped),
    // and keep the gather cap.
    (async () => {
      if (!runWebsite) return;
      try {
        const home = await firecrawlScrape(FIRECRAWL_KEY, resolvedWebsite!, {
          formats: ["markdown", "html", "links"],
          onlyMainContent: false,
        });
        if (!home) {
          sources.firecrawl = { ok: false };
          return;
        }
        siteMarkdown = home.markdown.slice(0, 6000);

        const candidates: WebImage[] = [];
        const seen = new Set<string>();
        const collect = (imgs: WebImage[]) => {
          for (const img of imgs) {
            if (!seen.has(img.url) && candidates.length < 60) {
              seen.add(img.url);
              candidates.push(img);
            }
          }
        };
        const og = home.metadata.ogImage;
        if (typeof og === "string") collect([{ url: og, alt: "og:image", page: "home" }]);
        collect(extractImagesFromHtml(home.html ?? "", resolvedWebsite!, "home"));

        // Follow up to (N-1) same-domain internal pages, scraped in parallel.
        const extraPages = pickInternalPages(home.links, resolvedWebsite!, websiteCrawlMaxPages - 1);
        if (extraPages.length > 0) {
          const scrapes = await Promise.all(
            extraPages.map((p) =>
              firecrawlScrape(FIRECRAWL_KEY, p, { formats: ["html"], onlyMainContent: false }),
            ),
          );
          scrapes.forEach((s, i) => {
            if (s) collect(extractImagesFromHtml(s.html ?? "", extraPages[i], `p${i + 1}`));
          });
        }

        const ranked = await rankWebsiteImagesByRelevance(OPENAI_KEY, candidates);
        websiteImages = ranked.slice(0, gatherWebsiteImages);
        sources.firecrawl = {
          ok: !!siteMarkdown,
          pages: 1 + extraPages.length,
          candidates: candidates.length,
          images: websiteImages.length,
        };
      } catch {
        sources.firecrawl = { ok: false };
      }
    })(),
  ]);

  // Persist the numeric source facts.
  if (reviews.length > 0) {
    update.google_reviews = reviews;
    if (reviewCount != null) update.google_review_count = reviewCount;
  }
  if (igFollowers != null) update.instagram_followers_count = igFollowers;
  if (fbFollowers != null) update.facebook_followers = fbFollowers;
  if (fbRating != null) update.facebook_rating = fbRating;
  // Persist instagram_url ONLY if the scrape verified it belongs to this venue.
  if (verifiedInstagramUrl && verifiedInstagramUrl !== row.instagram_url) {
    update.instagram_url = verifiedInstagramUrl;
  }

  // ── Re-host ephemeral images (durable gallery) ───────────────────────────
  // Instagram CDN URLs expire (signed) and some website images hotlink-block;
  // download + re-upload them to the public venue-images bucket so the gallery
  // survives. Best-effort per image — a failed mirror keeps the original URL.
  // Already-mirrored URLs are skipped inside the helper.
  // Google's lh3 photo URLs are stable, so they're left direct.
  const mirrorBefore = instagramImages.length + websiteImages.length;
  if (mirrorBefore > 0) {
    [instagramImages, websiteImages] = await Promise.all([
      mirrorImages(admin, envRes.env.url, venueId, instagramImages, "ig"),
      mirrorImages(admin, envRes.env.url, venueId, websiteImages, "web"),
    ]);
    const mirrored = [...instagramImages, ...websiteImages].filter((u) =>
      u.includes(`/${IMAGE_BUCKET}/`)
    ).length;
    sources.image_mirror = { candidates: mirrorBefore, mirrored };
  }

  // ── Image funnel: build the gathered pool (post metadata-sort) ───────────
  // Each source contributes its gather-capped, metadata-sorted bucket (Google
  // in Google's order, Website by size, Instagram by likes). business-create-
  // unit may have seeded Places photos into row.photos — fold those into the
  // Google bucket so we never lose them, capped at the Google GATHER cap.
  const existingPhotos = Array.isArray(row.photos) ? (row.photos as string[]) : [];
  const googleBucket = dedup([...googleImages, ...existingPhotos]).slice(
    0,
    gatherGoogleImages,
  );
  const saved: Img[] = [];
  const savedSeen = new Set<string>();
  const pushImg = (url: string, source: Img["source"]) => {
    if (!url || savedSeen.has(url) || saved.length >= PHOTO_CEILING) return;
    savedSeen.add(url);
    saved.push({ url, source });
  };
  for (const u of googleBucket) pushImg(u, "google");
  for (const u of websiteImages) pushImg(u, "website");
  for (const u of instagramImages) pushImg(u, "instagram");

  // ── Image funnel: ANALYZE (vision) → SORT (text) → SAVE (top N) ──────────
  // Take the per-source analyze caps off the top of each metadata-sorted
  // bucket, have the vision model DESCRIBE each (image_analysis_prompt), then a
  // text model RANK those descriptions (image_sorting_prompt). The final SAVE
  // cap (saveTotalImages) is SOURCE-INDEPENDENT — keep the best N overall.
  let finalPhotos = saved.map((s) => s.url).slice(0, saveTotalImages);
  let funnelDiag: Record<string, unknown> = {
    gathered: saved.length,
    by_source: {
      google: saved.filter((s) => s.source === "google").length,
      website: saved.filter((s) => s.source === "website").length,
      instagram: saved.filter((s) => s.source === "instagram").length,
    },
    save_cap: saveTotalImages,
    vision: false,
  };
  if (runVision && saved.length > 1) {
    const caps: Record<Img["source"], number> = {
      google: analyzeGoogleImages,
      website: analyzeWebsiteImages,
      instagram: analyzeInstagramImages,
    };
    const used: Record<Img["source"], number> = { google: 0, website: 0, instagram: 0 };
    const toAnalyze: Img[] = [];
    for (const img of saved) {
      if (used[img.source] < caps[img.source]) {
        toAnalyze.push(img);
        used[img.source] += 1;
      }
    }
    if (toAnalyze.length > 0) {
      const descriptions = await visionDescribe(
        OPENAI_KEY!,
        toAnalyze.map((i) => i.url),
        imageAnalysisPrompt,
      );
      let order: number[] | null = null;
      if (descriptions) {
        order = await textSortImages(OPENAI_KEY!, descriptions, imageSortingPrompt);
      }
      if (order && order.length > 0) {
        const ranked = order
          .filter((i) => i >= 0 && i < toAnalyze.length)
          .map((i) => toAnalyze[i].url);
        const analyzedSet = new Set(toAnalyze.map((i) => i.url));
        const rest = saved.map((s) => s.url).filter((u) => !analyzedSet.has(u));
        // Rubric-ranked images lead; un-analyzed gathered images follow in
        // metadata order. Then keep only the top N overall (source-independent).
        finalPhotos = dedup([...ranked, ...rest]).slice(0, saveTotalImages);
        funnelDiag = {
          ...funnelDiag,
          vision: true,
          analyzed: toAnalyze.length,
          described: !!descriptions,
          sorted: true,
          saved: finalPhotos.length,
        };
      } else {
        funnelDiag = { ...funnelDiag, vision: true, analyzed: toAnalyze.length, sorted: false };
      }
    }
  }
  if (finalPhotos.length > 0) update.photos = finalPhotos;
  sources.image_funnel = funnelDiag;

  // ── OpenAI: grounded synthesis (Research Backbone) ───────────────────────
  if (!OPENAI_KEY) {
    return json({ ok: false, error: "OPENAI_KEY not configured" }, 500);
  }
  const synthesisModel = QUALITY_MODEL[synthesisQuality] ?? "gpt-4o-mini";
  const locationLine = [row.address, row.city].filter(Boolean).join(", ");
  const grounding = [
    igBio ? `Instagram bio: ${igBio}` : "",
    googleReviewsText ? `Google reviews (sample):\n${googleReviewsText}` : "",
    siteMarkdown ? `Website content (excerpt):\n${siteMarkdown}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const userPrompt =
    `Compile the public profile of the venue "${row.name}"` +
    (locationLine ? ` located at ${locationLine}` : "") +
    (row.category ? ` (category: ${row.category})` : "") +
    `, using ONLY the source material below. Return a single JSON object ` +
    `matching the schema. Extract the menu from the website content when ` +
    `present (real dish names + prices only). Write "description" as an ` +
    `inviting, factual 2-4 sentence venue description for the public Place ` +
    `page (max ${ATLAS_DESCRIPTION_MAX} characters), grounded in the sources. ` +
    `Use null or [] for anything the ` +
    `sources don't support. Never invent ratings, reviewer quotes, prices, or ` +
    `a chef's name.` +
    (grounding ? `\n\n--- SOURCE MATERIAL ---\n${grounding}` : "\n\n(No extra source material was gathered.)");

  const systemContent =
    "You are Mesita's venue-intelligence synthesis agent. Use ONLY the source " +
    "material the user provides — do not browse or use outside knowledge. " +
    "Output a SINGLE valid JSON object (no prose, no markdown fences) matching " +
    "this shape, using null or [] when the sources don't support a field: " +
    JSON.stringify(PROFILE_SCHEMA.properties) +
    " Never invent ratings, reviewer quotes, prices, or a chef's name.";

  let parsed: ProfileResult | null = null;
  if (runSynthesis) {
    try {
      const r = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: synthesisModel,
          temperature: 0.2,
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
        }),
      });
      if (r.ok) {
        const data = (await r.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        parsed = safeParseProfile(data.choices?.[0]?.message?.content ?? "");
        sources.synthesis = { provider: "openai", model: synthesisModel, ok: !!parsed };
      } else {
        sources.synthesis = {
          provider: "openai",
          model: synthesisModel,
          ok: false,
          status: r.status,
        };
      }
    } catch {
      sources.synthesis = { provider: "openai", model: synthesisModel, ok: false };
    }
  } else {
    sources.synthesis = { ok: false, reason: "cost_cap" };
  }

  if (parsed) {
    if (parsed.zone) update.zone = parsed.zone;
    if (parsed.city) update.city = parsed.city;
    if (typeof parsed.established_year === "number") {
      update.established_year = parsed.established_year;
    }
    if (parsed.executive_chef) update.executive_chef = parsed.executive_chef;
    if (parsed.editorial_summary) {
      update.editorial_summary = parsed.editorial_summary;
    }
    // The place's public description — written at the end of every run. Hard
    // cap at 1000 chars (the column/editor allow 2000; the business can expand
    // it). Only overwrite when synthesis actually produced text.
    if (parsed.description && parsed.description.trim()) {
      update.description = parsed.description.trim().slice(0, ATLAS_DESCRIPTION_MAX);
    }
    if (parsed.details && typeof parsed.details === "object") {
      update.details = parsed.details;
    }
    if (Array.isArray(parsed.menus) && parsed.menus.length > 0) {
      update.menus = parsed.menus;
    }
    if (Array.isArray(parsed.popular_times) && parsed.popular_times.length > 0) {
      update.popular_times = parsed.popular_times;
    }
  }

  // ── Category inference (dynamic, from the live venue_categories table) ───
  // Read the editable vocabulary at run time and let the classifier pick the
  // best-fit slug from it — never hardcoded. Prefers the freshly synthesised
  // editorial summary, falling back to the venue's existing signals + gathered
  // text. Only overwrites venue.category when we get a valid canonical slug.
  const categoryList = await fetchVenueCategories(admin);
  const inferredCategory = await inferVenueCategory(OPENAI_KEY, categoryList, {
    name: row.name as string,
    address: (row.address as string | null) ?? null,
    editorialSummary:
      (update.editorial_summary as string | undefined) ??
      (row.editorial_summary as string | null) ??
      null,
    description: igBio || siteMarkdown.slice(0, 1200) || null,
  });
  if (inferredCategory) update.category = inferredCategory;
  sources.category = {
    ok: !!inferredCategory,
    slug: inferredCategory,
    candidates: categoryList.length,
  };

  // ── Cost accounting ──────────────────────────────────────────────────────
  sources.cost = {
    cap_usd: costCapUsd,
    estimated_usd: Math.round(plannedUsd * 1000) / 1000,
    breakdown: cost,
  };
  update.enrichment_sources = sources;

  const { error: updErr } = await admin
    .from("venues")
    .update(update)
    .eq("id", venueId);
  if (updErr) {
    return json({ ok: false, error: `venue_update: ${updErr.message}` }, 500);
  }

  return json({
    ok: true,
    venue_id: venueId,
    sources,
    fields_filled: Object.keys(update).filter(
      (k) => k !== "enriched_at" && k !== "enrichment_sources",
    ),
    caller: callerRes.callerName,
  });
});

// ── Image funnel helpers ────────────────────────────────────────────────────

type WebImage = {
  url: string;
  alt: string;
  width?: number;
  height?: number;
  page: string;
};

// Pull every <img> out of a page's HTML with its alt + dimensions, resolved
// against the page URL. Skips data:/.svg (icons) and obvious tiny assets;
// dimensions come from width/height attrs, falling back to a WxH pattern in
// the URL. The LLM ranker does the real relevance filtering.
function extractImagesFromHtml(html: string, baseUrl: string, page: string): WebImage[] {
  if (!html) return [];
  const out: WebImage[] = [];
  const seen = new Set<string>();
  const tagRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null && out.length < 40) {
    const tag = m[0];
    const srcRaw =
      /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ??
      /\bdata-src\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ??
      /\bsrcset\s*=\s*["']([^"',\s]+)/i.exec(tag)?.[1];
    if (!srcRaw) continue;
    let url: string;
    try {
      url = new URL(srcRaw.trim(), baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(url)) continue;
    if (/\.svg(\?|$)/i.test(url)) continue;
    if (seen.has(url)) continue;
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.trim() ?? "";
    let width = toInt(/\bwidth\s*=\s*["']?(\d+)/i.exec(tag)?.[1]);
    let height = toInt(/\bheight\s*=\s*["']?(\d+)/i.exec(tag)?.[1]);
    if (width == null || height == null) {
      const dim = /(\d{2,4})x(\d{2,4})/.exec(url);
      if (dim) {
        width = width ?? Number(dim[1]);
        height = height ?? Number(dim[2]);
      }
    }
    // Drop tiny assets (icons, spacers, tracking pixels) when dims say so.
    if (width != null && height != null && (width < 60 || height < 60)) continue;
    seen.add(url);
    out.push({ url, alt, width: width ?? undefined, height: height ?? undefined, page });
  }
  return out;
}

function toInt(v: string | undefined): number | null {
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Choose up to `max` same-domain internal pages worth scraping for images,
// prioritising venue-relevant sections (gallery / menu / about / rooms…).
function pickInternalPages(links: string[], baseUrl: string, max: number): string[] {
  if (max <= 0) return [];
  let baseHost: string, basePath: string;
  try {
    const b = new URL(baseUrl);
    baseHost = b.hostname.replace(/^www\./, "");
    basePath = b.pathname.replace(/\/$/, "");
  } catch {
    return [];
  }
  const PRIORITY = /(galer|gallery|photo|foto|menu|carta|about|nosotros|space|salon|room|habitac|event|food|comida|drink|bar|restaurant)/i;
  const seen = new Set<string>();
  const scored: { url: string; score: number }[] = [];
  for (const raw of links) {
    let u: URL;
    try {
      u = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.hostname.replace(/^www\./, "") !== baseHost) continue;
    const path = u.pathname.replace(/\/$/, "");
    if (!path || path === basePath) continue;
    if (/\.(pdf|jpe?g|png|webp|gif|svg|zip|docx?|mp4)$/i.test(path)) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({ url: `${u.origin}${path}`, score: PRIORITY.test(path) ? 1 : 0 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.url);
}

// Ask a text LLM to rank the website's images hero-first. It only sees the
// metadata (filename, alt, dimensions, page) — no images are sent — so it's
// cheap. Square dimensions are prioritised; logos / icons / payment badges /
// social glyphs / tracking pixels are dropped to the bottom. Best-effort:
// on any failure the candidates keep their original (DOM) order.
async function rankWebsiteImagesByRelevance(
  openaiKey: string | undefined,
  images: WebImage[],
): Promise<string[]> {
  if (images.length <= 1 || !openaiKey) return images.map((i) => i.url);
  const list = images
    .map((img, i) => {
      const file = img.url.split("/").pop()?.split("?")[0] ?? img.url;
      const dims = img.width && img.height ? `${img.width}x${img.height}` : "unknown";
      return `${i}: file="${file}" alt="${img.alt.slice(0, 80)}" dims=${dims} page=${img.page}`;
    })
    .join("\n");
  const user =
    `These are all the images found on a venue's website (filename, alt text, ` +
    `dimensions, page). Rank them from MOST likely to be a hero / representative ` +
    `venue photo (the space, interior, exterior, food, ambiance) to LEAST. ` +
    `PRIORITISE roughly SQUARE dimensions when known. ALWAYS rank LAST anything ` +
    `whose filename or alt contains logo / icon / favicon / badge / sprite / ` +
    `pixel / avatar, plus payment-method glyphs, social glyphs, and heavily ` +
    `text-laden banners.\n\n${list}\n\n` +
    `Return a SINGLE JSON object {"order": [indices best-to-worst]} including ` +
    `every index exactly once. No prose.`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let r: Response;
    try {
      r = await fetch(OPENAI_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: VISION_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: user }],
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return images.map((i) => i.url);
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = (safeParseJson(data.choices?.[0]?.message?.content ?? "") as { order?: unknown })
      ?.order;
    if (!Array.isArray(raw)) return images.map((i) => i.url);
    const order: number[] = [];
    const seen = new Set<number>();
    for (const v of raw) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isInteger(n) && n >= 0 && n < images.length && !seen.has(n)) {
        order.push(n);
        seen.add(n);
      }
    }
    for (let i = 0; i < images.length; i++) if (!seen.has(i)) order.push(i);
    return order.map((i) => images[i].url);
  } catch {
    return images.map((i) => i.url);
  }
}

// Vision pass: describe each image with the admin analysis prompt. ONE call
// PER image, all fired CONCURRENTLY (Promise.all) — so each photo gets the
// model's full attention (sharper descriptions, no shared token budget) and a
// single bad image fails in isolation. Returns descriptions aligned to the
// input order; a failed/empty image yields "" so indices stay meaningful.
async function visionDescribe(
  openaiKey: string,
  urls: string[],
  prompt: string,
): Promise<string[] | null> {
  const describeOne = async (url: string): Promise<string> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const r = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: VISION_MODEL,
          temperature: 0,
          max_tokens: 200,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url, detail: "low" } },
              ],
            },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!r.ok) return "";
      const data = (await r.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return (data.choices?.[0]?.message?.content ?? "").trim();
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const descriptions = await Promise.all(urls.map((u) => describeOne(u)));
    // If every single call failed, treat the whole pass as failed so the
    // caller keeps the pre-vision order rather than sorting on empty strings.
    if (descriptions.every((d) => !d)) return null;
    return descriptions;
  } catch {
    return null;
  }
}

// Sort pass: a TEXT model ranks the (already-described) images best→worst by
// the admin sorting prompt. Returns indices into the descriptions array.
async function textSortImages(
  openaiKey: string,
  descriptions: string[],
  prompt: string,
): Promise<number[] | null> {
  const list = descriptions.map((d, i) => `${i}: ${d || "(no description)"}`).join("\n");
  const user =
    prompt +
    `\n\nImages (index: description):\n${list}\n\nReturn a SINGLE JSON object ` +
    `{"order": [indices best-to-worst]}. Include EVERY index exactly once; do ` +
    `not drop any. No prose, no fences.`;
  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0,
        messages: [{ role: "user", content: user }],
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const obj = safeParseJson(data.choices?.[0]?.message?.content ?? "");
    const raw = (obj as { order?: unknown })?.order;
    if (!Array.isArray(raw)) return null;
    const order: number[] = [];
    const seen = new Set<number>();
    for (const v of raw) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isInteger(n) && n >= 0 && n < descriptions.length && !seen.has(n)) {
        order.push(n);
        seen.add(n);
      }
    }
    // Append any indices the model dropped so we never lose an image.
    for (let i = 0; i < descriptions.length; i++) {
      if (!seen.has(i)) order.push(i);
    }
    return order;
  } catch {
    return null;
  }
}

// Download each image and re-upload to the public venue-images bucket, so the
// gallery survives the source URL expiring. Best-effort per image: any failure
// (bad fetch, non-image, too big, upload error) falls back to the original URL.
// URLs already hosted in our bucket are passed through untouched.
async function mirrorImages(
  admin: SupabaseClient,
  supabaseUrl: string,
  venueId: string,
  urls: string[],
  prefix: string,
): Promise<string[]> {
  if (urls.length === 0) return urls;
  // Bucket is provisioned by migration 0057 — no per-run create needed.
  const publicPath = `/storage/v1/object/public/${IMAGE_BUCKET}/`;
  return await Promise.all(
    urls.map(async (url, i) => {
      if (typeof url !== "string" || !url) return url;
      if (url.includes(publicPath)) return url; // already mirrored
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        let r: Response;
        try {
          r = await fetch(url, { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!r.ok) return url;
        const ct = r.headers.get("content-type") ?? "image/jpeg";
        if (!ct.startsWith("image/")) return url;
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > 8_000_000) return url;
        const ext = ct.includes("png")
          ? "png"
          : ct.includes("webp")
            ? "webp"
            : ct.includes("avif")
              ? "avif"
              : "jpg";
        const path = `${venueId}/${prefix}-${i}.${ext}`;
        const { error } = await admin.storage
          .from(IMAGE_BUCKET)
          .upload(path, bytes, { contentType: ct, upsert: true });
        if (error) return url;
        return `${supabaseUrl}${publicPath}${path}`;
      } catch {
        return url;
      }
    }),
  );
}

// ── Discovery + parsing helpers ─────────────────────────────────────────────

type Channels = {
  instagram_url: string | null;
  facebook_url: string | null;
  website_url: string | null;
};

// Resolve a venue's official channel URLs. Order (matches the Atlas catalog):
//   1. whatever Google already gave us (passed in via `have`)
//   2. Firecrawl Search on "<name> <city> <network>" — the strongest signal for
//      socials, since the canonical profile is almost always the top result
//   3. Perplexity — last-resort fallback for anything still missing
// Only missing channels are searched, and every candidate is normalised to the
// canonical profile URL + host-validated before we trust it.
async function resolveChannels(opts: {
  firecrawlKey?: string;
  perplexityKey?: string;
  name: string;
  city: string | null;
  locationLine: string;
  category: string | null;
  // Tier-3 OpenTable + UberEats resolution is opt-in: the caller only flips
  // this on when the venue's source-tier ceiling reaches 3.
  resolveReservationDelivery?: boolean;
  have: {
    instagram: string | null;
    facebook: string | null;
    website: string | null;
    opentable: string | null;
    uberEats: string | null;
  };
}): Promise<
  Channels & {
    opentable_url: string | null;
    uber_eats_url: string | null;
    via: Record<string, string>;
  }
> {
  let instagram = opts.have.instagram;
  let facebook = opts.have.facebook;
  let website = opts.have.website;
  let opentable = opts.have.opentable;
  let uberEats = opts.have.uberEats;
  const wantDelivery = opts.resolveReservationDelivery === true;
  const via: Record<string, string> = {};
  if (instagram) via.instagram = "google";
  if (facebook) via.facebook = "google";
  if (website) via.website = "google";
  if (opentable) via.opentable = "seed";
  if (uberEats) via.ubereats = "seed";

  const scope = [opts.name, opts.category ?? "", opts.city ?? ""]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");

  // 2. Firecrawl Search — simple, broad queries to avoid false negatives.
  if (opts.firecrawlKey) {
    const key = opts.firecrawlKey;
    const searchMany = async (queries: string[]) => {
      const runs = await Promise.all(queries.map((q) => firecrawlSearch(key, q, 6)));
      return dedup(runs.flat()).slice(0, 24);
    };
    const igQueries = [
      `${scope} oficial instagram`,
      `${scope} official instagram`,
      `${scope} instagram`,
    ];
    const fbQueries = [
      `${scope} oficial facebook`,
      `${scope} official facebook`,
      `${scope} facebook`,
    ];
    const webQueries = [
      `${scope} sitio oficial website`,
      `${scope} official website`,
      `${scope} website`,
    ];
    const otQueries = [
      `${scope} opentable`,
      `${scope} opentable reservation`,
      `${scope} reservaciones opentable`,
    ];
    const ueQueries = [
      `${scope} uber eats`,
      `${scope} ubereats`,
      `${scope} uber eats a domicilio`,
    ];
    const needOpenTable = wantDelivery && !opentable;
    const needUberEats = wantDelivery && !uberEats;
    const [igHits, fbHits, webHits, otHits, ueHits] = await Promise.all([
      instagram ? Promise.resolve<string[]>([]) : searchMany(igQueries),
      facebook ? Promise.resolve<string[]>([]) : searchMany(fbQueries),
      website ? Promise.resolve<string[]>([]) : searchMany(webQueries),
      needOpenTable ? searchMany(otQueries) : Promise.resolve<string[]>([]),
      needUberEats ? searchMany(ueQueries) : Promise.resolve<string[]>([]),
    ]);
    if (!instagram) {
      const hit = pickInstagram(igHits);
      if (hit) {
        instagram = hit;
        via.instagram = "firecrawl";
      }
    }
    if (!facebook) {
      const hit = pickFacebook(fbHits);
      if (hit) {
        facebook = hit;
        via.facebook = "firecrawl";
      }
    }
    if (!website) {
      const hit = pickWebsite(webHits);
      if (hit) {
        website = hit;
        via.website = "firecrawl";
      }
    }
    if (needOpenTable) {
      const hit = pickChannel(otHits, "opentable_url");
      if (hit) {
        opentable = hit;
        via.opentable = "firecrawl";
      }
    }
    if (needUberEats) {
      const hit = pickChannel(ueHits, "uber_eats_url");
      if (hit) {
        uberEats = hit;
        via.ubereats = "firecrawl";
      }
    }
  }

  // 3. Perplexity fallback — only if something's still missing.
  if (opts.perplexityKey && (!instagram || !facebook || !website)) {
    const pp = await discoverChannelsPerplexity(
      opts.perplexityKey,
      opts.name,
      opts.locationLine,
      opts.category,
    );
    if (pp) {
      if (!instagram && pp.instagram_url) {
        instagram = pp.instagram_url;
        via.instagram = "perplexity";
      }
      if (!facebook && pp.facebook_url) {
        facebook = pp.facebook_url;
        via.facebook = "perplexity";
      }
      if (!website && pp.website_url) {
        website = pp.website_url;
        via.website = "perplexity";
      }
    }
  }

  // 3b. Perplexity fallback for the tier-3 directory links, mirroring the
  // social fallback above. Separate call (distinct schema) so the social
  // resolution above is never perturbed by it.
  if (opts.perplexityKey && wantDelivery && (!opentable || !uberEats)) {
    const dd = await discoverDeliveryPerplexity(
      opts.perplexityKey,
      opts.name,
      opts.locationLine,
      opts.category,
    );
    if (dd) {
      if (!opentable && dd.opentable_url) {
        opentable = dd.opentable_url;
        via.opentable = "perplexity";
      }
      if (!uberEats && dd.uber_eats_url) {
        uberEats = dd.uber_eats_url;
        via.ubereats = "perplexity";
      }
    }
  }

  return {
    instagram_url: instagram,
    facebook_url: facebook,
    website_url: website,
    opentable_url: opentable,
    uber_eats_url: uberEats,
    via,
  };
}


// Perplexity fallback: resolve channel URLs from search. An LLM, so every URL
// it returns is host-validated before we trust it.
async function discoverChannelsPerplexity(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
): Promise<Channels | null> {
  const prompt =
    `Find the official online presence of the venue "${name}"` +
    (locationLine ? ` located at ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") +
    `. Return strict JSON with the canonical URLs of its Instagram profile, ` +
    `Facebook page, and website.\n` +
    `- instagram_url: give your BEST candidate even if not fully certain ` +
    `(it is independently verified afterwards). For a franchise or chain, the ` +
    `BRAND's main profile is a valid answer. Only null if you truly find none.\n` +
    `- facebook_url: give your BEST candidate — again, the brand's main page is ` +
    `fine for a chain. Only null if you truly find none.\n` +
    `- website_url: return your BEST likely official website candidate for this ` +
    `venue (or its brand). Use null only if you truly find none. Never invent a URL.\n` +
    `When names are ambiguous (example: "Strana"), use city/category to pick the ` +
    `most likely match, but prefer best plausible candidate over null.`;
  try {
    const r = await fetch(PERPLEXITY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You resolve a venue's official channel URLs from web search. Output only valid JSON matching the schema. For a franchise or multi-location brand, the brand's MAIN Instagram/Facebook/website is acceptable. Return best plausible candidates; use null only when you truly cannot find one. Never fabricate a URL out of thin air.",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { schema: CHANNELS_SCHEMA },
        },
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
      citations?: unknown[];
      search_results?: { url?: unknown }[];
    };
    // sonar-pro answers on two channels: the JSON content (its considered
    // answer) and the raw web hits it actually consulted (citations +
    // search_results). The model is conservative and frequently returns null
    // for a social profile it nonetheless surfaced in its sources — so when the
    // JSON is empty we mine those hit URLs. pickInstagram/pickFacebook are
    // host-locked to instagram.com/facebook.com, and the hits are specific to
    // THIS venue's query, so a social URL among them is almost certainly the
    // venue's. (Website is left JSON-only: a citation could be any news/blog
    // domain that pickWebsite can't tell apart from the real site.)
    const hitUrls: string[] = [];
    for (const c of data.citations ?? []) {
      if (typeof c === "string") hitUrls.push(c);
    }
    for (const s of data.search_results ?? []) {
      if (s && typeof s.url === "string") hitUrls.push(s.url);
    }
    const answer = (safeParseJson(data.choices?.[0]?.message?.content ?? "") as
      | { instagram_url?: unknown; facebook_url?: unknown; website_url?: unknown }
      | null) ?? {};
    const instagram_url =
      pickInstagram([String(answer.instagram_url ?? "")]) ??
      validHost(answer.instagram_url, ["instagram.com"]) ??
      pickInstagram(hitUrls);
    const facebook_url =
      facebookPageFromUrl(String(answer.facebook_url ?? "")) ??
      validHost(answer.facebook_url, ["facebook.com", "fb.com"]) ??
      pickFacebook(hitUrls);
    const website_url = validHost(answer.website_url, null);
    if (!instagram_url && !facebook_url && !website_url) return null;
    return { instagram_url, facebook_url, website_url };
  } catch {
    return null;
  }
}


// Perplexity fallback for the tier-3 directory links (OpenTable reservations +
// UberEats delivery). Same host-locked discipline as the social fallback:
// every candidate — whether from the JSON answer or the mined citations — must
// resolve to the right host via pickChannel before we trust it.
async function discoverDeliveryPerplexity(
  key: string,
  name: string,
  locationLine: string,
  category: string | null,
): Promise<{ opentable_url: string | null; uber_eats_url: string | null } | null> {
  const prompt =
    `Find where the venue "${name}"` +
    (locationLine ? ` located at ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") +
    `. takes reservations and delivery. Return strict JSON with:\n` +
    `- opentable_url: the canonical OpenTable restaurant page (opentable.com or ` +
    `a country domain like opentable.com.mx). For a chain, the specific ` +
    `location's page is best, but the brand page is acceptable. null if none.\n` +
    `- uber_eats_url: the canonical Uber Eats store page (ubereats.com). For a ` +
    `chain, the specific store is best, the brand page acceptable. null if none.\n` +
    `Never invent a URL — use null when you truly find none.`;
  try {
    const r = await fetch(PERPLEXITY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You resolve a venue's OpenTable and Uber Eats page URLs from web search. Output only valid JSON matching the schema. The specific location's page is best; a brand/chain page is acceptable. Use null only when you truly cannot find one. Never fabricate a URL.",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { schema: DELIVERY_CHANNELS_SCHEMA },
        },
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
      citations?: unknown[];
      search_results?: { url?: unknown }[];
    };
    const hitUrls: string[] = [];
    for (const c of data.citations ?? []) {
      if (typeof c === "string") hitUrls.push(c);
    }
    for (const s of data.search_results ?? []) {
      if (s && typeof s.url === "string") hitUrls.push(s.url);
    }
    const answer = (safeParseJson(data.choices?.[0]?.message?.content ?? "") as
      | { opentable_url?: unknown; uber_eats_url?: unknown }
      | null) ?? {};
    const opentable_url =
      pickChannel([String(answer.opentable_url ?? "")], "opentable_url") ??
      pickChannel(hitUrls, "opentable_url");
    const uber_eats_url =
      pickChannel([String(answer.uber_eats_url ?? "")], "uber_eats_url") ??
      pickChannel(hitUrls, "uber_eats_url");
    if (!opentable_url && !uber_eats_url) return null;
    return { opentable_url, uber_eats_url };
  } catch {
    return null;
  }
}


// Bare page slug of a Facebook URL, usable as an Instagram-handle candidate
// (venues reuse handles across networks). Numeric profile.php?id= pages and
// anything outside the IG handle charset (≤30 of [A-Za-z0-9._]) return null.
function fbSlugCandidate(url: string | null | undefined): string | null {
  const page = facebookPageFromUrl(url);
  if (!page) return null;
  let seg: string;
  try {
    seg = new URL(page).pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    return null;
  }
  if (!seg || seg === "profile.php") return null;
  return /^[A-Za-z0-9._]{2,30}$/.test(seg) ? seg : null;
}

// The Instagram profile scraper returns a non-null object even for a handle
// that DOESN'T EXIST: the requested username echoed back with every data field
// null/empty. That empty stub must be rejected before identity verification, or
// a guessed handle (e.g. a Facebook slug reused as an IG handle) could be
// "verified" against nothing. A real account always carries at least followers,
// a display name, a bio, or recent posts — a stub carries none of these.
function isDeadIgStub(p: Record<string, unknown>): boolean {
  if (typeof p.error === "string" && p.error.length > 0) return true;
  const hasFollowers = numOf(p.followersCount) != null;
  const hasName = typeof p.fullName === "string" && p.fullName.trim().length > 0;
  const hasBio = typeof p.biography === "string" && p.biography.trim().length > 0;
  const hasPosts = Array.isArray(p.latestPosts) && p.latestPosts.length > 0;
  return !hasFollowers && !hasName && !hasBio && !hasPosts;
}

// Does this scraped Instagram profile belong to THIS venue or its brand? We
// confirm before trusting it, but lean GENEROUS — a missing IG is a worse miss
// than a brand-level one. Instant yes on a bio link to the venue's website
// domain, agreement with the Facebook page slug, or a handle/name carrying the
// venue's brand (so franchises resolve to their one brand account). Otherwise
// an LLM judge decides, biased toward TRUE, rejecting only a clearly different
// business. No OpenAI key → fall back to the brand/slug signals above only.
async function igProfileMatchesVenue(
  p: Record<string, unknown>,
  venue: {
    name: string;
    locationLine: string;
    website: string | null;
    facebook: string | null;
    category: string | null;
  },
  openaiKey: string | undefined,
  corroborateFb = true,
): Promise<boolean> {
  const username = typeof p.username === "string" ? p.username : "";
  const fullName = typeof p.fullName === "string" ? p.fullName : "";
  const bio = typeof p.biography === "string" ? p.biography : "";
  const links: string[] = [];
  if (typeof p.externalUrl === "string") links.push(p.externalUrl);
  if (Array.isArray(p.externalUrls)) {
    for (const e of p.externalUrls) {
      const u = (e as { url?: unknown })?.url;
      if (typeof u === "string") links.push(u);
    }
  }

  // Strong signal: the IG bio link points to the venue's own website domain.
  const wd = domainOf(venue.website);
  if (wd && links.some((l) => domainOf(l) === wd)) return true;

  const fold = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const norm = (s: string) => fold(s).replace(/[^a-z0-9]/g, "");
  const uname = norm(username);
  const fname = norm(fullName);

  // Strong signal: an INDEPENDENTLY-discovered IG handle/name lines up with the
  // venue's Facebook page slug (venues reuse handles across networks, so
  // fb.com/Stranasanpedro + ig handle "stranasanpedro" is the same brand). Skip
  // when the candidate was derived FROM that slug — then it'd vouch for itself.
  const fbKey = corroborateFb ? norm(fbSlugCandidate(venue.facebook) ?? "") : "";
  if (fbKey.length >= 5 && (uname === fbKey || fname === fbKey)) return true;

  // Strong signal: the handle/name carries the venue's BRAND — its name minus
  // the city/location words. Franchises and multi-location brands run ONE
  // account for the whole brand, so "Mochomos Monterrey" → @mochomos is the
  // right match even though the handle isn't location-specific. We'd rather
  // attach the brand account than show nothing — a missing IG is the worse miss.
  const locTokens = new Set(
    fold(venue.locationLine)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
  const brandKey = norm(
    fold(venue.name)
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !locTokens.has(w))
      .join(""),
  );
  if (brandKey.length >= 5 && (uname.includes(brandKey) || fname.includes(brandKey))) {
    return true;
  }

  if (!openaiKey) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0,
        max_tokens: 80,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content:
              `Decide if an Instagram profile belongs to the venue below OR to the ` +
              `brand/chain it is part of. For a franchise or multi-location business ` +
              `the brand's MAIN account counts as a match even when it isn't specific ` +
              `to this location. Answer false ONLY when the profile is clearly a ` +
              `DIFFERENT, unrelated business; when the name plausibly matches the ` +
              `venue or its brand, prefer true.\n\n` +
              `Venue: "${venue.name}"` +
              (venue.locationLine ? `, ${venue.locationLine}` : "") +
              (venue.category ? `, category: ${venue.category}` : "") +
              (venue.website ? `, website: ${venue.website}` : "") +
              (venue.facebook ? `, facebook: ${venue.facebook}` : "") +
              `\nInstagram: @${username}, name: "${fullName}", bio: "${bio.slice(0, 500)}", ` +
              `links: ${links.join(", ") || "none"}\n\n` +
              `Reply JSON {"match": true} or {"match": false}.`,
          },
        ],
      }),
    });
    if (!r.ok) return false;
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const obj = safeParseJson(data.choices?.[0]?.message?.content ?? "") as
      | { match?: unknown }
      | null;
    return obj?.match === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function dedup(arr: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of arr) {
    if (typeof u === "string" && u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function numOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, ]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function safeParseProfile(content: string): ProfileResult | null {
  return safeParseJson(content) as ProfileResult | null;
}

function safeParseJson(content: string): unknown | null {
  if (!content) return null;
  let s = content.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}
