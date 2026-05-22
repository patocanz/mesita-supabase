// Shared Stripe client construction for every EF that talks to the Stripe
// API or verifies an incoming webhook signature. Pure factory — no DB
// calls, no fetches, safe to import from any EF.
//
// Why npm:stripe and not esm.sh:
//   - The official stripe-node SDK ships with typed Webhooks helpers and
//     proper signature verification using the Web Crypto API under Deno.
//   - npm: specifier picks up CommonJS interop automatically in Deno.
//
// Environment variables expected:
//   STRIPE_SECRET_KEY        — sk_live_... in prod, sk_test_... in dev
//   STRIPE_WEBHOOK_SECRET    — whsec_... signing secret for the Stripe CLI
//                              endpoint OR the configured webhook endpoint
//
// Connect onboarding return/refresh URLs and Price IDs are read by the
// EFs that need them (manager-starts-connect-onboarding, etc.) rather
// than here, so this stays a pure SDK factory.

import Stripe from "npm:stripe@^17";

let cached: Stripe | null = null;

// Returns a Stripe client built from STRIPE_SECRET_KEY. Throws if the
// env var is missing — callers should treat that as a 500.
export function getStripe(): Stripe {
  if (cached) return cached;
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  cached = new Stripe(key, {
    // Pin so a future Stripe API release doesn't silently break our
    // payloads. Bump deliberately when we want new fields.
    apiVersion: "2025-10-16.basil",
    // Deno is fetch-native; tell the SDK not to fall back to Node http.
    httpClient: Stripe.createFetchHttpClient(),
  });
  return cached;
}

// Verify an incoming webhook signature using the raw request body + the
// `stripe-signature` header. Returns the parsed Stripe.Event on success;
// rethrows the SDK's signature-verification error on failure (which the
// EF should map to 400 — never 500, because we don't want Stripe to
// retry a permanently bad signature).
export async function verifyWebhookEvent(
  rawBody: string,
  signature: string,
): Promise<Stripe.Event> {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  }
  const stripe = getStripe();
  // constructEventAsync uses Web Crypto; the sync variant requires Node.
  return await stripe.webhooks.constructEventAsync(rawBody, signature, secret);
}

// Re-export the SDK type so EFs can `import type { Stripe } from "_shared/stripe.ts"`
// without each EF restating the npm specifier.
export type { Stripe };
