// Supabase Edge Function — consumer-recommend-deck (natural caller)
//
// Thin facade for the consumer swipe view. Resolves the caller's profile
// (anonymous OK — the discover surface is public until sign-up) and forwards
// to the recommender-rank-deck artificial caller for the actual ranking
// pipeline. Everything ranking-related lives in the artificial caller so
// admin / business / future consumer surfaces can reuse the same pipeline.
//
// Local:  supabase functions serve consumer-recommend-deck
// Deploy: supabase functions deploy consumer-recommend-deck

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";
import { readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";

type Body = {
  lat?: number;
  lng?: number;
  radiusKm?: number;
  limit?: number;
};

type ConsumerProfile = {
  full_name: string | null;
  country: string | null;
  birthday: string | null;
  sex: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Honour the bearer if present so we can read the signed-in consumer's
  // profile for personalisation, but anonymous is the common path. RLS-aware
  // reads through the user-scoped client.
  const authHeader = req.headers.get("Authorization") ?? "";
  let profile: ConsumerProfile | null = null;
  if (authHeader.startsWith("Bearer ")) {
    const userClient = createClient(env.url, env.anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: authData } = await userClient.auth.getUser();
    if (authData.user) {
      const { data } = await userClient
        .from("consumers")
        .select("full_name, country, birthday, sex")
        .eq("id", authData.user.id)
        .maybeSingle();
      profile = (data as ConsumerProfile | null) ?? null;
    }
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* anonymous browse with no body is fine */
  }

  // Forward to the artificial caller. The shape we return is whatever it
  // returns — no shaping here, this EF exists for auth + profile resolution.
  const ranked = await invokeArtificialCaller<{
    ok: boolean;
    deck?: unknown[];
    summary?: unknown;
    error?: string;
  }>(env, "consumer-recommend-deck", "recommender-rank-deck", {
    lat: body.lat,
    lng: body.lng,
    radiusKm: body.radiusKm,
    limit: body.limit,
    profile,
  });
  if (!ranked.ok) {
    return json({ ok: false, error: ranked.error }, 502);
  }
  return json(ranked.data);
});
