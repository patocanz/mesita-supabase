// Supabase Edge Function — manager-invite-manager
//
// Invite a colleague to the venue as owner / editor / viewer. Two paths:
//
//   1. Email matches an existing managers row → link directly: insert
//      venue_members at the requested role. No email goes out.
//
//   2. Email is unknown → create a manager_invites row with a fresh
//      token AND ask Supabase Auth to send the standard invite email
//      (auth.admin.inviteUserByEmail). The redirect URL embeds our
//      token so the accept page can claim the invite once the new user
//      sets a password.
//
// Caller must be an owner of the venue (super-admins pass through).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = {
  venueId?: string;
  email?: string;
  role?: "owner" | "manager" | "viewer";
  redirectBase?: string;
};

const ROLE_VALUES = new Set(["owner", "manager", "viewer"]);

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
  const callerId = userData.user.id;
  const callerEmail = userData.user.email?.toLowerCase() ?? null;

  let body: Body = {};
  try { body = (await req.json()) as Body; } catch { /* empty */ }
  const venueId = (body.venueId ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const role = (body.role ?? "manager") as Body["role"];
  const redirectBase = (body.redirectBase ?? "").trim().replace(/\/$/, "");
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: "A valid email is required" }, 400);
  }
  if (!role || !ROLE_VALUES.has(role)) {
    return json({ ok: false, error: "role must be owner | manager | viewer" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Authorization: caller must be an owner of this venue (or super-admin).
  let canInvite = false;
  if (callerEmail) {
    const { data: saRow } = await admin
      .from("super_admins")
      .select("email")
      .eq("email", callerEmail)
      .maybeSingle();
    if (saRow) canInvite = true;
  }
  if (!canInvite) {
    const { data: vmRow } = await admin
      .from("venue_members")
      .select("role")
      .eq("venue_id", venueId)
      .eq("manager_id", callerId)
      .maybeSingle();
    if (vmRow?.role === "owner") canInvite = true;
  }
  if (!canInvite) {
    return json({ ok: false, error: "Only owners can invite members." }, 403);
  }

  // Already on the team?
  const { data: existingManager } = await admin
    .from("managers")
    .select("id")
    .ilike("email", email)
    .maybeSingle();
  if (existingManager) {
    const { data: existingMember } = await admin
      .from("venue_members")
      .select("id")
      .eq("venue_id", venueId)
      .eq("manager_id", existingManager.id)
      .maybeSingle();
    if (existingMember) {
      return json(
        { ok: false, code: "already_member", error: "That email is already on this team." },
        409,
      );
    }
    // Direct link — no email needed. The manager already has an account.
    const ins = await admin
      .from("venue_members")
      .insert({ venue_id: venueId, manager_id: existingManager.id, role })
      .select("id")
      .single();
    if (ins.error) {
      return json({ ok: false, error: `member_insert: ${ins.error.message}` }, 500);
    }
    return json({ ok: true, mode: "linked", memberId: ins.data.id, email, role });
  }

  // Pending invite already? Bounce so the inviter clicks "Resend" instead.
  const { data: existingInvite } = await admin
    .from("manager_invites")
    .select("id, expires_at, claimed_at")
    .eq("venue_id", venueId)
    .ilike("email", email)
    .is("claimed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (existingInvite) {
    return json(
      { ok: false, code: "invite_pending", error: "An invite for that email is already pending." },
      409,
    );
  }

  // Fresh token. URL-safe base64 of 18 random bytes (same scheme as
  // staff_invites).
  const token = base64UrlSafe(crypto.getRandomValues(new Uint8Array(18)));

  const invite = await admin
    .from("manager_invites")
    .insert({
      venue_id: venueId,
      email,
      role,
      token,
      created_by: callerId,
    })
    .select("id, token, expires_at")
    .single();
  if (invite.error) {
    return json({ ok: false, error: `invite_insert: ${invite.error.message}` }, 500);
  }

  // Fire the Supabase invite email. Supabase Auth handles SMTP + the
  // signed magic link. We tack the token + venueId onto the redirect
  // so the accept page can claim the invite right after the new user
  // sets their password.
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
      // "User already registered" — fine, we still have the manager_invites
      // row; they can use the link without a Supabase invite email.
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

function base64UrlSafe(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
