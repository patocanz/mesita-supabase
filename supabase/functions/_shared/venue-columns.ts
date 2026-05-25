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
  "cashback_percent",
  "photos",
  "menu_pdf_url",
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
  "mesita_review_count",
  "mesita_visitor_count",
  "instagram_followers_count",
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
