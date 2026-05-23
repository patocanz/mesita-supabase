// Supabase Edge Function — manager-update-member-role
//
// Promote / demote a venue member. Owners only. The last owner of a
// venue can never be demoted — there has to be at least one owner at
// rest, otherwise no one can re-invite. (Removing the last owner is
// also blocked by manager-remove-member.)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = {
  memberId?: string;
  role?: "owner" | "manager" | "viewer";
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
  const memberId = (body.memberId ?? "").trim();
  const role = (body.role ?? "") as Body["role"];
  if (!memberId) return json({ ok: false, error: "memberId is required" }, 400);
  if (!role || !ROLE_VALUES.has(role)) {
    return json({ ok: false, error: "role must be owner | manager | viewer" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const target = await admin
    .from("venue_members")
    .select("id, venue_id, manager_id, role")
    .eq("id", memberId)
    .maybeSingle();
  if (target.error) {
    return json({ ok: false, error: `member_read: ${target.error.message}` }, 500);
  }
  if (!target.data) {
    return json({ ok: false, error: "Member not found." }, 404);
  }

  // Authorization: owner of the same venue (or super-admin).
  let canEdit = false;
  if (callerEmail) {
    const { data: saRow } = await admin
      .from("super_admins")
      .select("email")
      .eq("email", callerEmail)
      .maybeSingle();
    if (saRow) canEdit = true;
  }
  if (!canEdit) {
    const { data: callerRow } = await admin
      .from("venue_members")
      .select("role")
      .eq("venue_id", target.data.venue_id)
      .eq("manager_id", callerId)
      .maybeSingle();
    if (callerRow?.role === "owner") canEdit = true;
  }
  if (!canEdit) {
    return json({ ok: false, error: "Only owners can change roles." }, 403);
  }

  // Last-owner guard: refuse to demote the only owner.
  if (target.data.role === "owner" && role !== "owner") {
    const { count } = await admin
      .from("venue_members")
      .select("id", { count: "exact", head: true })
      .eq("venue_id", target.data.venue_id)
      .eq("role", "owner");
    if ((count ?? 0) <= 1) {
      return json(
        { ok: false, code: "last_owner", error: "Promote another owner first." },
        409,
      );
    }
  }

  const upd = await admin
    .from("venue_members")
    .update({ role })
    .eq("id", memberId)
    .select("id, role")
    .single();
  if (upd.error) {
    return json({ ok: false, error: `member_update: ${upd.error.message}` }, 500);
  }

  return json({ ok: true, memberId: upd.data.id, role: upd.data.role });
});
