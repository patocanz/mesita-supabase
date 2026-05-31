// Supabase Edge Function — admin-set-auto-verify
//
// Toggles one of the per-method auto-confirm flags on
// public.app_settings:
//
//   ai_call  → auto_verify_ai_call  (default true). When true the OTP
//              code-entry EF grants ownership on correct code. When
//              false the row sits in the admin queue tagged
//              "code-verified, awaiting manual approval".
//   ai_email → auto_verify_ai_email (default true). Same semantics as
//              ai_call but for the on-domain email OTP path.
//   video    → auto_verify_video    (default false). Legacy. When true
//              a submitted video URL grants ownership immediately;
//              false routes to the admin queue. The new /add UI no
//              longer offers video, but the flag stays for any
//              historical rows the admin queue still surfaces.
//
// Auth: caller's JWT email must be in public.super_admins.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

type Method = "ai_call" | "ai_email" | "video";
type Body = { method?: Method; enabled?: boolean };

const COLUMN: Record<
  Method,
  "auto_verify_ai_call" | "auto_verify_ai_email" | "auto_verify_video"
> = {
  ai_call: "auto_verify_ai_call",
  ai_email: "auto_verify_ai_email",
  video: "auto_verify_video",
};

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

  const admin = adminClient(envRes.env);
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  if (
    body.method !== "ai_call" &&
    body.method !== "ai_email" &&
    body.method !== "video"
  ) {
    return json(
      { ok: false, error: "method must be ai_call | ai_email | video" },
      400,
    );
  }
  if (typeof body.enabled !== "boolean") {
    return json({ ok: false, error: "enabled must be a boolean" }, 400);
  }

  const column = COLUMN[body.method];
  const { data, error } = await admin
    .from("app_settings")
    .update({ [column]: body.enabled, updated_by: userId })
    .eq("id", 1)
    .select(
      "auto_verify_ai_call, auto_verify_ai_email, auto_verify_video, updated_at",
    )
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
    autoVerifyAiEmail: data.auto_verify_ai_email,
    autoVerifyVideo: data.auto_verify_video,
    autoVerifyUpdatedAt: data.updated_at,
  });
});
