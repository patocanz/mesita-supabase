// Supabase Edge Function — business-get-verification
//
// Returns the business's latest verification request for a given venue
// (or null if none exists yet). Used by /unit/<id>/verify to show the
// current state — pending submission, awaiting review, approved, or
// rejected with reason.
//
// Auth: any signed-in user. The EF only returns rows where
// requester_id === auth.user.id, so businesses can't peek at other
// operators' requests.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";

type Body = { venueId?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const venueId = (body.venueId ?? "").trim();
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);

  const admin = adminClient(envRes.env);
  const { data, error } = await admin
    .from("venue_verifications")
    .select(
      "id, method, payload, requester_email, status, reject_reason, decided_at, decided_via, created_at",
    )
    .eq("venue_id", venueId)
    .eq("requester_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return json(
      { ok: false, error: `verification_lookup: ${error.message}` },
      500,
    );
  }

  return json({ ok: true, verification: data ?? null });
});
