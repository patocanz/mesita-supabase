// Supabase Edge Function — manager-invite-waiter
//
// Create a staff_invites row for a waiter / validator. The channel
// (whatsapp | sms) and an optional pre-bound phone are persisted so the
// Twilio integration coming in a few days can pick them up without a
// migration. For now this is the *mock* path: no SMS goes out, the
// caller receives the share URL and forwards it manually.
//
// Auth: any venue member (owner, editor/manager, viewer) — viewers
// already see waiters via manager-list-team and inviting one is a
// low-risk action. Tighten later if needed.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = {
  venueId?: string;
  channel?: "whatsapp" | "sms";
  phone?: string;
  redirectBase?: string;
};

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
  const callerId = userData.user.id;
  const callerEmail = userData.user.email?.toLowerCase() ?? null;

  let body: Body = {};
  try { body = (await req.json()) as Body; } catch { /* empty */ }
  const venueId = (body.venueId ?? "").trim();
  const channel = (body.channel ?? "whatsapp") as Body["channel"];
  const phone = normalisePhone(body.phone);
  const redirectBase = (body.redirectBase ?? "").trim().replace(/\/$/, "");
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (channel !== "whatsapp" && channel !== "sms") {
    return json({ ok: false, error: "channel must be whatsapp or sms" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Membership gate (any role).
  let isMember = false;
  if (callerEmail) {
    const { data: saRow } = await admin
      .from("super_admins")
      .select("email")
      .eq("email", callerEmail)
      .maybeSingle();
    if (saRow) isMember = true;
  }
  if (!isMember) {
    const { data: vmRow } = await admin
      .from("venue_members")
      .select("role")
      .eq("venue_id", venueId)
      .eq("manager_id", callerId)
      .maybeSingle();
    if (vmRow) isMember = true;
  }
  if (!isMember) {
    return json({ ok: false, error: "Not a member of this venue" }, 403);
  }

  const token = base64UrlSafe(crypto.getRandomValues(new Uint8Array(18)));

  const insert = await admin
    .from("staff_invites")
    .insert({
      venue_id: venueId,
      token,
      phone,
      channel,
      created_by: callerId,
    })
    .select("id, token, phone, channel, expires_at")
    .single();
  if (insert.error) {
    return json({ ok: false, error: `invite_insert: ${insert.error.message}` }, 500);
  }

  const shareUrl = redirectBase
    ? `${redirectBase}/accept-invite?token=${encodeURIComponent(token)}&kind=waiter`
    : null;

  return json({
    ok: true,
    inviteId: insert.data.id,
    token: insert.data.token,
    phone: insert.data.phone,
    channel: insert.data.channel,
    expiresAt: insert.data.expires_at,
    shareUrl,
    // Twilio integration lands later — this flag advertises the current
    // mock behaviour to the UI so it can label the "Send via" button
    // honestly.
    sent: false,
  });
});

function normalisePhone(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Strip everything that isn't a digit or leading '+'.
  const cleaned = s.replace(/[^0-9+]/g, "");
  if (!/^\+?\d{7,15}$/.test(cleaned)) return null;
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

function base64UrlSafe(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
