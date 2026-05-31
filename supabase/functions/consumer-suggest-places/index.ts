// Supabase Edge Function — consumer-suggest-places (natural caller)
//
// Thin facade for the consumer /discover/search page picker. Resolves
// the caller's user id (so the atlas caller can flag
// verified_partner_self vs _other on already-owned venues — relevant
// when a consumer who also runs a venue searches for it from inside
// the consumer app) and forwards to atlas-suggest-venue for the
// actual Google + Mesita merge.
//
// Mirrors business-suggest-places exactly — the caller-namespace
// matters for telemetry and future per-namespace rate limiting / quota,
// but the work happens inside the Atlas artificial caller either way.
// The consumer surface deliberately also surfaces "Not on Mesita"
// rows so users can find places that haven't onboarded yet (they'd
// still want to know the spot exists; the UI nudges them to "ping
// us when they're live" rather than dead-ending).
//
// JWT-protected: clients send the Supabase anon JWT in Authorization.
// Anonymous (anon key only, no user session) calls still get useful
// predictions — ownership flagging degrades to "_other".
//
// Local:  supabase functions serve consumer-suggest-places
// Deploy: supabase functions deploy consumer-suggest-places

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";

type Body = { input?: string; sessionToken?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" });

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  // Resolve caller user id from the bearer (if present). The atlas
  // caller uses this to mark verified_partner_self vs _other on
  // Mesita-side matches. Done with the anon-keyed user client so RLS
  // still applies.
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
      console.error("[consumer-suggest-places] auth.getUser:", err);
    }
  }

  const result = await invokeArtificialCaller<{
    ok: boolean;
    predictions?: unknown[];
    error?: string;
    code?: string;
  }>(env, "consumer-suggest-places", "atlas-suggest-venue", {
    input: body.input,
    sessionToken: body.sessionToken,
    callerUserId,
  });
  if (!result.ok) {
    return json({ ok: false, error: result.error }, 502);
  }
  return json(result.data);
});
