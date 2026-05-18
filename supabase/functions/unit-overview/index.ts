// Supabase Edge Function — unit-overview
//
// Authenticated. Returns *everything* the manager / validator surfaces
// need for the active unit in one round trip:
//   - the signed-in user (id + email)
//   - every venue they're a member of (sidebar picker)
//   - the active venue's full row + recent tickets
//
// Self-contained: own JWT verification, own DB reads via the service role,
// never calls another Edge Function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const VENUE_COLUMNS =
  "id, slug, name, category, vibe, price_level, listing_type, status, fiscal_type, lat, lng, address, closes_at, phone, pitch, story, cashback_percent, photos, website_url, instagram_url, tiktok_url, facebook_url, whatsapp_url, opentable_url, resy_url, uber_eats_url, rappi_url, created_at, updated_at";

type Body = { activeUnitId?: string; ticketsLimit?: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ ok: false, error: "Missing bearer token" }, 401);
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return json({ ok: false, error: "Invalid session" }, 401);
  }
  const userId = userData.user.id;
  const userEmail = userData.user.email ?? null;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // empty body is fine — defaults below
  }
  const requestedUnitId = (body.activeUnitId ?? "").toString().trim() || null;
  // 0 means "don't fetch tickets at all" — the sidebar layout doesn't need
  // them, only the active page does.
  const ticketsLimit = clampTicketsLimit(body.ticketsLimit);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Pull every venue the caller is a member of, with the role on each row.
  const memberRows = await admin
    .from("venue_members")
    .select(`role, venue:venues(${VENUE_COLUMNS})`)
    .eq("manager_id", userId)
    .order("created_at", { ascending: false });
  if (memberRows.error) {
    return json({ ok: false, error: memberRows.error.message }, 500);
  }

  type MemberRow = { role: string; venue: Record<string, unknown> | null };
  const venues = ((memberRows.data ?? []) as MemberRow[])
    .filter((r) => r.venue != null)
    .map((r) => ({ ...r.venue!, my_role: r.role }));

  // Pick the active unit. Honour the requested id when it matches a
  // membership; otherwise fall back to the first venue.
  const active = venues.length === 0
    ? null
    : (requestedUnitId && venues.find((v) => (v as { id: string }).id === requestedUnitId)) ||
        venues[0];

  // Recent tickets for the active venue (skipped when ticketsLimit=0 or
  // there's no active venue — saves a query the layout doesn't care about).
  let recentTickets: unknown[] = [];
  if (active && ticketsLimit > 0) {
    const activeId = (active as { id: string }).id;
    const tx = await admin
      .from("tickets")
      .select(
        "id, kind, status, story_status, story_screenshot_url, story_submitted_at, story_verified_at, story_reject_reason, check_subtotal_cents, tip_cents, total_cents, cashback_percent, cashback_cents, redeem_cents, discount_percent, discount_cents, revealed_at, reservation_status, reservation_at, reservation_party_size, currency, created_at, paid_at, cancelled_at, cancel_reason, guest:guests(id, code, full_name)",
      )
      .eq("venue_id", activeId)
      .order("created_at", { ascending: false })
      .limit(ticketsLimit);
    if (tx.error) {
      // Don't fail the whole overview if tickets fail — surface as empty list
      // with an error breadcrumb the client can log.
      console.error("[unit-overview] ticket fetch:", tx.error.message);
    } else {
      recentTickets = tx.data ?? [];
    }
  }

  return json({
    ok: true,
    user: { id: userId, email: userEmail },
    venues,
    active: active
      ? {
          venue: active,
          recentTickets,
        }
      : null,
  });
});

function clampTicketsLimit(raw: unknown): number {
  if (raw == null) return 20;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 20;
  if (n <= 0) return 0;
  return Math.min(100, Math.trunc(n));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
