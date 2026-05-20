// Supabase Edge Function — manager-verify-call-code
//
// Phase 2 of the ai_call verification method. Manager submitted the
// initial request via manager-submit-verification (which generated a
// 6-digit OTP, hashed it, returned the plaintext in mock mode), the
// AI bot called the venue's Google-listed phone, the operator
// (manager) heard the code and typed it into the UI. This EF takes
// the typed code, compares its hash against the stored one, and on
// match marks the verification approved + inserts the venue_members
// owner row.
//
// Auth: any signed-in user. The EF only accepts codes for rows where
// requester_id === auth.user.id — managers can't redeem codes from
// other operators' requests.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = { verificationId?: string; code?: string };

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

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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
      {
        ok: false,
        error: "Code verification only applies to ai_call requests",
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

  const storedHash =
    typeof (verification.payload as Record<string, unknown>).codeHash ===
    "string"
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

  // Right code → approve + grant ownership.
  const now = new Date().toISOString();
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
    // Roll the approval back so the operator can retry / a different
    // path can grant ownership. A unique-violation here means a parallel
    // claim won (the venue is already owned).
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

  return json({ ok: true, venueId: verification.venue_id });
});

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
