// Supabase Edge Function — admin-whoami
//
// Tiny session-check called by the admin web's app shell. Returns the
// caller's email + whether their email is in public.super_admins. The
// shell uses it to either render the admin surface or a friendly "your
// account isn't on the super-admin list" empty state.
//
// This EF only authenticates — it doesn't authorize. A non-allowlisted
// caller still gets a 200 with `isSuperAdmin: false`; the shell handles
// the rendering. Other admin EFs are the real auth gate.
//
// Self-contained: verifies the JWT, reads super_admins via service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

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

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ ok: false, error: "Missing bearer token" }, 401);
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } =
    await userClient.auth.getUser();
  if (userError || !userData.user) {
    return json({ ok: false, error: "Invalid session" }, 401);
  }
  const userId = userData.user.id;
  const email = userData.user.email ?? null;
  const emailLower = email?.toLowerCase() ?? null;

  let isSuperAdmin = false;
  if (emailLower) {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
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

  return json({ ok: true, email, isSuperAdmin });
});
