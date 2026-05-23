// Supabase Edge Function — manager-list-team
//
// Returns the active team of a venue in one round trip:
//   - managers : venue_members joined to managers (email-pool roles)
//   - waiters  : venue_roles joined to auth.users phones (phone-pool
//     staff)
//   - pendingManagerInvites
//   - pendingWaiterInvites
//   - myRole : caller's role on this venue (or "super_admin"), so the
//     UI doesn't have to derive owner-ness from the managers list and
//     gets the right answer for super-admins who skipped venue_members
//
// Auth: any signed-in member of the venue. Super-admins
// (public.super_admins) bypass the membership check.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";

type Body = { venueId?: string };

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
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);

  const admin = adminClient(envRes.env);
  const memberRes = await requireMembership(admin, authRes.user, venueId);
  if (!memberRes.ok) return memberRes.response;

  const nowIso = new Date().toISOString();

  // Four independent reads in parallel — no further fan-out except
  // for the waiter phone lookups below.
  const [mgrRows, roleRows, pendingMgrRows, pendingWaiterRows] = await Promise.all([
    admin
      .from("venue_members")
      .select("id, role, created_at, manager:managers(id, full_name, email)")
      .eq("venue_id", venueId)
      .order("created_at", { ascending: true }),
    admin
      .from("venue_roles")
      .select("user_id, role, created_at")
      .eq("venue_id", venueId)
      .eq("role", "staff")
      .order("created_at", { ascending: true }),
    admin
      .from("manager_invites")
      .select("id, email, role, token, created_at, expires_at")
      .eq("venue_id", venueId)
      .is("claimed_at", null)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false }),
    admin
      .from("staff_invites")
      .select("id, phone, channel, token, created_at, expires_at")
      .eq("venue_id", venueId)
      .is("claimed_at", null)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false }),
  ]);

  for (const r of [mgrRows, roleRows, pendingMgrRows, pendingWaiterRows]) {
    if (r.error) {
      return json({ ok: false, error: `read: ${r.error.message}` }, 500);
    }
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

  const waiters = await loadWaitersWithPhones(admin, roleRows.data ?? []);

  const pendingManagerInvites = (pendingMgrRows.data ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    token: r.token,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));

  const pendingWaiterInvites = (pendingWaiterRows.data ?? []).map((r) => ({
    id: r.id,
    phone: r.phone,
    channel: r.channel ?? "whatsapp",
    token: r.token,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));

  // `myRole` lets the client gate UI without re-deriving from the
  // managers list (super-admins aren't always in venue_members).
  const myRole = memberRes.membership.isSuperAdmin
    ? "super_admin"
    : memberRes.membership.role;

  return json({
    ok: true,
    myRole,
    managers,
    waiters,
    pendingManagerInvites,
    pendingWaiterInvites,
  });
});

// ─── Waiter phone hydration ─────────────────────────────────────────
//
// venue_roles only stores user_id; the phone lives on auth.users.
// Until we add a phone column to venue_roles we have to read each
// auth user — running them in parallel keeps the latency flat.

type RoleRow = { user_id: string; role: string; created_at: string };

async function loadWaitersWithPhones(
  admin: SupabaseClient,
  rows: RoleRow[],
): Promise<{ userId: string; phone: string | null; createdAt: string }[]> {
  if (rows.length === 0) return [];
  const phones = await Promise.all(
    rows.map((r) =>
      admin.auth.admin
        .getUserById(r.user_id)
        .then((u) => (u.data.user?.phone ? `+${u.data.user.phone}` : null))
        .catch(() => null),
    ),
  );
  return rows.map((r, i) => ({
    userId: r.user_id,
    phone: phones[i],
    createdAt: r.created_at,
  }));
}
