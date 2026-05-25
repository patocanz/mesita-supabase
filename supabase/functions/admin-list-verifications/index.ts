// Supabase Edge Function — admin-list-verifications
//
// Returns ownership verification requests with venue + requester
// metadata, ordered newest first. Used by admin.mesita.ai/verifications
// to surface the queue. Pending rows are the actionable ones; decided
// rows (approved / rejected) are kept in the list as history.
//
// Queue surface: the admin only ever sees rows that need a human
// decision. That's all video rows (regardless of auto_verify_video,
// since decided history matters too) plus ai_call rows where the
// caller successfully entered the OTP but auto_verify_ai_call was off
// at that moment (payload.codeVerifiedAt set). Phone rows where the
// code hasn't been entered yet stay invisible — they're not the
// admin's concern.
//
// Auth: caller's JWT email must be in public.super_admins.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

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

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const admin = adminClient(envRes.env);
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

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
  // Method gate: video always shows; ai_call only shows once the
  // operator has confirmed the OTP (codeVerifiedAt stamped by
  // business-verify-call-code when auto_verify_ai_call was off).
  query = query.or(
    "method.eq.video,and(method.eq.ai_call,payload->>codeVerifiedAt.not.is.null)",
  );

  const { data, error } = await query;
  if (error) {
    return json(
      { ok: false, error: `verification_list: ${error.message}` },
      500,
    );
  }

  // Auto-mode flags piggyback on this call so the admin web doesn't
  // need a second round-trip just to render the toggles' current
  // state.
  const { data: settings } = await admin
    .from("app_settings")
    .select("auto_verify_ai_call, auto_verify_video, updated_at")
    .eq("id", 1)
    .maybeSingle();

  return json({
    ok: true,
    verifications: data ?? [],
    autoVerifyAiCall: settings?.auto_verify_ai_call ?? true,
    autoVerifyVideo: settings?.auto_verify_video ?? false,
    autoVerifyUpdatedAt: settings?.updated_at ?? null,
  });
});
