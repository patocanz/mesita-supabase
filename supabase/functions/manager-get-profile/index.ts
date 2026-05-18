// Supabase Edge Function — manager-get-profile
//
// Naming: caller-verb-words. Caller = manager, verb = get, words = profile.
//
// Authenticated. Returns the caller's manager profile, creating it on
// first call. The row is bound 1:1 to auth.users via the shared id. The
// email is mirrored from auth.users so it stays in sync if the user
// changes their login email; full_name + phone come from the manager's
// own onboarding form (manager-create-profile).
//
// Self-contained: own JWT verification, own DB read/upsert via the
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
  const userEmail = userData.user.email ?? null;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Read; on miss, insert and re-read. Race-safe because (id) is the PK.
  const existing = await admin
    .from("managers")
    .select("id, full_name, email, phone, created_at")
    .eq("id", userId)
    .maybeSingle();
  if (existing.error) {
    return json(
      { ok: false, error: `manager_read: ${existing.error.message}` },
      500,
    );
  }

  if (existing.data) {
    // Keep email mirrored if it drifted (user changed it in auth).
    if (userEmail && existing.data.email !== userEmail) {
      const refresh = await admin
        .from("managers")
        .update({ email: userEmail })
        .eq("id", userId)
        .select("id, full_name, email, phone, created_at")
        .single();
      if (!refresh.error) {
        return json({ ok: true, manager: refresh.data });
      }
    }
    return json({ ok: true, manager: existing.data });
  }

  const inserted = await admin
    .from("managers")
    .insert({ id: userId, email: userEmail })
    .select("id, full_name, email, phone, created_at")
    .single();
  if (inserted.error) {
    return json(
      { ok: false, error: `manager_create: ${inserted.error.message}` },
      500,
    );
  }
  return json({ ok: true, manager: inserted.data });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
