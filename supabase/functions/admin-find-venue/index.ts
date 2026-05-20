// Supabase Edge Function — admin-find-venue
//
// Resolves a Google Place ID to a Mesita venue (id + name + slug) when
// the venue is already onboarded. Used by the admin console's deep-link
// generator: the admin pastes a Place ID, this EF returns the venue.id,
// and the admin web builds a https://manager.mesita.ai/unit/<id>/home
// URL the operator can open.
//
// Auth (dual-path during the super_admins migration):
//   1. Legacy: `x-admin-key` header == `ADMIN_ACCESS_KEY` env.
//   2. New: caller's JWT email is in public.super_admins.
//
// JWT verification stays disabled in config.toml during the cutover so
// the legacy callers (no JWT) still work. Each request manually verifies
// the bearer when it's present.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = { placeId?: unknown };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Path 1: legacy admin key.
  const legacyExpected = Deno.env.get("ADMIN_ACCESS_KEY") ?? "";
  const legacyProvided = req.headers.get("x-admin-key") ?? "";
  const legacyOk =
    legacyExpected.length > 0 && legacyProvided === legacyExpected;

  // Path 2: super_admins allowlist via JWT.
  let allowlistOk = false;
  if (!legacyOk) {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (authHeader.startsWith("Bearer ")) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData } = await userClient.auth.getUser();
      const emailLower = userData?.user?.email?.toLowerCase() ?? null;
      if (emailLower) {
        const { data: saRow } = await admin
          .from("super_admins")
          .select("email, user_id")
          .eq("email", emailLower)
          .maybeSingle();
        if (saRow) {
          allowlistOk = true;
          if (saRow.user_id == null) {
            void admin
              .from("super_admins")
              .update({ user_id: userData!.user!.id })
              .eq("email", emailLower)
              .is("user_id", null);
          }
        }
      }
    }
  }

  if (!legacyOk && !allowlistOk) {
    return json({ ok: false, code: "unauthorized", error: "Unauthorized" });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" });
  }
  const placeId =
    typeof body.placeId === "string" ? body.placeId.trim() : "";
  if (!placeId) {
    return json({ ok: false, error: "placeId is required" });
  }

  const { data, error } = await admin
    .from("venues")
    .select("id, slug, name, status, created_at, updated_at")
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (error) {
    return json({ ok: false, error: `lookup_failed: ${error.message}` });
  }
  if (!data) {
    return json({ ok: true, venue: null });
  }
  return json({ ok: true, venue: data });
});
