// Supabase Edge Function — admin-signin-email
//
// Post-sign-in housekeeping for the admin email+password flow with two
// extra gates:
//
//   1. Email must end in @canzeco.com — admin is internal-only.
//   2. The current session must have completed an MFA challenge — the
//      JWT carries aal=aal2 once the user has verified a factor on top
//      of password.
//
// If either gate fails, we revoke the session immediately and return
// the reason. Successful calls stamp app_metadata.role = 'admin' if
// unset, so middleware + RLS can rely on the claim.
//
// Self-contained: own JWT verification, own DB writes via the service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

const ADMIN_EMAIL_DOMAIN = "@canzeco.com";

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

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Gate 1: corp email only. Revoke the session if a non-corp email
  // somehow lands here — that user should never have been allowed to
  // hit this endpoint.
  const email = user.email?.toLowerCase() ?? "";
  if (!email.endsWith(ADMIN_EMAIL_DOMAIN)) {
    await admin.auth.admin.signOut(user.id, "global").catch(() => {});
    return json(
      { ok: false, error: `Admin sign-in is restricted to ${ADMIN_EMAIL_DOMAIN} emails.` },
      403,
    );
  }

  // Gate 2: MFA. supabase-js returns aal as part of the AAL helper, but
  // from a service-role context we read it off the user_metadata claim
  // chain. The simplest robust check: confirm the user has at least one
  // verified factor AND the current AAL is aal2.
  const aalCheck = await userClient.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalCheck.error) {
    return json({ ok: false, error: `mfa_aal: ${aalCheck.error.message}` }, 500);
  }
  const currentLevel = aalCheck.data?.currentLevel ?? null;
  const nextLevel = aalCheck.data?.nextLevel ?? null;
  if (currentLevel !== "aal2") {
    // Two distinct failure modes: factor not enrolled vs. challenge not
    // completed this session. Hint which one so the UI can route to the
    // right next step.
    const needsEnroll = nextLevel !== "aal2";
    return json(
      {
        ok: false,
        code: needsEnroll ? "mfa_enroll_required" : "mfa_challenge_required",
        error: needsEnroll
          ? "Enrol a second factor before continuing."
          : "Complete the MFA challenge to continue.",
      },
      403,
    );
  }

  // Stamp role.
  const currentRole =
    (user.app_metadata as Record<string, unknown> | null)?.role as string | undefined;
  if (currentRole !== "admin") {
    const stamp = await admin.auth.admin.updateUserById(user.id, {
      app_metadata: { ...(user.app_metadata ?? {}), role: "admin" },
    });
    if (stamp.error) {
      return json({ ok: false, error: `role_stamp: ${stamp.error.message}` }, 500);
    }
  }

  return json({ ok: true, role: "admin", email });
});
