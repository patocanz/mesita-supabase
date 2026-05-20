// Supabase Edge Function — admin-decide-verification
//
// Super-admin approves or rejects a pending ownership verification.
//
//   approve  → verification.status='approved' + a venue_members row
//              (role='owner', manager_id=requester) is inserted. The
//              venue itself is already active+web from
//              manager-create-unit; this EF only grants membership.
//   reject   → verification.status='rejected' with reject_reason. No
//              membership change. The manager can submit a fresh
//              request from /add.
//
// Auth: caller's JWT email must be in public.super_admins.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = {
  verificationId?: string;
  decision?: "approved" | "rejected";
  rejectReason?: string;
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

  // Body.
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const verificationId = (body.verificationId ?? "").trim();
  const decision = body.decision;
  const rejectReason = (body.rejectReason ?? "").trim();
  if (!verificationId) {
    return json({ ok: false, error: "verificationId is required" }, 400);
  }
  if (decision !== "approved" && decision !== "rejected") {
    return json(
      { ok: false, error: "decision must be 'approved' or 'rejected'" },
      400,
    );
  }
  if (decision === "rejected" && !rejectReason) {
    return json(
      { ok: false, error: "rejectReason is required for rejections" },
      400,
    );
  }

  // Fetch the row so we can act on its venue_id + requester_id, and
  // reject double-decides.
  const { data: verification, error: lookupError } = await admin
    .from("venue_verifications")
    .select("id, venue_id, requester_id, status")
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

  const now = new Date().toISOString();
  const { error: updateError } = await admin
    .from("venue_verifications")
    .update({
      status: decision,
      decided_at: now,
      decided_by: userId,
      decided_via: "admin",
      reject_reason: decision === "rejected" ? rejectReason : null,
    })
    .eq("id", verificationId);
  if (updateError) {
    return json(
      { ok: false, error: `verification_update: ${updateError.message}` },
      500,
    );
  }

  if (decision === "approved") {
    // Grant the requester ownership. The venue is already active+web;
    // membership is what gates manager access on /unit/<id>/*.
    const { error: memberError } = await admin.from("venue_members").insert({
      venue_id: verification.venue_id,
      manager_id: verification.requester_id,
      role: "owner",
    });
    if (memberError) {
      // Roll the verification back. A unique-violation here means a
      // parallel claim won (the venue is already owned); surface it
      // and let the admin reject this row in a follow-up.
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
  }

  return json({ ok: true });
});
