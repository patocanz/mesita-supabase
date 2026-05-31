// Supabase Edge Function — consumer-create-subscription (natural caller)
//
// Authenticated. The paid "door" into Mesita Premium.
//
// Two modes, chosen by the MOCK_SUBSCRIPTION toggle below:
//
//   • MOCK — grants Premium immediately (origin 'subscription'), records a
//     mock active subscription, and returns the success URL so the client's
//     redirect lands on the post-checkout page. No money moves.
//
//   • REAL — creates a Stripe Checkout Session and returns its hosted URL.
//     Tier is NOT granted here; the Stripe webhook (stripe-handle-webhook)
//     flips it once payment clears.
//
// Body: { successUrl?: string, cancelUrl?: string }
// Response: { ok: true, checkout_url: string, mock?: true }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17";
import { corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { getTierConfig } from "../_shared/membership.ts";

type Body = { successUrl?: string; cancelUrl?: string };

const MOCK_PERIOD_DAYS = 30;

// ⚠️ DEMO MOCK — the single on/off switch for instant Premium.
//
// When true, "Subscribe" grants Premium right away with no payment and no
// Stripe call. This is the easy change: set the MOCK_SUBSCRIPTION env to
// "false" (or flip this default to false) and redeploy to require a real
// Stripe Checkout payment again. Mock also runs whenever STRIPE_SECRET_KEY
// is absent, so a project with no Stripe secret still works out of the box.
const MOCK_SUBSCRIPTION =
  (Deno.env.get("MOCK_SUBSCRIPTION") ?? "true").toLowerCase() !== "false";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const consumerId = authRes.user.id;

  const body = await readJsonOr<Body>(req, {});

  const admin = adminClient(envRes.env);
  const premium = await getTierConfig(admin, "premium");

  const origin = req.headers.get("origin") ?? "";
  const successUrl = body.successUrl ?? `${origin}/profile?subscription=success`;
  const cancelUrl = body.cancelUrl ?? `${origin}/profile?subscription=cancelled`;

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");

  // ── MOCK mode ───────────────────────────────────────────────────────────
  // Fires when the demo toggle is on, or when there's no Stripe secret to
  // run real billing with.
  if (MOCK_SUBSCRIPTION || !stripeKey) {
    const periodEnd = new Date(
      Date.now() + MOCK_PERIOD_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    // Stable per-consumer id so re-subscribing updates the same row instead
    // of tripping the one-live-subscription-per-consumer unique index.
    const mockSubId = `mock_${consumerId}`;

    const sub = await admin
      .from("consumer_subscriptions")
      .upsert(
        {
          consumer_id: consumerId,
          stripe_subscription_id: mockSubId,
          stripe_customer_id: `mock_cus_${consumerId}`,
          status: "active",
          price_cents: premium?.price_cents ?? 20000,
          currency: premium?.currency ?? "MXN",
          current_period_end: periodEnd,
          cancel_at_period_end: false,
        },
        { onConflict: "stripe_subscription_id" },
      );
    if (sub.error) {
      return json({ ok: false, error: `mock_subscription: ${sub.error.message}` }, 500);
    }

    const grant = await admin
      .from("consumers")
      .update({
        tier_key: "premium",
        tier_origin: "subscription",
        tier_granted_at: new Date().toISOString(),
        tier_expires_at: periodEnd,
      })
      .eq("id", consumerId);
    if (grant.error) {
      return json({ ok: false, error: `mock_grant: ${grant.error.message}` }, 500);
    }

    return json({ ok: true, checkout_url: successUrl, mock: true });
  }

  // ── REAL Stripe mode ──────────────────────────────────────────────────────
  if (!premium?.stripe_price_id) {
    return json({ ok: false, error: "Premium price not configured" }, 500);
  }
  const stripe = new Stripe(stripeKey, { apiVersion: "2025-03-31.basil" });

  // Reuse an existing Stripe customer id if we've seen this consumer before.
  const { data: existing } = await admin
    .from("consumer_subscriptions")
    .select("stripe_customer_id")
    .eq("consumer_id", consumerId)
    .not("stripe_customer_id", "is", null)
    .limit(1)
    .maybeSingle();

  let customerId = existing?.stripe_customer_id ?? null;
  if (!customerId || customerId.startsWith("mock_")) {
    const customer = await stripe.customers.create({
      metadata: { consumer_id: consumerId },
    });
    customerId = customer.id;
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: consumerId,
    line_items: [{ price: premium.stripe_price_id, quantity: 1 }],
    subscription_data: { metadata: { consumer_id: consumerId } },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  await admin.from("consumer_subscriptions").upsert(
    {
      consumer_id: consumerId,
      stripe_customer_id: customerId,
      status: "incomplete",
      price_cents: premium.price_cents,
      currency: premium.currency,
    },
    { onConflict: "stripe_subscription_id", ignoreDuplicates: true },
  );

  return json({ ok: true, checkout_url: session.url });
});
