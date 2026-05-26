// Supabase Edge Function — business-get-profile
//
// Naming: caller-verb-words. Caller = business, verb = get, words = profile.
//
// Authenticated. Returns the caller's business profile, creating it on
// first call. The row is bound 1:1 to auth.users via the shared id. The
// email is mirrored from auth.users so it stays in sync if the user
// changes their login email; full_name + phone come from the business's
// own onboarding form (business-create-profile).
//
// Self-contained: own JWT verification, own DB read/upsert via the
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
  const userEmail = authRes.user.email;

  const admin = adminClient(envRes.env);

  // Read; on miss, insert and re-read. Race-safe because (id) is the PK.
  const existing = await admin
    .from("businesses")
    .select("id, full_name, first_name, last_name, email, phone, created_at")
    .eq("id", userId)
    .maybeSingle();
  if (existing.error) {
    return json(
      { ok: false, error: `business_read: ${existing.error.message}` },
      500,
    );
  }

  if (existing.data) {
    // Keep email mirrored if it drifted (user changed it in auth).
    if (userEmail && existing.data.email !== userEmail) {
      const refresh = await admin
        .from("businesses")
        .update({ email: userEmail })
        .eq("id", userId)
        .select("id, full_name, first_name, last_name, email, phone, created_at")
        .single();
      if (!refresh.error) {
        return json({ ok: true, business: refresh.data });
      }
    }
    return json({ ok: true, business: existing.data });
  }

  const inserted = await admin
    .from("businesses")
    .insert({ id: userId, email: userEmail })
    .select("id, full_name, first_name, last_name, email, phone, created_at")
    .single();
  if (inserted.error) {
    return json(
      { ok: false, error: `business_create: ${inserted.error.message}` },
      500,
    );
  }
  return json({ ok: true, business: inserted.data });
});

