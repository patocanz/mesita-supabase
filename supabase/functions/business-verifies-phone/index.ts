// Supabase Edge Function — business-verifies-phone
//
// Phase 2 of the automatic-phone path. The operator received the 6-digit
// code via the call/SMS (or saw it in the mock banner) and typed it
// into the UI. This EF hash-compares against the stored payload.codeHash
// and either:
//
//   - grants ownership immediately (auto_verify_ai_call=true, the default)
//   - leaves the row pending with payload.codeVerifiedAt stamped, so the
//     admin queue can show "code verified, awaiting manual approval"
//
// Auth: any signed-in user. The EF only accepts codes for rows where
// requester_id === auth.user.id, so businesses can't redeem codes from
// other operators' requests.

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
    methodFilter: "ai_call",
    autoVerifyColumn: "auto_verify_ai_call",
  });
});

