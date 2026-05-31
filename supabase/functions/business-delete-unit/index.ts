// Supabase Edge Function — business-delete-unit
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
// Local:  supabase functions serve business-delete-unit
// Deploy: supabase functions deploy business-delete-unit

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireOwner,
} from "../_shared/auth.ts";

type DeleteBody = {
  id?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const bodyRes = await readJson<DeleteBody>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const venueId = (body.id ?? "").toString().trim();
  if (!venueId) return json({ ok: false, error: "id is required" }, 400);

  // Destructive operation — only owners (or super-admins) can delete.
  const admin = adminClient(envRes.env);
  const owner = await requireOwner(
    admin,
    authRes.user,
    venueId,
    "Only the owner can delete a unit",
  );
  if (!owner.ok) return owner.response;

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
