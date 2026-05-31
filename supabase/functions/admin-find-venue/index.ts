// Supabase Edge Function — admin-find-venue
//
// Resolves a Google Place ID to a Mesita venue (id + name + slug) when
// the venue is already onboarded. Used by the admin console's "open in
// business" link generator: the admin pastes a Place ID, this EF returns
// the venue.id, and the admin web builds a
// https://business.mesita.ai/unit/<id>/home URL the operator can open.
//
// Auth: caller's JWT email must be in public.super_admins.
// verify_jwt = true gates non-bearer callers at the gateway.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

type Body = { placeId?: unknown };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const admin = adminClient(envRes.env);
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const placeId =
    typeof body.placeId === "string" ? body.placeId.trim() : "";
  if (!placeId) {
    return json({ ok: false, error: "placeId is required" }, 400);
  }

  const { data, error } = await admin
    .from("venues")
    .select("id, slug, name, status, created_at, updated_at")
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (error) {
    return json({ ok: false, error: `lookup_failed: ${error.message}` }, 500);
  }
  if (!data) {
    return json({ ok: true, venue: null });
  }
  return json({ ok: true, venue: data });
});
