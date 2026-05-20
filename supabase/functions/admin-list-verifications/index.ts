// Supabase Edge Function — admin-list-verifications
//
// Returns ownership verification requests with venue + requester
// metadata, ordered newest first. Used by admin.mesita.ai/verifications
// to surface the queue. Pending rows are the actionable ones; decided
// rows (approved / rejected) are kept in the list as history.
//
// Auth: caller's JWT email must be in public.super_admins.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = {
  // Filter by status. Omit / undefined / null = all.
  status?: "pending" | "approved" | "rejected" | null;
  limit?: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ ok: false, error: "Server misconfigured" }, 500);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // super_admins gate.
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
  const emailLower = userData.user.email?.toLowerCase() ?? null;
  if (!emailLower) {
    return json({ ok: false, error: "No email on session" }, 401);
  }
  const { data: saRow } = await admin
    .from("super_admins")
    .select("email")
    .eq("email", emailLower)
    .maybeSingle();
  if (!saRow) {
    return json({ ok: false, error: "Not a super-admin" }, 403);
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // empty body fine
  }
  const limit = Math.min(200, Math.max(1, body.limit ?? 100));

  let query = admin
    .from("venue_verifications")
    .select(
      "id, venue_id, requester_id, method, payload, requester_email, status, reject_reason, decided_at, decided_by, decided_via, created_at, venue:venues(id, slug, name, status, phone, address, google_place_id)",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (body.status) {
    query = query.eq("status", body.status);
  }

  const { data, error } = await query;
  if (error) {
    return json(
      { ok: false, error: `verification_list: ${error.message}` },
      500,
    );
  }

  // Auto-mode flag piggybacks on this call so the admin web doesn't
  // need a second round-trip just to render the toggle's current
  // state.
  const { data: settings } = await admin
    .from("app_settings")
    .select("auto_verify_venues, updated_at")
    .eq("id", 1)
    .maybeSingle();

  return json({
    ok: true,
    verifications: data ?? [],
    autoVerifyVenues: settings?.auto_verify_venues ?? false,
    autoVerifyUpdatedAt: settings?.updated_at ?? null,
  });
});
