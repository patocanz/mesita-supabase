// Supabase Edge Function — admin-search-places (natural caller)
//
// Thin facade for the admin bulk-search UI. Gates the request to
// super_admins, then forwards the query batch to the places-search-text
// artificial caller for the actual Google fan-out + Mesita enrichment.
//
// Auth: caller's JWT email must be in public.super_admins. verify_jwt = true
// at the gateway gates the request to a real session before we even see it.
//
// Wire status is always 200 with a { ok, ... } body — same shape as the
// other Places proxies. supabase-js's invoke helper swallows non-2xx
// bodies, so meaningful errors travel in the body, not the HTTP status.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  checkSuperAdmin,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { invokeArtificialCaller } from "../_shared/internal.ts";

type RequestBody = {
  queries?: string[];
  regionCode?: string;
  maxResultsPerQuery?: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" });

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  const authRes = await getAuthedUser(req, env);
  if (!authRes.ok) return authRes.response;
  const admin = adminClient(env);

  // Soft-200 with `code: "unauthorized"` is intentional — the admin bulk-
  // search UI distinguishes "you're not on the list" (no error toast,
  // render an empty state) from a transport failure.
  if (!(await checkSuperAdmin(admin, authRes.user))) {
    return json({ ok: false, code: "unauthorized", error: "Not a super-admin" });
  }

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON" });
  }

  const result = await invokeArtificialCaller(
    env,
    "admin-search-places",
    "places-search-text",
    body,
  );
  if (!result.ok) {
    return json({ ok: false, error: result.error }, 502);
  }
  return json(result.data);
});
