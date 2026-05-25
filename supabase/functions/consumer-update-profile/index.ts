// Supabase Edge Function — consumer-update-profile
//
// Authenticated. The consumer writes their own onboarding details (name, sex,
// birthday, country, phone). Auto-creates the consumer row on first call so
// onboarding works even if the user hasn't hit /qr yet to trigger
// consumer-get-profile's lazy create.
//
// Self-contained: own JWT verification, own DB writes via the service role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { clean } from "../_shared/input.ts";

type Body = {
  full_name?: string | null;
  sex?: string | null;
  birthday?: string | null;
  country?: string | null;
  phone?: string | null;
};

const SEX_VALUES = new Set(["male", "female", "other"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

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

  const admin = adminClient(envRes.env);

  // Ensure a consumer row exists. If not, create it with a generated code so
  // the validator can scan the QR immediately after onboarding.
  const existing = await admin
    .from("consumers")
    .select("id, code")
    .eq("id", userId)
    .maybeSingle();
  if (existing.error) {
    return json({ ok: false, error: `consumer_read: ${existing.error.message}` }, 500);
  }
  if (!existing.data) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const codeResult = await admin.rpc("generate_consumer_code");
      if (codeResult.error) {
        return json({ ok: false, error: `code_gen: ${codeResult.error.message}` }, 500);
      }
      const inserted = await admin
        .from("consumers")
        .insert({ id: userId, code: codeResult.data as string })
        .select("id, code")
        .single();
      if (!inserted.error) break;
      if (inserted.error.code !== "23505") {
        return json({ ok: false, error: `consumer_create: ${inserted.error.message}` }, 500);
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
    .from("consumers")
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
    return json({ ok: false, error: `consumer_update: ${update.error.message}` }, 500);
  }

  return json({ ok: true, consumer: update.data });
});
