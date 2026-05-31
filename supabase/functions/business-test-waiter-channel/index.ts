// Supabase Edge Function — business-test-waiter-channel
//
// Mocked "send test ping" button on the Team page. Once Twilio is
// wired up this will actually fire a WhatsApp / SMS via the chosen
// channel; until then it returns ok with a flag so the UI can render
// a "(mock — Twilio coming soon)" caption.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";

type Body = {
  venueId?: string;
  channel?: "whatsapp" | "sms";
  phone?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const body = await readJsonOr<Body>(req, {});
  const venueId = (body.venueId ?? "").trim();
  const channel = (body.channel ?? "whatsapp") as Body["channel"];
  const phone = (body.phone ?? "").trim();
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (channel !== "whatsapp" && channel !== "sms") {
    return json({ ok: false, error: "channel must be whatsapp or sms" }, 400);
  }
  if (!phone || !/^\+?\d{7,15}$/.test(phone.replace(/[^0-9+]/g, ""))) {
    return json({ ok: false, error: "phone must be E.164-ish (7–15 digits)" }, 400);
  }

  const admin = adminClient(envRes.env);
  const membership = await requireMembership(admin, authRes.user, venueId);
  if (!membership.ok) return membership.response;

  return json({
    ok: true,
    channel,
    to: phone,
    sent: false,
    mock: true,
    note: "Twilio not wired yet — message was not actually sent.",
  });
});
