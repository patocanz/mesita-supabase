// Supabase Edge Function — admin-grant-membership (admin caller)
//
// Super-admin only. The invitation "door" into Premium: hand-grant Premium to
// a consumer (models / local faces / comps) with origin 'invitation', or
// revoke back to Free. Optional expiry. This is the manual launch-spike path
// for seeding the Premium pool.
//
// Body: { consumerCode?: string, consumerId?: string,
//         tier: "free"|"premium", expiresAt?: string }
// Response: { ok: true, consumer: { id, code, tier_key, tier_origin } }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

type Body = {
  consumerCode?: string;
  consumerId?: string;
  tier?: "free" | "premium";
  expiresAt?: string;
};

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

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  const tier = body.tier ?? "premium";
  if (tier !== "free" && tier !== "premium") {
    return json({ ok: false, error: "tier must be 'free' or 'premium'" }, 400);
  }

  let expiresAt: string | null = null;
  if (body.expiresAt) {
    const d = new Date(body.expiresAt);
    if (Number.isNaN(d.getTime())) {
      return json({ ok: false, error: "expiresAt must be an ISO timestamp" }, 400);
    }
    expiresAt = d.toISOString();
  }

  // Resolve the target consumer by id or code.
  let query = admin.from("consumers").select("id, code").limit(1);
  if (body.consumerId) query = query.eq("id", body.consumerId);
  else if (body.consumerCode) {
    query = query.eq("code", body.consumerCode.trim().toUpperCase());
  } else {
    return json({ ok: false, error: "consumerId or consumerCode required" }, 400);
  }
  const { data: target, error: findErr } = await query.maybeSingle();
  if (findErr) return json({ ok: false, error: findErr.message }, 500);
  if (!target) return json({ ok: false, error: "Consumer not found" }, 404);

  const patch =
    tier === "premium"
      ? {
          tier_key: "premium",
          tier_origin: "invitation",
          tier_granted_at: new Date().toISOString(),
          tier_expires_at: expiresAt,
        }
      : {
          tier_key: "free",
          tier_origin: "default",
          tier_granted_at: null,
          tier_expires_at: null,
        };

  const { data: updated, error } = await admin
    .from("consumers")
    .update(patch)
    .eq("id", target.id)
    .select("id, code, tier_key, tier_origin")
    .single();
  if (error) return json({ ok: false, error: error.message }, 500);

  return json({ ok: true, consumer: updated });
});
