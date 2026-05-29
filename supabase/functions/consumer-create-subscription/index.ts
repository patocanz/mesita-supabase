// Supabase Edge Function — consumer-create-subscription (natural caller)
//
// Authenticated. Opens a Stripe Checkout Session for the $200 MXN/mo Mesita
// Premium subscription (the paid "door" into Premium) and returns the hosted
// checkout URL. It does NOT grant Premium — that only happens once Stripe
// confirms payment via stripe-handle-webhook. We just create the session and
// stash an `incomplete` subscription row so the webhook can reconcile.
//
// Body: { successUrl?: string, cancelUrl?: string }
// Response: { ok: true, checkout_url: string }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { getTierConfig } from "../_shared/membership.ts";

type Body = { successUrl?: string; cancelUrl?: string };

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

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) return json({ ok: false, error: "Stripe not configured" }, 500);
  const stripe = new Stripe(stripeKey, { apiVersion: "2025-03-31.basil" });

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* body optional */
  }

  const admin = adminClient(envRes.env);

  const premium = await getTierConfig(admin, "premium");
  if (!premium?.stripe_price_id) {
    return json({ ok: false, error: "Premium price not configured" }, 500);
  }

  // Reuse an existing Stripe customer id if we've seen this consumer before.
  const { data: existing } = await admin
    .from("consumer_subscriptions")
    .select("stripe_customer_id")
    .eq("consumer_id", consumerId)
    .not("stripe_customer_id", "is", null)
    .limit(1)
    .maybeSingle();

  let customerId = existing?.stripe_customer_id ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { consumer_id: consumerId },
    });
    customerId = customer.id;
  }

  const origin = req.headers.get("origin") ?? "";
  const successUrl = body.successUrl ?? `${origin}/profile?subscription=success`;
  const cancelUrl = body.cancelUrl ?? `${origin}/profile?subscription=cancelled`;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: consumerId,
    line_items: [{ price: premium.stripe_price_id, quantity: 1 }],
    subscription_data: { metadata: { consumer_id: consumerId } },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  // Stash an incomplete row so the webhook can find/update it. Upsert keyed on
  // the consumer's existing incomplete row if any.
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
