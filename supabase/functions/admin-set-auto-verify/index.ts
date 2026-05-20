// Supabase Edge Function — admin-set-auto-verify
//
// Toggles one of the per-method auto-confirm flags on
// public.app_settings:
//
//   ai_call → auto_verify_ai_call (default true). When true the OTP
//             code-entry EF grants ownership on correct code. When
//             false the row sits in the admin queue tagged
//             "code-verified, awaiting manual approval".
//   video   → auto_verify_video   (default false). When true a
//             submitted video URL grants ownership immediately. When
//             false the row goes to the admin queue for human review.
//
// Auth: caller's JWT email must be in public.super_admins.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Method = "ai_call" | "video";
type Body = { method?: Method; enabled?: boolean };

const COLUMN: Record<Method, "auto_verify_ai_call" | "auto_verify_video"> = {
  ai_call: "auto_verify_ai_call",
  video: "auto_verify_video",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // super_admins gate.
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
  const emailLower = userData.user.email?.toLowerCase() ?? null;
  if (!emailLower) {
    return json({ ok: false, error: "No email on session" }, 401);
  }
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
  if (body.method !== "ai_call" && body.method !== "video") {
    return json({ ok: false, error: "method must be ai_call | video" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return json({ ok: false, error: "enabled must be a boolean" }, 400);
  }

  const column = COLUMN[body.method];
  const { data, error } = await admin
    .from("app_settings")
    .update({ [column]: body.enabled, updated_by: userId })
    .eq("id", 1)
    .select("auto_verify_ai_call, auto_verify_video, updated_at")
    .single();
  if (error) {
    return json(
      { ok: false, error: `settings_update: ${error.message}` },
      500,
    );
  }

  return json({
    ok: true,
    autoVerifyAiCall: data.auto_verify_ai_call,
    autoVerifyVideo: data.auto_verify_video,
    autoVerifyUpdatedAt: data.updated_at,
  });
});
