// Supabase Edge Function — business-signin-email
//
// Post-sign-in housekeeping for the email+password business flow. The
// client already called signInWithPassword and has a session; here we:
//
//   1. Reject sessions opened with a phone token (businesses are
//      email-pool only).
//   2. Stamp app_metadata.role = 'business' if unset. Refuse to demote
//      an admin.
//   3. Lazy-create the businesses row.
//
// Safe to call on every sign-in (idempotent). Returns the role + business
// row so the client can route after refreshSession().
//
// Self-contained: own JWT verification, own DB writes via the service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const user = authRes.user.raw;

  // Business auth pool is email-only. A session with no email or one
  // opened via phone OTP is illegitimate here.
  if (!user.email) {
    return json(
      { ok: false, error: "Business sign-in requires an email account." },
      400,
    );
  }

  const admin = adminClient(envRes.env);

  // Stamp role. Don't downgrade an admin or staff (staff would be a
  // bug — staff is phone-only — but refuse cleanly anyway).
  const currentRole =
    (user.app_metadata as Record<string, unknown> | null)?.role as string | undefined;
  if (currentRole === "admin") {
    return json(
      { ok: false, error: "This account is an admin — use the admin sign-in." },
      403,
    );
  }
  if (currentRole === "staff") {
    return json(
      { ok: false, error: "This account is a staff member — use the staff flow." },
      403,
    );
  }
  if (currentRole !== "business") {
    const stamp = await admin.auth.admin.updateUserById(user.id, {
      app_metadata: { ...(user.app_metadata ?? {}), role: "business" },
    });
    if (stamp.error) {
      return json({ ok: false, error: `role_stamp: ${stamp.error.message}` }, 500);
    }
  }

  // Lazy-create businesses row. Email mirrors auth.user.email.
  const existing = await admin
    .from("businesses")
    .select("id, full_name, email, phone")
    .eq("id", user.id)
    .maybeSingle();
  if (existing.error) {
    return json({ ok: false, error: `business_read: ${existing.error.message}` }, 500);
  }

  let businessRow = existing.data;
  if (!businessRow) {
    const seed = await admin
      .from("businesses")
      .insert({ id: user.id, email: user.email })
      .select("id, full_name, email, phone")
      .single();
    if (seed.error && seed.error.code !== "23505") {
      return json({ ok: false, error: `business_create: ${seed.error.message}` }, 500);
    }
    if (seed.error) {
      // Concurrent insert — read back.
      const refetch = await admin
        .from("businesses")
        .select("id, full_name, email, phone")
        .eq("id", user.id)
        .maybeSingle();
      if (refetch.error) {
        return json({ ok: false, error: `business_refetch: ${refetch.error.message}` }, 500);
      }
      businessRow = refetch.data;
    } else {
      businessRow = seed.data;
    }
  } else if (businessRow.email !== user.email) {
    // Email drifted (Supabase Auth email change). Re-sync.
    const sync = await admin
      .from("businesses")
      .update({ email: user.email })
      .eq("id", user.id)
      .select("id, full_name, email, phone")
      .single();
    if (sync.error) {
      return json({ ok: false, error: `business_email_sync: ${sync.error.message}` }, 500);
    }
    businessRow = sync.data;
  }

  return json({
    ok: true,
    role: "business",
    business: businessRow,
    onboarded: !!businessRow?.full_name,
  });
});
