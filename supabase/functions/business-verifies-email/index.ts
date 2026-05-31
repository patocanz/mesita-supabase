// Supabase Edge Function — business-verifies-email
//
// Phase 2 of the automatic-email path. The operator received the
// 6-digit code at the venue's on-domain email (or saw it in the mock
// banner) and typed it into the UI. This EF hash-compares against
// payload.codeHash and either:
//
//   - grants ownership immediately (auto_verify_ai_email=true, default)
//   - leaves the row pending with payload.codeVerifiedAt stamped, so
//     the admin queue can show "verified, awaiting manual approval"
//
// Mirrors business-verifies-phone end-to-end; the only differences are
// the method filter (ai_email) and the auto-verify flag it consults
// (auto_verify_ai_email).
//
// Auth: any signed-in user. Only the original requester can redeem.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { redeemOtpVerification } from "../_shared/otp.ts";

type Body = { verificationId?: string; code?: string };

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

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const verificationId = (body.verificationId ?? "").trim();
  const code = (body.code ?? "").trim();
  if (!verificationId) {
    return json({ ok: false, error: "verificationId is required" }, 400);
  }

  return redeemOtpVerification(adminClient(envRes.env), {
    verificationId,
    code,
    userId,
    methodFilter: "ai_email",
    autoVerifyColumn: "auto_verify_ai_email",
  });
});

