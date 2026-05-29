// Supabase Edge Function — consumer-get-profile
//
// Authenticated. Returns the caller's consumer profile, creating it on first
// call (with a stable short `code` used by validators to scan/identify the
// consumer at checkout) and returning the cached cashback balance.
//
// Self-contained: verifies the JWT, does its own DB read/upsert through the
// service role, never calls another Edge Function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { getTierConfig } from "../_shared/membership.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  const admin = adminClient(envRes.env);

  // Read once. If absent, insert with a generated code and re-read.
  const existing = await admin
    .from("consumers")
    .select("id, code, full_name, first_name, last_name, sex, birthday, country, phone, cashback_balance_cents, tier_key, tier_origin, consumer_instagram_followers_count, tier_expires_at")
    .eq("id", userId)
    .maybeSingle();
  if (existing.error) {
    return json({ ok: false, error: `consumer_read: ${existing.error.message}` }, 500);
  }

  let consumer = existing.data;
  if (!consumer) {
    // Generate a code by calling the SQL helper (race-safe via unique
    // constraint; we retry once on conflict).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const codeResult = await admin.rpc("generate_consumer_code");
      if (codeResult.error) {
        return json({ ok: false, error: `code_gen: ${codeResult.error.message}` }, 500);
      }
      const inserted = await admin
        .from("consumers")
        .insert({ id: userId, code: codeResult.data as string })
        .select("id, code, full_name, first_name, last_name, sex, birthday, country, phone, cashback_balance_cents, tier_key, tier_origin, consumer_instagram_followers_count, tier_expires_at")
        .single();
      if (!inserted.error) {
        consumer = inserted.data;
        break;
      }
      // Unique-violation on code → retry. Anything else: bail out.
      if (inserted.error.code !== "23505") {
        return json({ ok: false, error: `consumer_create: ${inserted.error.message}` }, 500);
      }
    }
    if (!consumer) {
      return json({ ok: false, error: "Could not assign a unique code" }, 500);
    }
  } else if (!consumer.code) {
    // Existing row without a code (e.g. created before this migration ran).
    const codeResult = await admin.rpc("generate_consumer_code");
    if (codeResult.error) {
      return json({ ok: false, error: `code_gen: ${codeResult.error.message}` }, 500);
    }
    const updated = await admin
      .from("consumers")
      .update({ code: codeResult.data as string })
      .eq("id", userId)
      .select("id, code, full_name, first_name, last_name, sex, birthday, country, phone, cashback_balance_cents, tier_key, tier_origin, consumer_instagram_followers_count, tier_expires_at")
      .single();
    if (updated.error) {
      return json({ ok: false, error: `consumer_code_set: ${updated.error.message}` }, 500);
    }
    consumer = updated.data;
  }

  // ── Membership payload ─────────────────────────────────────────────────
  // Surfaces the consumer's tier, how they earned it, their Instagram
  // follower count, current subscription (if any), and this month's
  // reservation usage vs their cap. The UI uses this to render the Class tab
  // and gate the "upgrade" affordances.
  const tier = await getTierConfig(admin, consumer.tier_key ?? "free");

  const { data: subscription } = await admin
    .from("consumer_subscriptions")
    .select(
      "status, price_cents, currency, current_period_end, cancel_at_period_end",
    )
    .eq("consumer_id", userId)
    .in("status", ["active", "past_due"])
    .maybeSingle();

  let used = 0;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { count } = await admin
    .from("reservations")
    .select("id", { count: "exact", head: true })
    .eq("consumer_id", userId)
    .gte("created_at", monthStart.toISOString())
    .neq("status", "cancelled");
  used = count ?? 0;

  const membership = {
    tier: consumer.tier_key ?? "free",
    origin: consumer.tier_origin ?? "default",
    label: tier?.label ?? "Free",
    followers: consumer.consumer_instagram_followers_count ?? null,
    expires_at: consumer.tier_expires_at ?? null,
    subscription: subscription ?? null,
    usage: {
      reservations_used: used,
      reservations_limit: tier?.monthly_reservation_limit ?? null,
    },
  };

  return json({ ok: true, consumer, membership });
});
