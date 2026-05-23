// Supabase Edge Function — manager-remove-member
//
// Removes one team artefact from a venue. The `kind` discriminates:
//
//   manager   → venue_members row (cannot remove last owner)
//   waiter    → venue_roles row
//   mgrInvite → manager_invites row (revoke pending email invite)
//   waiterInvite → staff_invites row (revoke pending waiter invite)
//
// Owners (and super-admins) can remove anyone. Editors / viewers cannot
// remove other members. Anyone can remove themselves from a venue
// (handy "leave team" affordance) — except the last owner.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Kind = "manager" | "waiter" | "mgrInvite" | "waiterInvite";
type Body = { id?: string; kind?: Kind };

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
  const id = (body.id ?? "").trim();
  const kind = body.kind;
  if (!id) return json({ ok: false, error: "id is required" }, 400);
  if (!kind || !["manager", "waiter", "mgrInvite", "waiterInvite"].includes(kind)) {
    return json({ ok: false, error: "kind must be manager | waiter | mgrInvite | waiterInvite" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve the venue_id + (for the manager kind) the target manager_id.
  let venueId: string | null = null;
  let isSelfRemoval = false;
  let targetIsOwner = false;
  switch (kind) {
    case "manager": {
      const row = await admin
        .from("venue_members")
        .select("venue_id, manager_id, role")
        .eq("id", id)
        .maybeSingle();
      if (row.error) return json({ ok: false, error: `member_read: ${row.error.message}` }, 500);
      if (!row.data) return json({ ok: false, error: "Member not found." }, 404);
      venueId = row.data.venue_id;
      isSelfRemoval = row.data.manager_id === callerId;
      targetIsOwner = row.data.role === "owner";
      break;
    }
    case "waiter": {
      // venue_roles primary key is (user_id, venue_id); accept id formatted
      // as "userId:venueId".
      const [userId, venueIdFromKey] = id.split(":");
      if (!userId || !venueIdFromKey) {
        return json({ ok: false, error: "id must be userId:venueId" }, 400);
      }
      const row = await admin
        .from("venue_roles")
        .select("user_id, venue_id")
        .eq("user_id", userId)
        .eq("venue_id", venueIdFromKey)
        .maybeSingle();
      if (row.error) return json({ ok: false, error: `role_read: ${row.error.message}` }, 500);
      if (!row.data) return json({ ok: false, error: "Waiter not found on this venue." }, 404);
      venueId = row.data.venue_id;
      break;
    }
    case "mgrInvite": {
      const row = await admin
        .from("manager_invites")
        .select("venue_id")
        .eq("id", id)
        .maybeSingle();
      if (row.error) return json({ ok: false, error: `invite_read: ${row.error.message}` }, 500);
      if (!row.data) return json({ ok: false, error: "Invite not found." }, 404);
      venueId = row.data.venue_id;
      break;
    }
    case "waiterInvite": {
      const row = await admin
        .from("staff_invites")
        .select("venue_id")
        .eq("id", id)
        .maybeSingle();
      if (row.error) return json({ ok: false, error: `invite_read: ${row.error.message}` }, 500);
      if (!row.data) return json({ ok: false, error: "Invite not found." }, 404);
      venueId = row.data.venue_id;
      break;
    }
  }
  if (!venueId) return json({ ok: false, error: "Could not resolve venue." }, 500);

  // Authorization. Self-removal allowed always (subject to last-owner
  // check below). Otherwise owner / super-admin only.
  let canRemove = isSelfRemoval;
  if (!canRemove && callerEmail) {
    const { data: saRow } = await admin
      .from("super_admins")
      .select("email")
      .eq("email", callerEmail)
      .maybeSingle();
    if (saRow) canRemove = true;
  }
  if (!canRemove) {
    const { data: callerRow } = await admin
      .from("venue_members")
      .select("role")
      .eq("venue_id", venueId)
      .eq("manager_id", callerId)
      .maybeSingle();
    if (callerRow?.role === "owner") canRemove = true;
  }
  if (!canRemove) {
    return json({ ok: false, error: "Not allowed to remove this member." }, 403);
  }

  if (kind === "manager" && targetIsOwner) {
    const { count } = await admin
      .from("venue_members")
      .select("id", { count: "exact", head: true })
      .eq("venue_id", venueId)
      .eq("role", "owner");
    if ((count ?? 0) <= 1) {
      return json(
        { ok: false, code: "last_owner", error: "Promote another owner first." },
        409,
      );
    }
  }

  // Delete.
  let del;
  switch (kind) {
    case "manager":
      del = await admin.from("venue_members").delete().eq("id", id);
      break;
    case "waiter": {
      const [userId, venueIdFromKey] = id.split(":");
      del = await admin
        .from("venue_roles")
        .delete()
        .eq("user_id", userId)
        .eq("venue_id", venueIdFromKey);
      break;
    }
    case "mgrInvite":
      del = await admin.from("manager_invites").delete().eq("id", id);
      break;
    case "waiterInvite":
      del = await admin.from("staff_invites").delete().eq("id", id);
      break;
  }
  if (del?.error) {
    return json({ ok: false, error: `delete: ${del.error.message}` }, 500);
  }

  return json({ ok: true, id, kind });
});
