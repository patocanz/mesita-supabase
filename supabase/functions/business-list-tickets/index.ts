// Supabase Edge Function — business-list-tickets
//
// Authenticated. Returns the most recent tickets for a venue the caller is
// a member of. Joins the consumer's display fields (code, full name) for the
// validator UI. Self-contained.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type Body = { venueId?: string; limit?: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const venueId = (body.venueId ?? "").toString().trim();
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  const limit = Math.max(
    1,
    Math.min(MAX_LIMIT, Math.trunc(Number(body.limit ?? DEFAULT_LIMIT))),
  );

  const admin = adminClient(envRes.env);
  const memberRes = await requireMembership(admin, authRes.user, venueId);
  if (!memberRes.ok) return memberRes.response;

  const { data, error } = await admin
    .from("tickets")
    .select(
      "id, kind, status, story_status, story_screenshot_url, story_submitted_at, story_verified_at, story_reject_reason, check_subtotal_cents, tip_cents, total_cents, cashback_percent, cashback_cents, redeem_cents, discount_percent, discount_cents, revealed_at, reservation_status, reservation_at, reservation_party_size, currency, created_at, paid_at, cancelled_at, cancel_reason, consumer:consumers(id, code, full_name)",
    )
    .eq("venue_id", venueId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return json({ ok: false, error: error.message }, 500);
  }

  return json({ ok: true, tickets: data ?? [] });
});
