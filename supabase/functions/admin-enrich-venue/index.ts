// Supabase Edge Function — admin-enrich-venue (admin caller)
//
// Super-admin tool to (re)run the qualitative profile enricher on an existing
// venue. New venues are enriched automatically at create time by
// business-create-unit → atlas-enrich-profile; this is the manual lever to
// re-synthesize a venue's details/summary/menus/popular-times after the fact
// (e.g. a bad first pass, or new source coverage). Both paths call the same
// agent, so profiles stay consistent.
//
// Body: { venue_id: uuid }
// Response: the agent's result ({ ok, fields_filled, ... }).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";

type Body = { venue_id?: string };

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
  const guard = await requireSuperAdmin(admin, authRes.user);
  if (!guard.ok) return guard.response;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const venueId = (body.venue_id ?? "").toString().trim();
  if (!venueId) return json({ ok: false, error: "venue_id is required" }, 400);

  const enrichRes = await invokeArtificialCaller(
    envRes.env,
    "admin-enrich-venue",
    "atlas-enrich-profile",
    { venue_id: venueId },
  );
  if (!enrichRes.ok) {
    return json({ ok: false, error: enrichRes.error }, 502);
  }
  return json(enrichRes.data);
});
