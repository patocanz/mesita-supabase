// Supabase Edge Function — manager-create-profile
//
// Naming: caller-verb-words. Caller = manager, verb = create, words = profile.
//
// Authenticated. The manager writes their own profile fields (full_name,
// phone). Auto-creates the manager row on first call so onboarding works
// before manager-get-profile has run. Used by /manager/onboard.
//
// Future split: when an edit-profile surface ships, a separate
// `manager-update-profile` function will handle edits (reject if missing).
// For now this function double-duties as the initial onboard write.
//
// Self-contained: own JWT verification, own DB writes via the service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Body = {
  full_name?: string | null;
  phone?: string | null;
};

function clean(v: unknown, max: number): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

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

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const fullName = clean(body.full_name, 120);
  const phone = clean(body.phone, 32);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Ensure the row exists. If absent, insert with the auth email so the
  // first update doesn't have to know about the email mirror.
  const existing = await admin
    .from("managers")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (existing.error) {
    return json(
      { ok: false, error: `manager_read: ${existing.error.message}` },
      500,
    );
  }
  if (!existing.data) {
    const seed = await admin
      .from("managers")
      .insert({ id: userId, email: userEmail })
      .select("id")
      .single();
    if (seed.error) {
      return json(
        { ok: false, error: `manager_create: ${seed.error.message}` },
        500,
      );
    }
  }

  // Build a patch with only the fields the caller sent — avoids
  // null-clobbering values they didn't intend to touch.
  const patch: Record<string, unknown> = {};
  if (body.full_name !== undefined) patch.full_name = fullName;
  if (body.phone !== undefined) patch.phone = phone;

  if (Object.keys(patch).length === 0) {
    return json({ ok: false, error: "Nothing to update" }, 400);
  }

  const update = await admin
    .from("managers")
    .update(patch)
    .eq("id", userId)
    .select("id, full_name, email, phone, created_at")
    .single();
  if (update.error) {
    return json(
      { ok: false, error: `manager_update: ${update.error.message}` },
      500,
    );
  }

  return json({ ok: true, manager: update.data });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
