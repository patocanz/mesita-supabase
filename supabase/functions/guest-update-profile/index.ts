// Supabase Edge Function — guest-update-profile
//
// Authenticated. The guest writes their own onboarding details (name, sex,
// birthday, country, phone). Auto-creates the guest row on first call so
// onboarding works even if the user hasn't hit /qr yet to trigger
// guest-profile's lazy create.
//
// Self-contained: own JWT verification, own DB writes via the service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Body = {
  full_name?: string | null;
  sex?: string | null;
  birthday?: string | null;
  country?: string | null;
  phone?: string | null;
};

const SEX_VALUES = new Set(["male", "female", "other"]);

function clean(v: unknown, max = 120): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
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
  const userId = userData.user.id;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const fullName = clean(body.full_name, 120);
  const country = clean(body.country, 64);
  const phone = clean(body.phone, 32);
  const sexRaw = clean(body.sex, 16);
  const birthdayRaw = clean(body.birthday, 32);

  const sex = sexRaw && SEX_VALUES.has(sexRaw.toLowerCase()) ? sexRaw.toLowerCase() : null;
  if (sexRaw && !sex) {
    return json({ ok: false, error: "sex must be male, female, or other" }, 400);
  }

  let birthday: string | null = null;
  if (birthdayRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdayRaw)) {
      return json({ ok: false, error: "birthday must be YYYY-MM-DD" }, 400);
    }
    // Sanity check: must parse + not in the future.
    const parsed = new Date(`${birthdayRaw}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return json({ ok: false, error: "birthday is not a real date" }, 400);
    }
    if (parsed.getTime() > Date.now()) {
      return json({ ok: false, error: "birthday can't be in the future" }, 400);
    }
    birthday = birthdayRaw;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Ensure a guest row exists. If not, create it with a generated code so
  // the validator can scan the QR immediately after onboarding.
  const existing = await admin
    .from("guests")
    .select("id, code")
    .eq("id", userId)
    .maybeSingle();
  if (existing.error) {
    return json({ ok: false, error: `guest_read: ${existing.error.message}` }, 500);
  }
  if (!existing.data) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const codeResult = await admin.rpc("generate_guest_code");
      if (codeResult.error) {
        return json({ ok: false, error: `code_gen: ${codeResult.error.message}` }, 500);
      }
      const inserted = await admin
        .from("guests")
        .insert({ id: userId, code: codeResult.data as string })
        .select("id, code")
        .single();
      if (!inserted.error) break;
      if (inserted.error.code !== "23505") {
        return json({ ok: false, error: `guest_create: ${inserted.error.message}` }, 500);
      }
    }
  }

  // Build a patch with only the fields the caller actually sent. Avoids
  // null-clobbering values they didn't intend to touch.
  const patch: Record<string, unknown> = {};
  if (body.full_name !== undefined) patch.full_name = fullName;
  if (body.sex !== undefined) patch.sex = sex;
  if (body.birthday !== undefined) patch.birthday = birthday;
  if (body.country !== undefined) patch.country = country;
  if (body.phone !== undefined) patch.phone = phone;

  if (Object.keys(patch).length === 0) {
    return json({ ok: false, error: "Nothing to update" }, 400);
  }

  const update = await admin
    .from("guests")
    .update(patch)
    .eq("id", userId)
    .select(
      "id, code, full_name, sex, birthday, country, phone, cashback_balance_cents",
    )
    .single();
  if (update.error) {
    if (update.error.code === "23505") {
      return json(
        { ok: false, code: "phone_taken", error: "That phone is already on another account." },
        409,
      );
    }
    return json({ ok: false, error: `guest_update: ${update.error.message}` }, 500);
  }

  return json({ ok: true, guest: update.data });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
