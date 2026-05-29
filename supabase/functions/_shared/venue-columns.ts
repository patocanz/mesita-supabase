// Single source of truth for the columns we SELECT off public.venues.
//
// Before this file existed, every EF that read venues maintained its own
// hand-typed VENUE_COLUMNS string and they drifted: consumer EFs were missing
// the columns added by the Place redesign (timezone, hours, description,
// menu_pdf_url, tags, whatsapp_pr_urls, instagram_pr_urls, the signal
// fields, etc.), so consumers literally couldn't see what businesses had just
// edited. Importing from here keeps every read in lock-step.
//
// If you add a column to venues, update this file once and every reader
// gets it.

const COLUMNS: readonly string[] = [
  "id",
  "slug",
  "name",
  "category",
  "vibe",
  "price_level",
  // ISO 4217 code (default MXN). Every monetary amount on a venue —
  // price ranges shown on the consumer detail page, reward caps,
  // future cover charges — is denominated in this currency so the
  // client can render the right prefix ("MX$", "$", "€") without
  // hard-coding it.
  "currency",
  "listing_type",
  "status",
  "fiscal_type",
  "plan",
  "lat",
  "lng",
  "address",
  "timezone",
  "closes_at",
  "hours",
  "phone",
  // Legacy text fields. Description superseded them on the redesigned
  // Place page, but other callers and the old consumer Info view still read
  // pitch / story so we keep them in the projection.
  "pitch",
  "story",
  "description",
  // Legacy single-rate column. Superseded by the eight per-tier columns
  // below (welcome_*_rate / *_rate) added in migration 0027. Kept in the
  // projection until every reader switches off it.
  "cashback_percent",
  // Four per-tier promo rates (free / premium). Welcome variants fire on a
  // guest's first visit at the venue; the unprefixed variants apply on every
  // visit afterwards. Legal values: 10, 20, 50, 70 (nullable).
  "welcome_free_rate",
  "welcome_premium_rate",
  "free_rate",
  "premium_rate",
  // Venue-level monthly promo spend ceiling (migration 0038), in the venue's
  // currency. One of 200, 500, 1000, 2000 or null (no cap).
  "monthly_promo_cap",
  "photos",
  "menu_pdf_url",
  // Optional display name for menu_pdf_url, e.g. "Dinner menu" /
  // "Wine list". Null = consumer falls back to "Full menu" copy.
  "menu_pdf_name",
  "tags",
  // Channel URLs — primary, secondary, and PR. The Place page hides
  // secondary + PR for now but the values still round-trip through every
  // read and write, so they stay in the projection.
  "website_url",
  "instagram_url",
  "tiktok_url",
  "facebook_url",
  "whatsapp_url",
  "opentable_url",
  "resy_url",
  "uber_eats_url",
  "rappi_url",
  "x_url",
  "youtube_url",
  "threads_url",
  "reddit_url",
  "didi_food_url",
  "tripadvisor_url",
  "google_maps_url",
  "google_business_url",
  "whatsapp_pr_urls",
  "instagram_pr_urls",
  // Read-only signal columns — populated by enrichment, never by the
  // business. Shown on the Place page's Signals section and on consumer
  // surfaces that compare venues.
  "google_stars_overall",
  "google_review_count",
  "google_visitor_count",
  "mesita_stars_overall",
  "mesita_stars_food",
  "mesita_stars_service",
  "mesita_stars_ambience",
  "mesita_stars_value",
  "mesita_review_count",
  "mesita_visitor_count",
  "instagram_followers_count",
  "facebook_rating",
  "facebook_followers",
  // Complete-venue profile (migration 0039). Scalars + JSONB filled by the
  // one-run enricher; all nullable.
  "editorial_summary",
  "zone",
  "city",
  "established_year",
  "executive_chef",
  "reward_cap_cents",
  "requires_story",
  "details",
  "google_reviews",
  "menus",
  "popular_times",
  "enriched_at",
  // Promos page section toggles. Boolean, business-controlled, persisted
  // so the on/off state survives page reloads.
  "segmentation_basic_enabled",
  "segmentation_advanced_enabled",
  "email",
  "created_at",
];

// Consumer reads — used by every public/consumer-facing EF. No `updated_at`
// because consumers don't need to see when the business last touched a row.
export const VENUE_PUBLIC_COLUMNS = COLUMNS.join(", ");

// Business reads — includes `updated_at` so the business UI can show
// "saved · 2 min ago" style affordances.
export const VENUE_BUSINESS_COLUMNS = [...COLUMNS, "updated_at"].join(", ");
