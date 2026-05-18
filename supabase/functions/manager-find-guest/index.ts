// Supabase Edge Function — manager-find-guest
//
// Authenticated. A validator (any venue_member) looks up a guest by the
// 6-char code on their QR. Returns the guest's display name + current
// cashback balance so the validator UI can show "Pato — $55 available"
// before opening a ticket. Membership of *some* venue is enough — we
// don't enforce which venue here because lookup is global.
//
// Self-contained: own auth check, own DB read via service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Body = { code?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
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

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Caller must be a member of at least one venue. This blocks random
  // signed-in guests from probing other people's codes for their names /
  // balances.
  const callerMembership = await admin
    .from("venue_members")
    .select("manager_id", { count: "exact", head: true })
    .eq("manager_id", callerId)
    .limit(1);
  if (callerMembership.error) {
    return json({ ok: false, error: `auth_check: ${callerMembership.error.message}` }, 500);
  }
  if (!callerMembership.count) {
    return json({ ok: false, error: "Not a venue member" }, 403);
  }

  const { data: guest, error } = await admin
    .from("guests")
    .select("id, code, full_name, cashback_balance_cents")
    .eq("code", code)
    .maybeSingle();
  if (error) {
    return json({ ok: false, error: `lookup: ${error.message}` }, 500);
  }
  if (!guest) {
    return json({ ok: false, error: `No guest with code ${code}` }, 404);
  }

  return json({ ok: true, guest });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
