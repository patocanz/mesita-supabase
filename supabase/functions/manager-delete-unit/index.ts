// Supabase Edge Function — manager-delete-unit
//
// Authenticated. Deletes a venue (unit) the caller is an *owner* of, along
// with every dependent row. Self-contained: verifies the JWT, checks
// venue_members membership + role itself, then deletes via service role.
// Does NOT call any other Edge Function.
//
// Cascade order matters: tickets and cashback_ledger reference venues with
// ON DELETE RESTRICT, so they must be removed first. venue_members
// cascades automatically when the venue is dropped.
//
// Local:  supabase functions serve manager-delete-unit
// Deploy: supabase functions deploy manager-delete-unit

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type DeleteBody = {
  id?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

  // Auth caller.
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

  // Parse + validate.
  let body: DeleteBody = {};
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const venueId = (body.id ?? "").toString().trim();
  if (!venueId) return json({ ok: false, error: "id is required" }, 400);

  // Authorisation: must be the *owner* of this venue. Managers (non-owner
  // staff) can edit but can't delete — destructive operation needs a clear
  // single accountable role.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: membership, error: membershipError } = await admin
    .from("venue_members")
    .select("role")
    .eq("venue_id", venueId)
    .eq("manager_id", userId)
    .maybeSingle();
  if (membershipError) {
    return json({ ok: false, error: `membership_lookup: ${membershipError.message}` }, 500);
  }
  if (!membership) {
    return json({ ok: false, error: "Not a member of this venue" }, 403);
  }
  if (membership.role !== "owner") {
    return json({ ok: false, error: "Only the owner can delete a unit" }, 403);
  }

  // Cascade clean-up. cashback_ledger and tickets are ON DELETE RESTRICT
  // against venues, so we drop them first. venue_members and venue_links
  // cascade with the venue row itself.
  const { error: ledgerErr } = await admin
    .from("cashback_ledger")
    .delete()
    .eq("venue_id", venueId);
  if (ledgerErr) {
    return json({ ok: false, error: `cashback_ledger_delete: ${ledgerErr.message}` }, 500);
  }

  const { error: ticketsErr } = await admin
    .from("tickets")
    .delete()
    .eq("venue_id", venueId);
  if (ticketsErr) {
    return json({ ok: false, error: `tickets_delete: ${ticketsErr.message}` }, 500);
  }

  const { error: venueErr } = await admin
    .from("venues")
    .delete()
    .eq("id", venueId);
  if (venueErr) {
    return json({ ok: false, error: `venue_delete: ${venueErr.message}` }, 500);
  }

  return json({ ok: true, id: venueId });
});
