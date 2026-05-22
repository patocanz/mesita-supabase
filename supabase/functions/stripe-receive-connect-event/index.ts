// Supabase Edge Function — stripe-receive-connect-event
//
// Webhook endpoint. Stripe POSTs Connect-related events here:
//
//   account.updated                       — capability / requirement state changed
//   account.application.deauthorized      — manager revoked our access to their account
//
// We:
//
//   1. Verify the Stripe signature using STRIPE_WEBHOOK_SECRET_CONNECT.
//      Bad signatures → 400 (Stripe won't retry; we don't want it to).
//   2. Insert the event into stripe_webhook_events keyed on stripe_event_id.
//      Duplicate event ids no-op + return 200 — idempotency guarantee.
//   3. Apply the event to stripe_connect_accounts.
//   4. Mark the row processed (or record the processing error).
//   5. Always return 200 once signature + idempotency clear, so Stripe
//      doesn't retry on a downstream bug we'd rather fix-forward.
//
// Self-contained: own signature verification, own DB writes via service role,
// never calls another Edge Function. No auth header expected — Stripe is
// the caller. CORS is irrelevant for webhooks; we still allow OPTIONS so
// preflight from a misconfigured proxy doesn't error.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";
import { getStripe, type Stripe } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET_CONNECT");
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }
  if (!WEBHOOK_SECRET) {
    return json(
      { ok: false, error: "STRIPE_WEBHOOK_SECRET_CONNECT not set" },
      500,
    );
  }

  // Stripe requires the raw body for signature verification. Reading as
  // text preserves bytes; do NOT JSON.parse before constructEvent.
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return json({ ok: false, error: "Missing stripe-signature header" }, 400);
  }
  const rawBody = await req.text();

  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      WEBHOOK_SECRET,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Signature verification failed";
    // 400 so Stripe stops retrying — a bad signature is permanent.
    return json({ ok: false, error: msg }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Idempotency: insert first, no-op if duplicate. We rely on the
  // unique(stripe_event_id) constraint to surface duplicates as 23505.
  const { error: insertError } = await admin
    .from("stripe_webhook_events")
    .insert({
      stripe_event_id: event.id,
      type: event.type,
      livemode: event.livemode,
      payload: event as unknown as Record<string, unknown>,
    });
  if (insertError) {
    // 23505 = unique_violation — duplicate event id. Return 200 so
    // Stripe doesn't keep retrying a no-op.
    if ((insertError as { code?: string }).code === "23505") {
      return json({ ok: true, duplicate: true });
    }
    return json({ ok: false, error: insertError.message }, 500);
  }

  // Dispatch.
  try {
    switch (event.type) {
      case "account.updated":
        await applyAccountUpdated(admin, event.data.object as Stripe.Account);
        break;
      case "account.application.deauthorized":
        await applyDeauthorized(admin, event.account ?? null);
        break;
      default:
        // Stripe sometimes sends event types we didn't subscribe to (e.g.
        // a noisy account.external_account.created). Record + ignore.
        break;
    }
    await admin
      .from("stripe_webhook_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("stripe_event_id", event.id);
    return json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Webhook processing failed";
    await admin
      .from("stripe_webhook_events")
      .update({ processing_error: msg })
      .eq("stripe_event_id", event.id);
    // Still 200: fix-forward, don't make Stripe retry a buggy handler.
    return json({ ok: true, processingError: msg });
  }
});

// account.updated: refresh the mirror of capabilities + requirements.
// If the venue isn't in stripe_connect_accounts yet (shouldn't happen,
// but webhooks can race) we skip silently — the EF that created the
// account would have inserted the row.
async function applyAccountUpdated(
  admin: ReturnType<typeof createClient>,
  account: Stripe.Account,
): Promise<void> {
  await admin
    .from("stripe_connect_accounts")
    .update({
      charges_enabled: account.charges_enabled ?? false,
      payouts_enabled: account.payouts_enabled ?? false,
      details_submitted: account.details_submitted ?? false,
      requirements: (account.requirements ?? {}) as Record<string, unknown>,
    })
    .eq("stripe_account_id", account.id);
}

// account.application.deauthorized: the venue has unlinked Mesita from
// their account. Mark the row as no longer payable. We keep the row for
// audit + ledger reconciliation rather than deleting it.
async function applyDeauthorized(
  admin: ReturnType<typeof createClient>,
  accountId: string | null,
): Promise<void> {
  if (!accountId) return;
  await admin
    .from("stripe_connect_accounts")
    .update({
      charges_enabled: false,
      payouts_enabled: false,
    })
    .eq("stripe_account_id", accountId);
}
