// Supabase Edge Function — business-update-member-role
//
// Promote / demote a venue member. Owners only. The last owner of a
// venue can never be demoted — there has to be at least one owner at
// rest, otherwise no one can re-invite. (Removing the last owner is
// also blocked by business-remove-member.)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireOwner,
} from "../_shared/auth.ts";
import { isManagerRole, type ManagerRole } from "../_shared/roles.ts";

type Body = {
  memberId?: string;
  role?: ManagerRole;
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
  const memberId = (body.memberId ?? "").trim();
  const role = body.role;
  if (!memberId) return json({ ok: false, error: "memberId is required" }, 400);
  if (!isManagerRole(role)) {
    return json({ ok: false, error: "role must be owner | manager | viewer" }, 400);
  }

  const admin = adminClient(envRes.env);

  const target = await admin
    .from("venue_members")
    .select("id, venue_id, business_id, role")
    .eq("id", memberId)
    .maybeSingle();
  if (target.error) {
    return json({ ok: false, error: `member_read: ${target.error.message}` }, 500);
  }
  if (!target.data) {
    return json({ ok: false, error: "Member not found." }, 404);
  }

  const owner = await requireOwner(
    admin,
    authRes.user,
    target.data.venue_id,
    "Only owners can change roles.",
  );
  if (!owner.ok) return owner.response;

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
