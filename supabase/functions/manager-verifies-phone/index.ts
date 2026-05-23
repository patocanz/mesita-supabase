// Supabase Edge Function — manager-verifies-phone
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
// requester_id === auth.user.id, so managers can't redeem codes from
// other operators' requests.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { sha256Hex } from "../_shared/otp.ts";

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

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const verificationId = (body.verificationId ?? "").trim();
  const code = (body.code ?? "").trim();
  if (!verificationId) {
    return json({ ok: false, error: "verificationId is required" }, 400);
  }
  if (!/^\d{6}$/.test(code)) {
    return json({ ok: false, error: "code must be 6 digits" }, 400);
  }

  const admin = adminClient(envRes.env);

  const { data: verification, error: lookupError } = await admin
    .from("venue_verifications")
    .select("id, venue_id, requester_id, method, payload, status")
    .eq("id", verificationId)
    .maybeSingle();
  if (lookupError) {
    return json(
      { ok: false, error: `verification_lookup: ${lookupError.message}` },
      500,
    );
  }
  if (!verification) {
    return json({ ok: false, error: "Verification not found" }, 404);
  }
  if (verification.requester_id !== userId) {
    return json(
      { ok: false, error: "This verification belongs to another operator" },
      403,
    );
  }
  if (verification.method !== "ai_call") {
    return json(
      { ok: false, error: "Code verification only applies to ai_call requests" },
      400,
    );
  }
  if (verification.status !== "pending") {
    return json(
      {
        ok: false,
        code: "already_decided",
        error: `Verification is already ${verification.status}.`,
      },
      409,
    );
  }

  const storedHash =
    typeof (verification.payload as Record<string, unknown>).codeHash === "string"
      ? ((verification.payload as Record<string, string>).codeHash as string)
      : null;
  if (!storedHash) {
    return json(
      { ok: false, error: "This request has no code to verify against" },
      500,
    );
  }

  const inputHash = await sha256Hex(code);
  if (inputHash !== storedHash) {
    return json(
      { ok: false, code: "wrong_code", error: "That code didn't match." },
      400,
    );
  }

  const { data: settings } = await admin
    .from("app_settings")
    .select("auto_verify_ai_call")
    .eq("id", 1)
    .maybeSingle();
  const autoVerify = settings?.auto_verify_ai_call !== false;
  const now = new Date().toISOString();

  if (!autoVerify) {
    // Manual-review path: stamp codeVerifiedAt so the admin queue
    // shows "verified, awaiting approval". Status stays pending.
    const nextPayload = {
      ...(verification.payload as Record<string, unknown>),
      codeVerifiedAt: now,
    };
    const { error: payloadError } = await admin
      .from("venue_verifications")
      .update({ payload: nextPayload })
      .eq("id", verificationId);
    if (payloadError) {
      return json(
        { ok: false, error: `verification_update: ${payloadError.message}` },
        500,
      );
    }
    return json({
      ok: true,
      venueId: verification.venue_id,
      awaitingAdmin: true,
    });
  }

  // Auto-approve: mark approved + grant ownership.
  const { error: updateError } = await admin
    .from("venue_verifications")
    .update({
      status: "approved",
      decided_at: now,
      decided_by: userId,
      decided_via: "auto",
    })
    .eq("id", verificationId);
  if (updateError) {
    return json(
      { ok: false, error: `verification_update: ${updateError.message}` },
      500,
    );
  }

  const { error: memberError } = await admin.from("venue_members").insert({
    venue_id: verification.venue_id,
    manager_id: userId,
    role: "owner",
  });
  if (memberError) {
    // Roll the approval back. A unique-violation here means a parallel
    // claim won (the venue is already owned); surface it so the
    // operator can use the contact / report-fraud flow.
    await admin
      .from("venue_verifications")
      .update({
        status: "pending",
        decided_at: null,
        decided_by: null,
        decided_via: null,
      })
      .eq("id", verificationId);
    return json(
      { ok: false, error: `ownership_grant: ${memberError.message}` },
      500,
    );
  }

  return json({
    ok: true,
    venueId: verification.venue_id,
    awaitingAdmin: false,
  });
});

