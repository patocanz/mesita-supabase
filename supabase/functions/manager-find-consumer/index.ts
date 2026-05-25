// Supabase Edge Function — manager-find-consumer
//
// Authenticated. A validator (any venue_member) looks up a consumer by
// the 6-char code on their QR. Returns the consumer's display name +
// current cashback balance so the validator UI can show "Pato — $55
// available" before opening a ticket. Membership of *some* venue is
// enough — we don't enforce which venue here because lookup is global.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";

type Body = { code?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const code = (body.code ?? "").toString().trim().toUpperCase();
  if (code.length < 4 || code.length > 12) {
    return json({ ok: false, error: "Code must be 4-12 characters" }, 400);
  }

  const admin = adminClient(envRes.env);

  // Caller must be a member of at least one venue. This blocks random
  // signed-in consumers from probing other people's codes for their names /
  // balances.
  const callerMembership = await admin
    .from("venue_members")
    .select("manager_id", { count: "exact", head: true })
    .eq("manager_id", authRes.user.id)
    .limit(1);
  if (callerMembership.error) {
    return json({ ok: false, error: `auth_check: ${callerMembership.error.message}` }, 500);
  }
  if (!callerMembership.count) {
    return json({ ok: false, error: "Not a venue member" }, 403);
  }

  const { data: consumer, error } = await admin
    .from("consumers")
    .select("id, code, full_name, cashback_balance_cents")
    .eq("code", code)
    .maybeSingle();
  if (error) {
    return json({ ok: false, error: `lookup: ${error.message}` }, 500);
  }
  if (!consumer) {
    return json({ ok: false, error: `No consumer with code ${code}` }, 404);
  }

  return json({ ok: true, consumer });
});
