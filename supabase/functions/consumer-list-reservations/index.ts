// Supabase Edge Function — consumer-list-reservations (natural caller)
//
// Authenticated read of the caller's reservations. Returns booking
// metadata joined with the venue summary — NO discount / cashback /
// money fields, because the entity split's contract is that the
// reservation card never carries financial info. The (optional)
// linked coupon is exposed by id only so the client can cross-
// reference the coupons wallet, but the rates / cap live on the
// coupon row, never here.
//
// Defaults to upcoming + recently completed; pass `scope: "past"` for
// archived bookings.
//
// Deploy: supabase functions deploy consumer-list-reservations

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type Scope = "upcoming" | "past" | "all";
type Body = { limit?: number; scope?: Scope };

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
  let scope: Scope = "upcoming";
  if (req.method === "POST") {
    try {
      const body = (await req.json()) as Body;
      if (typeof body?.limit === "number") {
        limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(body.limit)));
      }
      if (body?.scope === "past" || body?.scope === "all") scope = body.scope;
    } catch {
      // empty body
    }
  }

  const admin = adminClient(envRes.env);

  let q = admin
    .from("reservations")
    .select(
      "id, reserved_at, party_size, status, notes, confirmed_at, completed_at, cancelled_at, coupon_id, created_at, venue:venues(id, slug, name, category, photos, address)",
    )
    .eq("consumer_id", consumerId)
    .order("reserved_at", { ascending: scope === "past" ? false : true })
    .limit(limit);

  // "upcoming" hides terminal-state past bookings. "past" inverts.
  // "all" leaves the result unfiltered for the archive view.
  if (scope === "upcoming") {
    q = q.in("status", ["pending", "confirmed"]);
  } else if (scope === "past") {
    q = q.in("status", ["declined", "no_show", "cancelled"]);
  }

  const { data, error } = await q;
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, reservations: data ?? [] });
});
