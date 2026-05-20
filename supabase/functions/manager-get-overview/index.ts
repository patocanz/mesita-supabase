// Supabase Edge Function — manager-get-overview
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
import { corsPreflight, json } from "../_shared/http.ts";

const VENUE_COLUMNS =
  "id, slug, name, category, vibe, price_level, listing_type, status, fiscal_type, plan, lat, lng, address, closes_at, phone, pitch, story, cashback_percent, photos, website_url, instagram_url, tiktok_url, facebook_url, whatsapp_url, opentable_url, resy_url, uber_eats_url, rappi_url, x_url, youtube_url, threads_url, reddit_url, didi_food_url, tripadvisor_url, google_maps_url, email, created_at, updated_at";

type Body = { activeUnitId?: string; ticketsLimit?: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

  // Super-admin paths:
  //   1. Legacy: `x-super-admin-key` header matches ADMIN_ACCESS_KEY.
  //      Kept for one cutover so the old admin-web link generator
  //      doesn't break. Burnt once nothing emits this header.
  //   2. New: caller's JWT email is in public.super_admins.
  //
  // Either path skips JWT-membership checks and returns the requested
  // venue alone — the sidebar's "all my venues" feature doesn't apply
  // when the operator isn't a real venue member.
  const ADMIN_ACCESS_KEY = Deno.env.get("ADMIN_ACCESS_KEY");
  const legacySuperAdminKey = req.headers.get("x-super-admin-key") ?? "";
  const legacyIsSuperAdmin =
    ADMIN_ACCESS_KEY != null &&
    ADMIN_ACCESS_KEY.length > 0 &&
    legacySuperAdminKey === ADMIN_ACCESS_KEY;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let userId: string | null = null;
  let userEmail: string | null = null;
  let isSuperAdmin = legacyIsSuperAdmin;
  if (!legacyIsSuperAdmin) {
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
    userId = userData.user.id;
    userEmail = userData.user.email ?? null;

    // Allowlist check: skips venue_members for any signed-in user whose
    // email is in public.super_admins. Lazy-backfill user_id so future
    // audit logs can join by uuid without re-reading auth.users.
    const emailLower = userEmail?.toLowerCase() ?? null;
    if (emailLower) {
      const { data: saRow } = await admin
        .from("super_admins")
        .select("email, user_id")
        .eq("email", emailLower)
        .maybeSingle();
      if (saRow) {
        isSuperAdmin = true;
        if (saRow.user_id == null) {
          void admin
            .from("super_admins")
            .update({ user_id: userId })
            .eq("email", emailLower)
            .is("user_id", null);
        }
      }
    }
  }

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

  // Super-admin path: skip venue_members. Require an explicit activeUnitId
  // (the link generator always supplies one) and return a single-row list.
  type VenueRow = Record<string, unknown> & { id: string };
  let venues: VenueRow[];
  if (isSuperAdmin) {
    if (!requestedUnitId) {
      return json(
        { ok: false, error: "super-admin overview requires activeUnitId" },
        400,
      );
    }
    const venueRow = await admin
      .from("venues")
      .select(VENUE_COLUMNS)
      .eq("id", requestedUnitId)
      .maybeSingle();
    if (venueRow.error) {
      return json({ ok: false, error: venueRow.error.message }, 500);
    }
    if (!venueRow.data) {
      return json({ ok: false, error: "Venue not found" }, 404);
    }
    // Tag as owner so any downstream UI that gates on role still works —
    // super-admin gets the broadest permission set the venue role enum
    // can express. (The frontend MyVenue type only knows owner|manager|staff.)
    venues = [
      { ...(venueRow.data as Record<string, unknown>), my_role: "owner" } as VenueRow,
    ];
  } else {
    // Pull every venue the caller is a member of, with the role on each row.
    const memberRows = await admin
      .from("venue_members")
      .select(`role, venue:venues(${VENUE_COLUMNS})`)
      .eq("manager_id", userId!)
      .order("created_at", { ascending: false });
    if (memberRows.error) {
      return json({ ok: false, error: memberRows.error.message }, 500);
    }
    type MemberRow = { role: string; venue: Record<string, unknown> | null };
    venues = ((memberRows.data ?? []) as MemberRow[])
      .filter((r) => r.venue != null)
      .map((r) => ({ ...r.venue!, my_role: r.role }) as VenueRow);
  }

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
      console.error("[manager-get-overview] ticket fetch:", tx.error.message);
    } else {
      recentTickets = tx.data ?? [];
    }
  }

  return json({
    ok: true,
    // userId is null only for the legacy `x-super-admin-key` path that
    // doesn't carry a JWT. New super-admin operators sign in normally
    // and have a real auth.users id + email.
    user: userId != null
      ? { id: userId, email: userEmail }
      : { id: "super-admin", email: null },
    // Drives the manager web's Topbar "Super-admin mode" banner. True
    // whenever the caller's effective role is elevated (either legacy
    // header or super_admins allowlist).
    isSuperAdmin,
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

