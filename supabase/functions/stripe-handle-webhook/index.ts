// Supabase Edge Function — stripe-handle-webhook (external caller)
//
// Public endpoint (verify_jwt disabled at the gateway). Security rests
// entirely on Stripe signature verification with STRIPE_WEBHOOK_SECRET — an
// unsigned or mis-signed request is rejected. This is the ONLY writer that
// flips a consumer to/from Premium on the back of the paid door.
//
// Idempotency: Stripe retries deliveries. We record every processed event id
// in public.stripe_events and no-op on replays.
//
// Tier precedence rule: a subscription lapse only downgrades a consumer whose
// tier_origin is 'subscription'. We never strip Premium earned via Instagram
// or invitation just because a card failed.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17";
import { adminClient, readEFEnv } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return new Response("Server misconfigured", { status: 500 });

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!stripeKey || !webhookSecret) {
    return new Response("Stripe not configured", { status: 500 });
  }
  const stripe = new Stripe(stripeKey, { apiVersion: "2025-03-31.basil" });

  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing signature", { status: 400 });

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, webhookSecret);
  } catch (err) {
    console.error("[stripe-handle-webhook] signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  const admin = adminClient(envRes.env);

  // Idempotency guard. If the event id is already recorded, this is a replay.
  const dedupe = await admin
    .from("stripe_events")
    .insert({ event_id: event.id });
  if (dedupe.error) {
    // 23505 = unique violation = already processed. Anything else is a real
    // error, but we still 200 so Stripe doesn't hammer retries on a transient.
    if (dedupe.error.code === "23505") {
      return new Response(JSON.stringify({ received: true, replay: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("[stripe-handle-webhook] dedupe insert error:", dedupe.error);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const consumerId =
          session.client_reference_id ??
          (session.metadata?.consumer_id as string | undefined) ??
          null;
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id ?? null;
        if (consumerId && subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          await reconcileSubscription(admin, stripe, consumerId, sub);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const consumerId = await resolveConsumerId(admin, stripe, sub);
        if (consumerId) {
          await reconcileSubscription(admin, stripe, consumerId, sub);
        }
        break;
      }
      default:
        // Unhandled event types are acknowledged and ignored.
        break;
    }
  } catch (err) {
    console.error(`[stripe-handle-webhook] handler error (${event.type}):`, err);
    return new Response("Handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

// Maps a Stripe subscription back to a Mesita consumer via metadata, falling
// back to the customer's metadata.
async function resolveConsumerId(
  admin: ReturnType<typeof adminClient>,
  stripe: Stripe,
  sub: Stripe.Subscription,
): Promise<string | null> {
  const fromSub = sub.metadata?.consumer_id as string | undefined;
  if (fromSub) return fromSub;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  // Try our own table first.
  const { data } = await admin
    .from("consumer_subscriptions")
    .select("consumer_id")
    .eq("stripe_customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (data?.consumer_id) return data.consumer_id as string;
  // Last resort: read the customer's metadata from Stripe.
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer.deleted) {
      return (customer.metadata?.consumer_id as string | undefined) ?? null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Upserts the local subscription mirror and applies the tier side-effect.
async function reconcileSubscription(
  admin: ReturnType<typeof adminClient>,
  _stripe: Stripe,
  consumerId: string,
  sub: Stripe.Subscription,
): Promise<void> {
  const status = sub.status; // active, past_due, canceled, unpaid, incomplete…
  const localStatus = mapStatus(status);
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;
  const priceCents = sub.items.data[0]?.price.unit_amount ?? null;
  const currency = (sub.items.data[0]?.price.currency ?? "mxn").toUpperCase();

  await admin
    .from("consumer_subscriptions")
    .upsert(
      {
        consumer_id: consumerId,
        stripe_customer_id: customerId,
        stripe_subscription_id: sub.id,
        status: localStatus,
        price_cents: priceCents,
        currency,
        current_period_end: periodEnd,
        cancel_at_period_end: sub.cancel_at_period_end ?? false,
      },
      { onConflict: "stripe_subscription_id" },
    );

  const isLive = localStatus === "active" || localStatus === "past_due";
  if (isLive) {
    // Grant Premium via the subscription door.
    await admin
      .from("consumers")
      .update({
        tier_key: "premium",
        tier_origin: "subscription",
        tier_granted_at: new Date().toISOString(),
        tier_expires_at: periodEnd,
      })
      .eq("id", consumerId);
  } else {
    // Lapsed/cancelled: only downgrade if Premium came through the paid door.
    // An Instagram/invitation Premium is left untouched.
    await admin
      .from("consumers")
      .update({
        tier_key: "free",
        tier_origin: "default",
        tier_expires_at: null,
      })
      .eq("id", consumerId)
      .eq("tier_origin", "subscription");
  }
}

function mapStatus(s: string): string {
  switch (s) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "unpaid":
      return "unpaid";
    default:
      return "incomplete";
  }
}
