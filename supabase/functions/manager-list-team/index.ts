// Supabase Edge Function — manager-list-team
//
// Returns the active team of a venue in one round trip:
//   - managers : venue_members joined to managers (email-pool roles)
//   - waiters  : venue_roles joined to auth.users phones (phone-pool staff)
//   - pendingManagerInvites : manager_invites rows (claimed_at IS NULL,
//                             unexpired)
//   - pendingWaiterInvites  : staff_invites rows  (claimed_at IS NULL,
//                             unexpired)
//
// Auth: any signed-in member of the venue (any role). Super-admins
// (public.super_admins) bypass the membership check.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = { venueId?: string };

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
  const userId = userData.user.id;
  const userEmail = userData.user.email?.toLowerCase() ?? null;

  let body: Body = {};
  try { body = (await req.json()) as Body; } catch { /* empty */ }
  const venueId = (body.venueId ?? "").trim();
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Membership gate: super-admin OR a venue_members row in this venue.
  let isMember = false;
  if (userEmail) {
    const { data: saRow } = await admin
      .from("super_admins")
      .select("email")
      .eq("email", userEmail)
      .maybeSingle();
    if (saRow) isMember = true;
  }
  if (!isMember) {
    const { data: vmRow } = await admin
      .from("venue_members")
      .select("role")
      .eq("venue_id", venueId)
      .eq("manager_id", userId)
      .maybeSingle();
    if (vmRow) isMember = true;
  }
  if (!isMember) {
    return json({ ok: false, error: "Not a member of this venue" }, 403);
  }

  // Managers: venue_members joined to managers (full_name/email).
  const mgrRows = await admin
    .from("venue_members")
    .select("id, role, created_at, manager:managers(id, full_name, email)")
    .eq("venue_id", venueId)
    .order("created_at", { ascending: true });
  if (mgrRows.error) {
    return json({ ok: false, error: `members_read: ${mgrRows.error.message}` }, 500);
  }
  type ManagerJoin = {
    id: string;
    role: string;
    created_at: string;
    manager: { id: string; full_name: string | null; email: string | null } | null;
  };
  const managers = ((mgrRows.data ?? []) as ManagerJoin[])
    .filter((r) => r.manager != null)
    .map((r) => ({
      memberId: r.id,
      userId: r.manager!.id,
      role: r.role,
      fullName: r.manager!.full_name,
      email: r.manager!.email,
      createdAt: r.created_at,
    }));

  // Waiters: venue_roles + lookup phone/email from auth.users via admin.
  const roleRows = await admin
    .from("venue_roles")
    .select("user_id, role, created_at")
    .eq("venue_id", venueId)
    .eq("role", "staff")
    .order("created_at", { ascending: true });
  if (roleRows.error) {
    return json({ ok: false, error: `roles_read: ${roleRows.error.message}` }, 500);
  }
  type WaiterRow = { user_id: string; role: string; createdAt: string; phone: string | null };
  const waiters: { userId: string; phone: string | null; createdAt: string }[] = [];
  for (const r of roleRows.data ?? []) {
    const u = await admin.auth.admin.getUserById(r.user_id);
    waiters.push({
      userId: r.user_id,
      phone: u.data.user?.phone ? `+${u.data.user.phone}` : null,
      createdAt: r.created_at as string,
    } as WaiterRow & { userId: string });
  }

  // Pending invites (managers).
  const nowIso = new Date().toISOString();
  const pendingMgrRows = await admin
    .from("manager_invites")
    .select("id, email, role, token, created_at, expires_at")
    .eq("venue_id", venueId)
    .is("claimed_at", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false });
  if (pendingMgrRows.error) {
    return json({ ok: false, error: `mgr_invites_read: ${pendingMgrRows.error.message}` }, 500);
  }
  const pendingManagerInvites = (pendingMgrRows.data ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    token: r.token,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));

  // Pending invites (waiters).
  const pendingWaiterRows = await admin
    .from("staff_invites")
    .select("id, phone, channel, token, created_at, expires_at")
    .eq("venue_id", venueId)
    .is("claimed_at", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false });
  if (pendingWaiterRows.error) {
    return json({ ok: false, error: `waiter_invites_read: ${pendingWaiterRows.error.message}` }, 500);
  }
  const pendingWaiterInvites = (pendingWaiterRows.data ?? []).map((r) => ({
    id: r.id,
    phone: r.phone,
    channel: r.channel ?? "whatsapp",
    token: r.token,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));

  return json({
    ok: true,
    managers,
    waiters,
    pendingManagerInvites,
    pendingWaiterInvites,
  });
});
