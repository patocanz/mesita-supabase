// Supabase Edge Function — guest-get-profile
//
// Authenticated. Returns the caller's guest profile, creating it on first
// call (with a stable short `code` used by validators to scan/identify the
// guest at checkout) and returning the cached cashback balance.
//
// Self-contained: verifies the JWT, does its own DB read/upsert through the
// service role, never calls another Edge Function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

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

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Read once. If absent, insert with a generated code and re-read.
  const existing = await admin
    .from("guests")
    .select("id, code, full_name, sex, birthday, country, phone, cashback_balance_cents")
    .eq("id", userId)
    .maybeSingle();
  if (existing.error) {
    return json({ ok: false, error: `guest_read: ${existing.error.message}` }, 500);
  }

  let guest = existing.data;
  if (!guest) {
    // Generate a code by calling the SQL helper (race-safe via unique
    // constraint; we retry once on conflict).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const codeResult = await admin.rpc("generate_guest_code");
      if (codeResult.error) {
        return json({ ok: false, error: `code_gen: ${codeResult.error.message}` }, 500);
      }
      const inserted = await admin
        .from("guests")
        .insert({ id: userId, code: codeResult.data as string })
        .select("id, code, full_name, sex, birthday, country, phone, cashback_balance_cents")
        .single();
      if (!inserted.error) {
        guest = inserted.data;
        break;
      }
      // Unique-violation on code → retry. Anything else: bail out.
      if (inserted.error.code !== "23505") {
        return json({ ok: false, error: `guest_create: ${inserted.error.message}` }, 500);
      }
    }
    if (!guest) {
      return json({ ok: false, error: "Could not assign a unique code" }, 500);
    }
  } else if (!guest.code) {
    // Existing row without a code (e.g. created before this migration ran).
    const codeResult = await admin.rpc("generate_guest_code");
    if (codeResult.error) {
      return json({ ok: false, error: `code_gen: ${codeResult.error.message}` }, 500);
    }
    const updated = await admin
      .from("guests")
      .update({ code: codeResult.data as string })
      .eq("id", userId)
      .select("id, code, full_name, sex, birthday, country, phone, cashback_balance_cents")
      .single();
    if (updated.error) {
      return json({ ok: false, error: `guest_code_set: ${updated.error.message}` }, 500);
    }
    guest = updated.data;
  }

  return json({ ok: true, guest });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
