// Supabase Edge Function — manager-invite-waiter
//
// Create a staff_invites row for a waiter / validator. The channel
// (whatsapp | sms) and an optional pre-bound phone are persisted so
// the Twilio integration coming in a few days can pick them up
// without a migration. For now this is the *mock* path: no SMS goes
// out, the caller receives the share URL and forwards it manually.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";
import { newInviteToken } from "../_shared/tokens.ts";

type Body = {
  venueId?: string;
  channel?: "whatsapp" | "sms";
  phone?: string;
  redirectBase?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

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

  const admin = adminClient(envRes.env);
  const membership = await requireMembership(admin, authRes.user, venueId);
  if (!membership.ok) return membership.response;

  const token = newInviteToken();

  const insert = await admin
    .from("staff_invites")
    .insert({
      venue_id: venueId,
      token,
      phone,
      channel,
      created_by: authRes.user.id,
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
    sent: false,
  });
});

function normalisePhone(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const cleaned = s.replace(/[^0-9+]/g, "");
  if (!/^\+?\d{7,15}$/.test(cleaned)) return null;
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}
