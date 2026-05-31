// Supabase Edge Function — consumer-list-coupons (natural caller)
//
// Authenticated read of the caller's coupons wallet. Returns coupons
// joined with the venue summary needed to render the coupon card
// (name, slug, photo, address). Defaults to active coupons only; pass
// `include_inactive: true` to also receive redeemed / expired /
// cancelled history (used by the wallet's "Past" subtab).
//
// Deploy: supabase functions deploy consumer-list-coupons

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { clampIntRange, corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type Body = { limit?: number; include_inactive?: boolean };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const consumerId = authRes.user.id;

  let limit = DEFAULT_LIMIT;
  let includeInactive = false;
  if (req.method === "POST") {
    const body = await readJsonOr<Body>(req, {});
    if (typeof body.limit === "number") {
      limit = clampIntRange(body.limit, 1, MAX_LIMIT);
    }
    if (body.include_inactive === true) includeInactive = true;
  }

  const admin = adminClient(envRes.env);

  let q = admin
    .from("coupons")
    .select(
      "id, status, issued_at, redeemed_at, cancelled_at, expires_at, welcome_free_rate, welcome_premium_rate, free_rate, premium_rate, cap_cents, currency, venue:venues(id, slug, name, category, photos, address)",
    )
    .eq("consumer_id", consumerId)
    .order("issued_at", { ascending: false })
    .limit(limit);

  if (!includeInactive) q = q.eq("status", "active");

  const { data, error } = await q;
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, coupons: data ?? [] });
});
