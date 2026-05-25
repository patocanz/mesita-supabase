// One-time-code helpers shared by every ownership-verification EF.
//
// Why centralised: the phone/email OTP flows both generate a 6-digit
// code, hash it, store the hash on the venue_verifications row, and
// compare on redemption. Four EFs (`business-sends-phone-otp`,
// `business-sends-email-otp`, `business-verifies-{phone,email}`) used to
// reimplement the same primitives + flow control. The higher-level
// helpers below (`insertPendingOtpVerification`, `redeemOtpVerification`)
// keep both paths in lock-step. Pure utilities — no Deno globals
// beyond `crypto`, safe to import anywhere.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { json } from "./http.ts";

// Cryptographically random 6-digit string, zero-padded. Uses the
// Web Crypto Uint32 source; uniform enough for an OTP (the modulo
// bias on 10^6 from 2^32 is negligible).
export function randomSixDigits(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % 1_000_000).toString().padStart(6, "0");
}

// Lowercase hex SHA-256 of a UTF-8 string. We never store the raw OTP
// — only this hash — so a DB leak doesn't hand out codes.
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Phase 1: insert pending OTP verification ──────────────────────

export type OtpMethod = "ai_call" | "ai_email";

// Drops any prior pending claim by this requester on this venue, then
// inserts a fresh pending row with the codeHash baked into the payload.
// Both send-OTP EFs use this identically — only the method tag and the
// extra payload fields (phoneCalled vs emailSent, channel vs websiteUrl)
// differ between callers.
export async function insertPendingOtpVerification(
  admin: SupabaseClient,
  args: {
    venueId: string;
    userId: string;
    requesterEmail: string;
    method: OtpMethod;
    // Method-specific payload pieces; codeHash is added by this helper
    // so callers don't have to remember it.
    payload: Record<string, unknown>;
    codeHash: string;
  },
): Promise<{ ok: true; verificationId: string } | { ok: false; response: Response }> {
  await admin
    .from("venue_verifications")
    .delete()
    .eq("venue_id", args.venueId)
    .eq("requester_id", args.userId)
    .eq("status", "pending");

  const { data, error } = await admin
    .from("venue_verifications")
    .insert({
      venue_id: args.venueId,
      requester_id: args.userId,
      method: args.method,
      payload: { ...args.payload, codeHash: args.codeHash },
      requester_email: args.requesterEmail,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) {
    return {
      ok: false,
      response: json({ ok: false, error: `verification_insert: ${error.message}` }, 500),
    };
  }
  return { ok: true, verificationId: data.id as string };
}

// ─── Phase 2: redeem OTP (verify code, conditionally grant ownership) ──

// One redemption helper, identical for ai_call and ai_email. Caller
// passes the methodFilter (so an email code can't redeem a phone row)
// and the column on app_settings that gates auto-vs-manual approval.
//
// Returns a Response either way — success path returns the JSON the
// EF would have built itself. Hard errors get baked into 4xx/5xx
// responses with the same shape every other EF uses.
export async function redeemOtpVerification(
  admin: SupabaseClient,
  args: {
    verificationId: string;
    code: string;
    userId: string;
    methodFilter: OtpMethod;
    autoVerifyColumn: "auto_verify_ai_call" | "auto_verify_ai_email";
  },
): Promise<Response> {
  if (!/^\d{6}$/.test(args.code)) {
    return json({ ok: false, error: "code must be 6 digits" }, 400);
  }

  const { data: verification, error: lookupError } = await admin
    .from("venue_verifications")
    .select("id, venue_id, requester_id, method, payload, status")
    .eq("id", args.verificationId)
    .maybeSingle();
  if (lookupError) {
    return json({ ok: false, error: `verification_lookup: ${lookupError.message}` }, 500);
  }
  if (!verification) {
    return json({ ok: false, error: "Verification not found" }, 404);
  }
  if (verification.requester_id !== args.userId) {
    return json(
      { ok: false, error: "This verification belongs to another operator" },
      403,
    );
  }
  if (verification.method !== args.methodFilter) {
    return json(
      {
        ok: false,
        error: `Code verification only applies to ${args.methodFilter} requests`,
      },
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

  const payload = verification.payload as Record<string, unknown>;
  const storedHash =
    typeof payload.codeHash === "string" ? (payload.codeHash as string) : null;
  if (!storedHash) {
    return json(
      { ok: false, error: "This request has no code to verify against" },
      500,
    );
  }

  const inputHash = await sha256Hex(args.code);
  if (inputHash !== storedHash) {
    return json(
      { ok: false, code: "wrong_code", error: "That code didn't match." },
      400,
    );
  }

  const { data: settings } = await admin
    .from("app_settings")
    .select(args.autoVerifyColumn)
    .eq("id", 1)
    .maybeSingle();
  const autoVerify =
    (settings as Record<string, boolean | null> | null)?.[args.autoVerifyColumn] !== false;
  const now = new Date().toISOString();

  if (!autoVerify) {
    // Manual-review path: stamp codeVerifiedAt so the admin queue
    // shows "verified, awaiting approval". Status stays pending.
    const nextPayload = { ...payload, codeVerifiedAt: now };
    const { error: payloadError } = await admin
      .from("venue_verifications")
      .update({ payload: nextPayload })
      .eq("id", args.verificationId);
    if (payloadError) {
      return json(
        { ok: false, error: `verification_update: ${payloadError.message}` },
        500,
      );
    }
    return json({ ok: true, venueId: verification.venue_id, awaitingAdmin: true });
  }

  // Auto-approve: mark approved + grant ownership.
  const { error: updateError } = await admin
    .from("venue_verifications")
    .update({
      status: "approved",
      decided_at: now,
      decided_by: args.userId,
      decided_via: "auto",
    })
    .eq("id", args.verificationId);
  if (updateError) {
    return json(
      { ok: false, error: `verification_update: ${updateError.message}` },
      500,
    );
  }

  const { error: memberError } = await admin.from("venue_members").insert({
    venue_id: verification.venue_id,
    business_id: args.userId,
    role: "owner",
  });
  if (memberError) {
    // Roll the approval back. A unique-violation here means a parallel
    // claim won (the venue is already owned); surface it so the operator
    // can use the contact / report-fraud flow.
    await admin
      .from("venue_verifications")
      .update({
        status: "pending",
        decided_at: null,
        decided_by: null,
        decided_via: null,
      })
      .eq("id", args.verificationId);
    return json(
      { ok: false, error: `ownership_grant: ${memberError.message}` },
      500,
    );
  }

  return json({ ok: true, venueId: verification.venue_id, awaitingAdmin: false });
}
