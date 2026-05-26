// Supabase Edge Function — business-accept-invite
//
// Called by a logged-in business to claim an invite. Steps:
//
//   1. Validate the invite token (exists, unexpired, unclaimed,
//      addressed to the caller's email).
//   2. Ensure a `businesses` profile exists for the caller — the
//      Supabase invite flow creates the auth.users row but never
//      writes our domain table.
//   3. Insert venue_members at the stored role (upsert is idempotent
//      so a double-click is harmless).
//   4. Mark the invite claimed.
//   5. Stamp app_metadata.role = 'business' so future JWTs carry it.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";

type Body = { token?: string | null };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const user = authRes.user;

  let body: Body = {};
  try { body = (await req.json()) as Body; } catch { /* empty */ }
  const token = (body.token ?? "").toString().trim();
  if (!token) return json({ ok: false, error: "Missing invite token" }, 400);

  const admin = adminClient(envRes.env);

  const invite = await admin
    .from("business_invites")
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
  if (user.emailLower && invite.data.email.toLowerCase() !== user.emailLower) {
    return json(
      { ok: false, error: "This invite was sent to a different email address." },
      403,
    );
  }

  const { data: existingBusiness } = await admin
    .from("businesses")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (!existingBusiness) {
    const ins = await admin.from("businesses").insert({
      id: user.id,
      email: user.emailLower,
      full_name: (user.raw?.user_metadata?.full_name as string | null) ?? null,
    });
    if (ins.error) {
      return json({ ok: false, error: `business_profile: ${ins.error.message}` }, 500);
    }
  }

  const upsert = await admin
    .from("venue_members")
    .upsert(
      {
        venue_id: invite.data.venue_id,
        business_id: user.id,
        role: invite.data.role,
      },
      { onConflict: "venue_id,business_id", ignoreDuplicates: false },
    )
    .select("id, role")
    .single();
  if (upsert.error) {
    return json({ ok: false, error: `member_upsert: ${upsert.error.message}` }, 500);
  }

  const claim = await admin
    .from("business_invites")
    .update({ claimed_at: new Date().toISOString(), claimed_by: user.id })
    .eq("id", invite.data.id)
    .is("claimed_at", null);
  if (claim.error) {
    return json({ ok: false, error: `invite_claim: ${claim.error.message}` }, 500);
  }

  if (user.appRole !== "business" && user.appRole !== "admin") {
    const stamp = await admin.auth.admin.updateUserById(user.id, {
      app_metadata: { ...(user.raw?.app_metadata ?? {}), role: "business" },
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
