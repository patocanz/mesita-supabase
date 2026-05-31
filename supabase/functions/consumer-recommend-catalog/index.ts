// Supabase Edge Function — consumer-recommend-catalog (natural caller)
//
// Thin facade for the consumer catalog view. Resolves the caller's profile
// (anonymous OK) and forwards to the recommender-rank-catalog artificial
// caller for the actual ranking pipeline. Everything ranking-related lives
// in the artificial caller so any future surface — business, admin,
// scheduled refresh — can reuse the same pipeline.
//
// Local:  supabase functions serve consumer-recommend-catalog
// Deploy: supabase functions deploy consumer-recommend-catalog

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import { readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";

type Body = {
  lat?: number;
  lng?: number;
  radiusKm?: number;
  maxCategories?: number;
  perCategory?: number;
};

type ConsumerProfile = {
  full_name: string | null;
  country: string | null;
  birthday: string | null;
  sex: string | null;
  tier?: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Honour the bearer if present — signed-in consumers get personalisation.
  // RLS-aware reads through the user-scoped client.
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
        .select("full_name, country, birthday, sex, tier_key")
        .eq("id", authData.user.id)
        .maybeSingle();
      if (data) {
        const { tier_key, ...rest } = data as Record<string, unknown>;
        profile = { ...(rest as ConsumerProfile), tier: (tier_key as string) ?? "free" };
      }
    }
  }

  const body = await readJsonOr<Body>(req, {});

  const ranked = await invokeArtificialCaller<{
    ok: boolean;
    categories?: unknown[];
    summary?: unknown;
    error?: string;
  }>(env, "consumer-recommend-catalog", "recommender-rank-catalog", {
    lat: body.lat,
    lng: body.lng,
    radiusKm: body.radiusKm,
    maxCategories: body.maxCategories,
    perCategory: body.perCategory,
    profile,
  });
  if (!ranked.ok) {
    return json({ ok: false, error: ranked.error }, 502);
  }
  return json(ranked.data);
});
