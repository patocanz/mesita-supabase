// Supabase Edge Function — admin-set-atlas-pre-read
//
// Flips the Atlas pre-read toggle on public.app_settings.
//
//   true  → On any venue create/update, Atlas EFs read existing
//           snapshots with an LLM before calling any fetcher. Saves
//           money + latency for fields already researched.
//   false → Every venue create/update fetches from scratch. Snapshots
//           are still written (the toggle ONLY gates pre-read).
//
// Auth: caller's JWT email must be in public.super_admins.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";

type Body = { enabled?: boolean };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;
  const emailLower = authRes.user.emailLower;
  if (!emailLower) {
    return json({ ok: false, error: "No email on session" }, 401);
  }

  const admin = adminClient(envRes.env);

  // super_admins gate.
  const { data: saRow } = await admin
    .from("super_admins")
    .select("email")
    .eq("email", emailLower)
    .maybeSingle();
  if (!saRow) {
    return json({ ok: false, error: "Not a super-admin" }, 403);
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return json({ ok: false, error: "enabled must be a boolean" }, 400);
  }

  const { data, error } = await admin
    .from("app_settings")
    .update({ atlas_pre_read_snapshots: body.enabled, updated_by: userId })
    .eq("id", 1)
    .select("atlas_pre_read_snapshots, updated_at")
    .single();
  if (error) {
    return json(
      { ok: false, error: `settings_update: ${error.message}` },
      500,
    );
  }

  return json({
    ok: true,
    atlasPreReadSnapshots: data.atlas_pre_read_snapshots,
    updatedAt: data.updated_at,
  });
});
