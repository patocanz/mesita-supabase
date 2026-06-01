// Supabase Edge Function — admin-reset-database
//
// DESTRUCTIVE. Wipes all operational data (venues, tickets, consumers,
// businesses, staff invites, verifications, cashback ledger, venue roles)
// and deletes every auth.users row that isn't a super-admin. Preserves
// public.super_admins (and their auth accounts) plus the app_settings
// config singleton.
//
// Two guards before anything runs:
//   1. Caller's JWT email must be in public.super_admins.
//   2. Body must carry { confirm: "RESET" } — a typed phrase so a stray
//      click or replayed request can't trigger a wipe.
//
// The actual work lives in the public.admin_reset_database() SQL
// function (security definer, service-role only). This EF just gates and
// delegates.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

type Body = { confirm?: string };

const CONFIRM_PHRASE = "RESET";
// Invariant: venue-images must survive admin reset (do not delete files).
// We only clear legacy atlas artifacts here.
const RESET_BUCKETS = ["atlas"] as const;

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

  // --- Guard 1: super_admins gate. ---
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  // --- Guard 2: typed confirmation phrase. ---
  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  if (body.confirm !== CONFIRM_PHRASE) {
    return json(
      { ok: false, error: `confirm must equal "${CONFIRM_PHRASE}"` },
      400,
    );
  }

  // --- Delegate to the locked-down SQL function. ---
  const { data, error } = await admin.rpc("admin_reset_database");
  if (error) {
    return json({ ok: false, error: `reset_failed: ${error.message}` }, 500);
  }

  const storage = await purgeResetBuckets(admin);

  return json({ ok: true, result: data, storage });
});

async function purgeResetBuckets(admin: ReturnType<typeof adminClient>) {
  const summary: Record<string, { found: number; removed: number; errors: string[] }> = {};

  for (const bucket of RESET_BUCKETS) {
    const errors: string[] = [];
    let found = 0;
    let removed = 0;
    let offset = 0;
    const pageSize = 500;

    while (true) {
      const { data, error } = await admin
        .from("storage.objects")
        .select("name")
        .eq("bucket_id", bucket)
        .range(offset, offset + pageSize - 1);
      if (error) {
        errors.push(`list: ${error.message}`);
        break;
      }
      if (!data || data.length === 0) break;

      const names = data
        .map((r) => (typeof r.name === "string" ? r.name : ""))
        .filter(Boolean);
      found += names.length;

      for (let i = 0; i < names.length; i += 100) {
        const chunk = names.slice(i, i + 100);
        const { error: removeErr } = await admin.storage.from(bucket).remove(chunk);
        if (removeErr) {
          errors.push(`remove: ${removeErr.message}`);
        } else {
          removed += chunk.length;
        }
      }

      if (data.length < pageSize) break;
      offset += pageSize;
    }

    summary[bucket] = { found, removed, errors };
  }

  return summary;
}
