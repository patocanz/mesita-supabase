// Supabase Edge Function — manager-accept-invite
//
// Called by a logged-in manager to claim an invite. Steps:
//
//   1. Validate the invite token: exists, unexpired, unclaimed.
//   2. Ensure a `managers` profile exists for the caller (creates one
//      from the JWT email if missing — the Supabase invite flow already
//      created the auth.users row).
//   3. Insert venue_members at the stored role.
//   4. Mark the invite claimed.
//   5. Stamp app_metadata.role = 'manager' for future JWTs.
//
// Self-contained; no function-to-function calls.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

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
  const userEmail = user.email?.toLowerCase() ?? null;

  let body: Body = {};
  try { body = (await req.json()) as Body; } catch { /* empty */ }
  const token = (body.token ?? "").toString().trim();
  if (!token) return json({ ok: false, error: "Missing invite token" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Look up the invite.
  const invite = await admin
    .from("manager_invites")
    .select("id, venue_id, email, role, claimed_at, expires_at")
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
  if (userEmail && invite.data.email.toLowerCase() !== userEmail) {
    return json(
      { ok: false, error: "This invite was sent to a different email address." },
      403,
    );
  }

  // 2. Ensure a managers profile exists (the invite flow may have left
  //    auth.users without a corresponding row).
  const { data: existingMgr } = await admin
    .from("managers")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (!existingMgr) {
    const ins = await admin
      .from("managers")
      .insert({
        id: user.id,
        email: userEmail,
        full_name: (user.user_metadata?.full_name as string | null) ?? null,
      });
    if (ins.error) {
      return json({ ok: false, error: `manager_profile: ${ins.error.message}` }, 500);
    }
  }

  // 3. Upsert the venue_members row at the invited role.
  const upsert = await admin
    .from("venue_members")
    .upsert(
      {
        venue_id: invite.data.venue_id,
        manager_id: user.id,
        role: invite.data.role,
      },
      { onConflict: "venue_id,manager_id", ignoreDuplicates: false },
    )
    .select("id, role")
    .single();
  if (upsert.error) {
    return json({ ok: false, error: `member_upsert: ${upsert.error.message}` }, 500);
  }

  // 4. Mark the invite claimed (idempotent on second click).
  const claim = await admin
    .from("manager_invites")
    .update({ claimed_at: new Date().toISOString(), claimed_by: user.id })
    .eq("id", invite.data.id)
    .is("claimed_at", null);
  if (claim.error) {
    return json({ ok: false, error: `invite_claim: ${claim.error.message}` }, 500);
  }

  // 5. Stamp app_metadata.role = 'manager' so JWTs carry it.
  const currentRole =
    (user.app_metadata as Record<string, unknown> | null)?.role as string | undefined;
  if (currentRole !== "manager" && currentRole !== "admin") {
    const stamp = await admin.auth.admin.updateUserById(user.id, {
      app_metadata: { ...(user.app_metadata ?? {}), role: "manager" },
    });
    if (stamp.error) {
      return json({ ok: false, error: `role_stamp: ${stamp.error.message}` }, 500);
    }
  }

  return json({
    ok: true,
    venueId: invite.data.venue_id,
    role: upsert.data.role,
  });
});
