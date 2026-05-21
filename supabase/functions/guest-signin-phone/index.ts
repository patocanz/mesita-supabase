// Supabase Edge Function — guest-signin-phone
//
// Post-sign-in housekeeping for the phone-OTP guest flow. The Supabase
// Auth call (signInWithOtp + verifyOtp) already landed a session before
// the client calls this function. Our job is to:
//
//   1. Stamp app_metadata.role = 'guest' on first sign-in (don't clobber
//      if the user is already a staff member of some venue).
//   2. Lazy-create the guests row with a unique 6-char code, mirroring
//      auth.user.phone into guests.phone.
//
// Safe to call on every sign-in (idempotent). Returns the current role +
// guest row so the client can refresh its session and route accordingly.
//
// Self-contained: own JWT verification, own DB writes via the service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { CORS } from "../_shared/cors.ts";
import { corsPreflight, json } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
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
  const user = userData.user;

  // Phone is required for guest sign-in. If the session was opened via
  // some other provider, reject — guest auth is phone-only.
  if (!user.phone) {
    return json({ ok: false, error: "Guest sign-in requires a phone session." }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Decide the role to stamp. If the user is already promoted to staff,
  // keep that; otherwise default to guest. Never downgrade an admin/manager
  // — they should never be here (different auth pools), but defence in
  // depth is cheap.
  const currentRole =
    (user.app_metadata as Record<string, unknown> | null)?.role as string | undefined;
  const allowedKeep = new Set(["staff", "manager", "admin"]);
  const role = currentRole && allowedKeep.has(currentRole) ? currentRole : "guest";

  if (role !== currentRole) {
    const stamp = await admin.auth.admin.updateUserById(user.id, {
      app_metadata: { ...(user.app_metadata ?? {}), role },
    });
    if (stamp.error) {
      return json({ ok: false, error: `role_stamp: ${stamp.error.message}` }, 500);
    }
  }

  // Lazy-create guests row. Race: two parallel sign-ins on a brand-new
  // account can both insert — handle 23505 by reading the row back.
  const existing = await admin
    .from("guests")
    .select("id, code, full_name, phone")
    .eq("id", user.id)
    .maybeSingle();
  if (existing.error) {
    return json({ ok: false, error: `guest_read: ${existing.error.message}` }, 500);
  }

  let guestRow = existing.data;
  if (!guestRow) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const codeResult = await admin.rpc("generate_guest_code");
      if (codeResult.error) {
        return json({ ok: false, error: `code_gen: ${codeResult.error.message}` }, 500);
      }
      const inserted = await admin
        .from("guests")
        .insert({
          id: user.id,
          code: codeResult.data as string,
          phone: user.phone,
        })
        .select("id, code, full_name, phone")
        .single();
      if (!inserted.error) {
        guestRow = inserted.data;
        break;
      }
      if (inserted.error.code !== "23505") {
        return json({ ok: false, error: `guest_create: ${inserted.error.message}` }, 500);
      }
      // Conflict — someone else inserted concurrently. Read it back.
      const refetch = await admin
        .from("guests")
        .select("id, code, full_name, phone")
        .eq("id", user.id)
        .maybeSingle();
      if (refetch.data) {
        guestRow = refetch.data;
        break;
      }
    }
  } else if (guestRow.phone !== user.phone) {
    // Phone drifted (rare — admin manually changed auth.users.phone).
    // Re-sync.
    const sync = await admin
      .from("guests")
      .update({ phone: user.phone })
      .eq("id", user.id)
      .select("id, code, full_name, phone")
      .single();
    if (sync.error) {
      return json({ ok: false, error: `guest_phone_sync: ${sync.error.message}` }, 500);
    }
    guestRow = sync.data;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      role,
      guest: guestRow,
      onboarded: !!guestRow?.full_name,
    }),
    { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
  );
});
