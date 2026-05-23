// Supabase Edge Function — guest-list-tickets
//
// Authenticated. Returns the caller's tickets (guest perspective), most
// recent first, with the venue name joined for display. Self-contained:
// own JWT verification, own DB read; never calls another Edge Function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  let limit = DEFAULT_LIMIT;
  if (req.method === "POST") {
    try {
      const body = (await req.json()) as { limit?: number };
      if (typeof body?.limit === "number") {
        limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(body.limit)));
      }
    } catch {
      // empty / non-JSON body — keep default
    }
  }

  const admin = adminClient(envRes.env);

  const { data, error } = await admin
    .from("tickets")
    .select(
      "id, kind, status, story_status, story_screenshot_url, story_submitted_at, story_verified_at, story_reject_reason, check_subtotal_cents, tip_cents, total_cents, cashback_percent, cashback_cents, redeem_cents, discount_percent, discount_cents, revealed_at, reservation_status, reservation_at, reservation_party_size, currency, created_at, paid_at, cancelled_at, venue:venues(id, name, slug, photos, fiscal_type)",
    )
    .eq("guest_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return json({ ok: false, error: error.message }, 500);
  }

  return json({ ok: true, tickets: data ?? [] });
});
