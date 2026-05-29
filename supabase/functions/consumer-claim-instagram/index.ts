// Supabase Edge Function — consumer-claim-instagram (natural caller)
//
// Authenticated. The Instagram "door" into Premium: a consumer with at least
// the premium follower threshold (1,000) gets Mesita Premium instantly,
// origin 'instagram'. Below the threshold, an existing instagram-origin
// Premium is dropped back to Free. Subscription / invitation Premium is never
// touched here (origin precedence).
//
// The per-visit "post a story" requirement is enforced separately by the
// existing ticket story-verification flow; follower count sets the class
// instantly, matching the consumer app's VerifySocialSheet promise.
//
// Body: { followers: number, handle?: string }
// Response: { ok: true, tier: "free"|"premium", followers: number }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";
import { getTierConfig } from "../_shared/membership.ts";

type Body = { followers?: number; handle?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const consumerId = authRes.user.id;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const followers = Math.trunc(Number(body.followers));
  if (!Number.isFinite(followers) || followers < 0) {
    return json({ ok: false, error: "followers must be a non-negative integer" }, 400);
  }

  const admin = adminClient(envRes.env);

  const premium = await getTierConfig(admin, "premium");
  const threshold = premium?.follower_threshold ?? 1000;
  const qualifies = followers >= threshold;

  // Always persist the latest follower count.
  const patch: Record<string, unknown> = {
    consumer_instagram_followers_count: followers,
  };

  if (qualifies) {
    patch.tier_key = "premium";
    patch.tier_origin = "instagram";
    patch.tier_granted_at = new Date().toISOString();
    patch.tier_expires_at = null;
    const { error } = await admin.from("consumers").update(patch).eq("id", consumerId);
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, tier: "premium", followers });
  }

  // Below threshold: record followers; drop ONLY an instagram-origin Premium.
  const { error: e1 } = await admin
    .from("consumers")
    .update(patch)
    .eq("id", consumerId);
  if (e1) return json({ ok: false, error: e1.message }, 500);

  await admin
    .from("consumers")
    .update({ tier_key: "free", tier_origin: "default", tier_expires_at: null })
    .eq("id", consumerId)
    .eq("tier_origin", "instagram");

  return json({ ok: true, tier: "free", followers });
});
