// Membership helpers — the single place tier logic lives so the "blended
// rate" privacy goal holds: a venue/waiter never learns which tier (or which
// door — Instagram / invitation / subscription) a guest came through. The
// rate resolver returns only the final integer percent; nothing tier-shaped
// leaks into any business/staff response.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// The subset of venue columns the rate resolver needs. Any venue row read
// with VENUE_*_COLUMNS satisfies this.
export type VenueRates = {
  welcome_free_rate: number | null;
  welcome_premium_rate: number | null;
  free_rate: number | null;
  premium_rate: number | null;
  // Legacy single rate — fallback until every venue carries per-tier rates.
  cashback_percent: number | null;
};

export type TierKey = "free" | "premium";

export type TierConfig = {
  key: string;
  label: string;
  rank: number;
  follower_threshold: number | null;
  monthly_reservation_limit: number | null;
  price_cents: number;
  currency: string;
  stripe_price_id: string | null;
  recommendation_weight: number;
};

// Resolves the promo rate for a guest at a venue. Premium guests get the
// premium column; everyone else the free column. The "welcome" variant fires
// on a guest's first visit at this venue, the default variant afterwards.
// Falls back to the lower tier's rate, then the legacy single rate, then 0.
// Returns a clamped integer percent — and ONLY that, never the tier.
export function selectVenueRate(
  venue: VenueRates,
  tier: string | null | undefined,
  isFirstVisit: boolean,
): number {
  const isPremium = tier === "premium";
  let rate: number | null = null;
  if (isFirstVisit) {
    rate = isPremium
      ? venue.welcome_premium_rate ?? venue.welcome_free_rate
      : venue.welcome_free_rate;
  } else {
    rate = isPremium
      ? venue.premium_rate ?? venue.free_rate
      : venue.free_rate;
  }
  if (rate == null) rate = venue.cashback_percent;
  return Math.max(0, Math.min(100, rate ?? 0));
}

// Loads a tier's config row. Returns null if the key isn't in the lookup.
export async function getTierConfig(
  admin: SupabaseClient,
  tierKey: string,
): Promise<TierConfig | null> {
  const { data } = await admin
    .from("membership_tiers")
    .select(
      "key, label, rank, follower_threshold, monthly_reservation_limit, price_cents, currency, stripe_price_id, recommendation_weight",
    )
    .eq("key", tierKey)
    .maybeSingle();
  return (data as TierConfig | null) ?? null;
}

// True when this consumer has never had a completed/opened ticket at this
// venue. Used to pick the "welcome" rate. Counting tickets (not reservations)
// matches the rewards mechanic: a visit is a ticket.
export async function isConsumerFirstVisit(
  admin: SupabaseClient,
  consumerId: string,
  venueId: string,
): Promise<boolean> {
  const { count } = await admin
    .from("tickets")
    .select("id", { count: "exact", head: true })
    .eq("consumer_id", consumerId)
    .eq("venue_id", venueId);
  return (count ?? 0) === 0;
}
