// Supabase Edge Function — business-suggest-places (natural caller)
//
// Thin facade for the business /add page picker. Resolves the caller's
// user id (so the artificial caller can flag verified_partner_self vs
// _other on already-owned venues) and forwards to
// places-suggest-autocomplete for the actual Google+Mesita merge.
//
// JWT-protected: clients must send the Supabase anon JWT in Authorization.
// Anonymous (anon key only, no user session) calls still get useful
// predictions — ownership flagging just degrades to "_other" because
// there's no caller to compare against.
//
// Local:  supabase functions serve business-suggest-places
// Deploy: supabase functions deploy business-suggest-places

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";
import { readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";

type Body = { input?: string; sessionToken?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" });

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" });
  }

  // Resolve caller user id from the bearer (if present). The artificial
  // caller uses this to mark verified_partner_self vs _other on Mesita-side
  // matches. We do this with the anon-keyed user client so RLS still applies.
  let callerUserId: string | null = null;
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      const userClient = createClient(env.url, env.anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data } = await userClient.auth.getUser();
      callerUserId = data.user?.id ?? null;
    } catch (err) {
      console.error("[business-suggest-places] auth.getUser:", err);
    }
  }

  const result = await invokeArtificialCaller<{
    ok: boolean;
    predictions?: unknown[];
    error?: string;
    code?: string;
  }>(env, "business-suggest-places", "places-suggest-autocomplete", {
    input: body.input,
    sessionToken: body.sessionToken,
    callerUserId,
  });
  if (!result.ok) {
    return json({ ok: false, error: result.error }, 502);
  }
  return json(result.data);
});
