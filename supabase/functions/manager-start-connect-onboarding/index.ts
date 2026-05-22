// Supabase Edge Function — manager-start-connect-onboarding
//
// Authenticated. The caller is a manager who's about to set up Stripe
// Connect Express for one of their Formal Verified Partner venues. We:
//
//   1. Verify the caller is a member of the requested venue (or a
//      super-admin).
//   2. Verify the venue is fiscal_type='formal' — informal venues never
//      run the cashback rail and don't need an Express account.
//   3. Ensure a `stripe_connect_accounts` row exists for the venue,
//      creating a Stripe Express Account on the fly if missing.
//   4. Generate a fresh Stripe Account Link (these expire after a few
//      minutes) and return its URL.
//
// Why "fresh on every call": account links are short-lived. If the
// manager closes the tab and comes back, the previous URL is dead, so
// we mint a new one every time — Stripe's recommended pattern.
//
// Self-contained: own JWT verification, own DB writes via service role,
// never calls another Edge Function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";
import { getStripe } from "../_shared/stripe.ts";

type Body = { venueId?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const RETURN_URL = Deno.env.get("STRIPE_CONNECT_RETURN_URL");
  const REFRESH_URL = Deno.env.get("STRIPE_CONNECT_REFRESH_URL");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }
  if (!RETURN_URL || !REFRESH_URL) {
    return json(
      { ok: false, error: "Stripe Connect URLs not configured" },
      500,
    );
  }

  // Auth: a signed-in manager OR a super-admin operating on a specific
  // venue. The membership check below distinguishes them.
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

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const venueId = (body.venueId ?? "").toString().trim();
  if (!venueId) {
    return json({ ok: false, error: "venueId is required" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Super-admin short-circuit: matches public.super_admins by lowercase email.
  let isSuperAdmin = false;
  const emailLower = userEmail?.toLowerCase() ?? null;
  if (emailLower) {
    const { data: saRow } = await admin
      .from("super_admins")
      .select("email")
      .eq("email", emailLower)
      .maybeSingle();
    if (saRow) isSuperAdmin = true;
  }

  // Membership gate (skipped for super-admins).
  if (!isSuperAdmin) {
    const { data: member } = await admin
      .from("venue_members")
      .select("role")
      .eq("venue_id", venueId)
      .eq("manager_id", userId)
      .maybeSingle();
    if (!member) {
      return json(
        { ok: false, error: "Not a member of this venue" },
        403,
      );
    }
  }

  // Load the venue. We need fiscal_type (must be Formal) and a few
  // fields to pre-fill the Express account's business profile.
  const { data: venue, error: venueError } = await admin
    .from("venues")
    .select("id, name, fiscal_type, website_url")
    .eq("id", venueId)
    .maybeSingle();
  if (venueError) {
    return json({ ok: false, error: venueError.message }, 500);
  }
  if (!venue) {
    return json({ ok: false, error: "Venue not found" }, 404);
  }
  if (venue.fiscal_type !== "formal") {
    return json(
      {
        ok: false,
        error:
          "Only Formal venues use Stripe Connect. Informal venues run instant discounts off the payment rail.",
      },
      400,
    );
  }

  // Reuse an existing Express account if we already created one for this
  // venue; otherwise mint a fresh one and persist it.
  const stripe = getStripe();
  const existing = await admin
    .from("stripe_connect_accounts")
    .select("stripe_account_id, payouts_enabled, charges_enabled, details_submitted")
    .eq("venue_id", venueId)
    .maybeSingle();
  if (existing.error) {
    return json({ ok: false, error: existing.error.message }, 500);
  }

  let stripeAccountId: string;
  let alreadyOnboarded = false;

  if (existing.data) {
    stripeAccountId = existing.data.stripe_account_id;
    alreadyOnboarded = !!existing.data.details_submitted;
  } else {
    let account;
    try {
      account = await stripe.accounts.create({
        type: "express",
        country: "MX",
        email: userEmail ?? undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          name: venue.name,
          url: venue.website_url ?? undefined,
          // MCC 5812 — Eating Places, Restaurants. Stripe uses this to
          // calibrate risk + fee profile, so picking the right MCC up
          // front matters more than it looks.
          mcc: "5812",
        },
        metadata: {
          venue_id: venueId,
          created_by_user_id: userId,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Stripe account create failed";
      return json({ ok: false, error: msg }, 502);
    }

    stripeAccountId = account.id;

    const { error: insertError } = await admin
      .from("stripe_connect_accounts")
      .insert({
        venue_id: venueId,
        stripe_account_id: stripeAccountId,
        charges_enabled: account.charges_enabled ?? false,
        payouts_enabled: account.payouts_enabled ?? false,
        details_submitted: account.details_submitted ?? false,
        requirements: (account.requirements ?? {}) as Record<string, unknown>,
      });
    if (insertError) {
      // Roll back the Stripe-side account so we don't leak orphans on
      // every retry. Best-effort — if Stripe.del fails we still surface
      // the original DB error to the caller.
      try {
        await stripe.accounts.del(stripeAccountId);
      } catch {
        /* swallowed — original DB error is more informative */
      }
      return json({ ok: false, error: insertError.message }, 500);
    }
  }

  // Mint a fresh Account Link. Always fresh, even if the venue already
  // submitted details — they might be coming back to update info.
  let accountLink;
  try {
    accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: REFRESH_URL,
      return_url: RETURN_URL,
      type: "account_onboarding",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Stripe account link failed";
    return json({ ok: false, error: msg }, 502);
  }

  return json({
    ok: true,
    onboardingUrl: accountLink.url,
    // Stripe returns a unix timestamp in seconds; convert to ISO so the
    // client doesn't have to know the convention.
    expiresAt: new Date(accountLink.expires_at * 1000).toISOString(),
    alreadyOnboarded,
  });
});
