// Supabase Edge Function — consumer-delete-account
//
// Authenticated. Deletes the caller's own consumer account along with every
// dependent row (tickets, cashback_ledger entries). Also deletes the
// underlying auth.users row so the email is freed up for re-signup.
// Self-contained: verifies the JWT, then deletes via service role. Does
// NOT call any other Edge Function.
//
// Cascade order matters: tickets and cashback_ledger reference consumers
// with ON DELETE RESTRICT, so they must be removed first. The
// public.consumers row PK references auth.users(id) ON DELETE CASCADE, so
// deleting the auth row drops the consumers row too — we delete the auth
// row last for that reason.
//
// Local:  supabase functions serve consumer-delete-account
// Deploy: supabase functions deploy consumer-delete-account

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  // Account deletion is self-only — the JWT identifies which row to
  // drop. No body needed.
  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  const admin = adminClient(envRes.env);

  // Cascade clean-up of dependent rows (RESTRICT FKs).
  const { error: ledgerErr } = await admin
    .from("cashback_ledger")
    .delete()
    .eq("consumer_id", userId);
  if (ledgerErr) {
    return json({ ok: false, error: `cashback_ledger_delete: ${ledgerErr.message}` }, 500);
  }

  const { error: ticketsErr } = await admin
    .from("tickets")
    .delete()
    .eq("consumer_id", userId);
  if (ticketsErr) {
    return json({ ok: false, error: `tickets_delete: ${ticketsErr.message}` }, 500);
  }

  // public.consumers is ON DELETE CASCADE from auth.users — dropping the
  // auth row removes the consumer row automatically. We delete the auth
  // user via the admin API to also kill the session + free the email.
  const { error: authErr } = await admin.auth.admin.deleteUser(userId);
  if (authErr) {
    return json({ ok: false, error: `auth_delete: ${authErr.message}` }, 500);
  }

  return json({ ok: true, id: userId });
});
