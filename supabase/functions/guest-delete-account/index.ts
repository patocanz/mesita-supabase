// Supabase Edge Function — guest-delete-account
//
// Authenticated. Deletes the caller's own guest account along with every
// dependent row (tickets, cashback_ledger entries). Also deletes the
// underlying auth.users row so the email is freed up for re-signup.
// Self-contained: verifies the JWT, then deletes via service role. Does
// NOT call any other Edge Function.
//
// Cascade order matters: tickets and cashback_ledger reference guests
// with ON DELETE RESTRICT, so they must be removed first. The
// public.guests row PK references auth.users(id) ON DELETE CASCADE, so
// deleting the auth row drops the guests row too — we delete the auth
// row last for that reason.
//
// Local:  supabase functions serve guest-delete-account
// Deploy: supabase functions deploy guest-delete-account

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

  // Auth caller. Account deletion is *self-only* — the JWT identifies
  // which row to drop. No body needed.
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

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Cascade clean-up of dependent rows (RESTRICT FKs).
  const { error: ledgerErr } = await admin
    .from("cashback_ledger")
    .delete()
    .eq("guest_id", userId);
  if (ledgerErr) {
    return json({ ok: false, error: `cashback_ledger_delete: ${ledgerErr.message}` }, 500);
  }

  const { error: ticketsErr } = await admin
    .from("tickets")
    .delete()
    .eq("guest_id", userId);
  if (ticketsErr) {
    return json({ ok: false, error: `tickets_delete: ${ticketsErr.message}` }, 500);
  }

  // public.guests is ON DELETE CASCADE from auth.users — dropping the
  // auth row removes the guest row automatically. We delete the auth
  // user via the admin API to also kill the session + free the email.
  const { error: authErr } = await admin.auth.admin.deleteUser(userId);
  if (authErr) {
    return json({ ok: false, error: `auth_delete: ${authErr.message}` }, 500);
  }

  return json({ ok: true, id: userId });
});
