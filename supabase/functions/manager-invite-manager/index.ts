// Supabase Edge Function — manager-invite-manager
//
// Invite a colleague to the venue as owner / editor / viewer. Two
// paths:
//
//   1. Email matches an existing managers row → link directly: insert
//      venue_members at the requested role. No email goes out.
//
//   2. Email is unknown → create a manager_invites row with a fresh
//      token AND ask Supabase Auth to send the standard invite email
//      (auth.admin.inviteUserByEmail). The redirect URL embeds our
//      token so the accept page can claim the invite once the new
//      user sets a password.
//
// Caller must be an owner of the venue (super-admins pass through).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireOwner,
} from "../_shared/auth.ts";
import { isEmailish } from "../_shared/input.ts";
import { isManagerRole, type ManagerRole } from "../_shared/roles.ts";
import { newInviteToken } from "../_shared/tokens.ts";

type Body = {
  venueId?: string;
  email?: string;
  role?: ManagerRole;
  redirectBase?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  let body: Body = {};
  try { body = (await req.json()) as Body; } catch { /* empty */ }
  const venueId = (body.venueId ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const role = body.role ?? "manager";
  const redirectBase = (body.redirectBase ?? "").trim().replace(/\/$/, "");
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (!isEmailish(email)) {
    return json({ ok: false, error: "A valid email is required" }, 400);
  }
  if (!isManagerRole(role)) {
    return json({ ok: false, error: "role must be owner | manager | viewer" }, 400);
  }

  const admin = adminClient(envRes.env);
  const owner = await requireOwner(
    admin,
    authRes.user,
    venueId,
    "Only owners can invite members.",
  );
  if (!owner.ok) return owner.response;

  // Already on the team? Two parallel lookups: existing managers row
  // (drives the link-directly path), and any pending invite for the
  // same address (so we can short-circuit with a friendly error).
  const [existingManager, existingInvite] = await Promise.all([
    admin.from("managers").select("id").ilike("email", email).maybeSingle(),
    admin
      .from("manager_invites")
      .select("id, expires_at, claimed_at")
      .eq("venue_id", venueId)
      .ilike("email", email)
      .is("claimed_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle(),
  ]);

  if (existingManager.data) {
    const { data: existingMember } = await admin
      .from("venue_members")
      .select("id")
      .eq("venue_id", venueId)
      .eq("manager_id", existingManager.data.id)
      .maybeSingle();
    if (existingMember) {
      return json(
        { ok: false, code: "already_member", error: "That email is already on this team." },
        409,
      );
    }
    const ins = await admin
      .from("venue_members")
      .insert({ venue_id: venueId, manager_id: existingManager.data.id, role })
      .select("id")
      .single();
    if (ins.error) {
      return json({ ok: false, error: `member_insert: ${ins.error.message}` }, 500);
    }
    return json({ ok: true, mode: "linked", memberId: ins.data.id, email, role });
  }

  if (existingInvite.data) {
    return json(
      { ok: false, code: "invite_pending", error: "An invite for that email is already pending." },
      409,
    );
  }

  const token = newInviteToken();

  const invite = await admin
    .from("manager_invites")
    .insert({
      venue_id: venueId,
      email,
      role,
      token,
      created_by: authRes.user.id,
    })
    .select("id, token, expires_at")
    .single();
  if (invite.error) {
    return json({ ok: false, error: `invite_insert: ${invite.error.message}` }, 500);
  }

  // Supabase Auth handles SMTP + the signed magic link. Token + venueId
  // travel on the redirect so the accept page can claim the invite the
  // moment the new user sets their password.
  const redirectTo = redirectBase
    ? `${redirectBase}/accept-invite?token=${encodeURIComponent(token)}&venueId=${encodeURIComponent(venueId)}`
    : undefined;
  let emailSent = false;
  let emailError: string | null = null;
  try {
    const inviteRes = await admin.auth.admin.inviteUserByEmail(email, {
      data: { venueId, role, inviteToken: token },
      redirectTo,
    });
    if (inviteRes.error) {
      // "User already registered" is fine: the manager_invites row is
      // still good and the recipient can use the link directly.
      emailError = inviteRes.error.message;
    } else {
      emailSent = true;
    }
  } catch (err) {
    emailError = err instanceof Error ? err.message : "invite_email_failed";
  }

  return json({
    ok: true,
    mode: "invited",
    inviteId: invite.data.id,
    token: invite.data.token,
    expiresAt: invite.data.expires_at,
    email,
    role,
    emailSent,
    emailError,
  });
});
