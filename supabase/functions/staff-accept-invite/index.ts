// Supabase Edge Function — staff-accept-invite
//
// Called by a logged-in user (already authed via consumer phone OTP) to
// redeem an invite token a manager sent them. Steps:
//
//   1. Validate the invite token: exists, unexpired, unclaimed.
//   2. Optional phone match: if the invite carried a pre-bound phone,
//      reject unless the caller's auth.user.phone matches.
//   3. Insert a venue_roles row (user_id, venue_id, role='staff').
//   4. Mark the invite claimed by this user.
//   5. Flip app_metadata.role to 'staff' so future JWTs carry the new
//      claim. Caller must refreshSession() before relying on it.
//
// All writes via service role inside a single function — no
// function-to-function composition.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";
import { clean } from "../_shared/input.ts";

type Body = { token?: string | null };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

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
  const user = userData.user;

  // Staff is the phone-pool role. Reject email-authed callers.
  if (!user.phone) {
    return json(
      { ok: false, error: "Staff invites are redeemed by phone-authed users." },
      400,
    );
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const token = clean(body.token, 128);
  if (!token) {
    return json({ ok: false, error: "Missing invite token" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Look up the invite.
  const invite = await admin
    .from("staff_invites")
    .select("id, venue_id, phone, claimed_at, expires_at, created_by")
    .eq("token", token)
    .maybeSingle();
  if (invite.error) {
    return json({ ok: false, error: `invite_read: ${invite.error.message}` }, 500);
  }
  if (!invite.data) {
    return json({ ok: false, error: "Invite not found or already revoked." }, 404);
  }
  if (invite.data.claimed_at) {
    return json({ ok: false, error: "This invite was already claimed." }, 409);
  }
  if (new Date(invite.data.expires_at).getTime() < Date.now()) {
    return json({ ok: false, error: "This invite has expired." }, 410);
  }
  if (invite.data.phone && invite.data.phone !== user.phone) {
    return json(
      { ok: false, error: "This invite is bound to a different phone number." },
      403,
    );
  }

  // 2. Insert venue_roles row. Idempotent — on conflict, do nothing.
  const upsert = await admin
    .from("venue_roles")
    .upsert(
      {
        user_id: user.id,
        venue_id: invite.data.venue_id,
        role: "staff",
        invited_by: invite.data.created_by,
      },
      { onConflict: "user_id,venue_id", ignoreDuplicates: false },
    )
    .select("user_id, venue_id, role")
    .single();
  if (upsert.error) {
    return json({ ok: false, error: `venue_roles_upsert: ${upsert.error.message}` }, 500);
  }

  // 3. Mark the invite claimed.
  const claim = await admin
    .from("staff_invites")
    .update({ claimed_at: new Date().toISOString(), claimed_by: user.id })
    .eq("id", invite.data.id)
    .is("claimed_at", null);
  if (claim.error) {
    return json({ ok: false, error: `invite_claim: ${claim.error.message}` }, 500);
  }

  // 4. Promote app_metadata.role from 'consumer' (or unset) to 'staff'.
  //    Skip if the user is already a manager/admin (they shouldn't be in
  //    this pool, but defence in depth).
  const currentRole =
    (user.app_metadata as Record<string, unknown> | null)?.role as string | undefined;
  if (currentRole !== "manager" && currentRole !== "admin") {
    const stamp = await admin.auth.admin.updateUserById(user.id, {
      app_metadata: { ...(user.app_metadata ?? {}), role: "staff" },
    });
    if (stamp.error) {
      return json({ ok: false, error: `role_stamp: ${stamp.error.message}` }, 500);
    }
  }

  return json({
    ok: true,
    role: "staff",
    venue_id: invite.data.venue_id,
  });
});
