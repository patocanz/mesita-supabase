// Supabase Edge Function — admin-reset-database
//
// DESTRUCTIVE. Wipes all operational data (venues, tickets, consumers,
// businesses, staff invites, verifications, cashback ledger, venue roles)
// and deletes every auth.users row that isn't a super-admin. Preserves
// public.super_admins (and their auth accounts) plus the app_settings
// config singleton.
//
// Two guards before anything runs:
//   1. Caller's JWT email must be in public.super_admins.
//   2. Body must carry { confirm: "RESET" } — a typed phrase so a stray
//      click or replayed request can't trigger a wipe.
//
// The actual work lives in the public.admin_reset_database() SQL
// function (security definer, service-role only). This EF just gates and
// delegates.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

type Body = { confirm?: string };

const CONFIRM_PHRASE = "RESET";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const admin = adminClient(envRes.env);

  // --- Guard 1: super_admins gate. ---
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  // --- Guard 2: typed confirmation phrase. ---
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  if (body.confirm !== CONFIRM_PHRASE) {
    return json(
      { ok: false, error: `confirm must equal "${CONFIRM_PHRASE}"` },
      400,
    );
  }

  // --- Delegate to the locked-down SQL function. ---
  const { data, error } = await admin.rpc("admin_reset_database");
  if (error) {
    return json({ ok: false, error: `reset_failed: ${error.message}` }, 500);
  }

  return json({ ok: true, result: data });
});
