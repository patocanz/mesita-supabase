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
    .select("id, code, full_name, first_name, last_name, sex, birthday, country, phone, cashback_balance_cents")
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
        .select("id, code, full_name, first_name, last_name, sex, birthday, country, phone, cashback_balance_cents")
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
      .select("id, code, full_name, first_name, last_name, sex, birthday, country, phone, cashback_balance_cents")
      .single();
    if (updated.error) {
      return json({ ok: false, error: `consumer_code_set: ${updated.error.message}` }, 500);
    }
    consumer = updated.data;
  }

  return json({ ok: true, consumer });
});
