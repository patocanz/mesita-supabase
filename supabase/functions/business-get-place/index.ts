// Supabase Edge Function — business-get-place (natural caller)
//
// Thin facade for the business /add page. Forwards to the places-get-details
// artificial caller; everything Google-shaped lives there.
//
// JWT-protected: clients must send the Supabase anon JWT in Authorization.
//
// Local:  supabase functions serve business-get-place
// Deploy: supabase functions deploy business-get-place

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { readEFEnv } from "../_shared/auth.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";

type Body = { placeId?: string; sessionToken?: string };

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

  const result = await invokeArtificialCaller(
    env,
    "business-get-place",
    "places-get-details",
    body,
  );
  if (!result.ok) {
    return json({ ok: false, error: result.error }, 502);
  }
  return json(result.data);
});
