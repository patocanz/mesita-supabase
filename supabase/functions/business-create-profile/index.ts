// Supabase Edge Function — business-create-profile
//
// Naming: caller-verb-words. Caller = business, verb = create, words = profile.
//
// Authenticated. The business writes their own profile fields (full_name,
// phone). Auto-creates the business row on first call so onboarding works
// before business-get-profile has run. Used by /business/onboard.
//
// Future split: when an edit-profile surface ships, a separate
// `business-update-profile` function will handle edits (reject if missing).
// For now this function double-duties as the initial onboard write.
//
// Self-contained: own JWT verification, own DB writes via the service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { clean } from "../_shared/input.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";

type Body = {
  full_name?: string | null;
  phone?: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;
  const userEmail = authRes.user.email;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const fullName = clean(body.full_name, 120);
  const phone = clean(body.phone, 32);

  const admin = adminClient(envRes.env);

  // Ensure the row exists. If absent, insert with the auth email so the
  // first update doesn't have to know about the email mirror.
  const existing = await admin
    .from("businesses")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (existing.error) {
    return json(
      { ok: false, error: `business_read: ${existing.error.message}` },
      500,
    );
  }
  if (!existing.data) {
    const seed = await admin
      .from("businesses")
      .insert({ id: userId, email: userEmail })
      .select("id")
      .single();
    if (seed.error) {
      return json(
        { ok: false, error: `business_create: ${seed.error.message}` },
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
    .from("businesses")
    .update(patch)
    .eq("id", userId)
    .select("id, full_name, email, phone, created_at")
    .single();
  if (update.error) {
    return json(
      { ok: false, error: `business_update: ${update.error.message}` },
      500,
    );
  }

  return json({ ok: true, business: update.data });
});
