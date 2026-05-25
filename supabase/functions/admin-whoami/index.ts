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

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  checkSuperAdmin,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";

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
  const isSuperAdmin = await checkSuperAdmin(admin, authRes.user);

  return json({ ok: true, email: authRes.user.email, isSuperAdmin });
});
