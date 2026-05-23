// Supabase Edge Function — manager-test-waiter-channel
//
// Mocked "send test ping" button on the Team page. Once Twilio is wired
// up this function will actually fire a WhatsApp / SMS to the given
// phone via the chosen channel; until then it returns ok with a flag so
// the UI can render a "(mock — Twilio coming soon)" caption.
//
// Auth: any venue member.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";

type Body = {
  venueId?: string;
  channel?: "whatsapp" | "sms";
  phone?: string;
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
  const phone = (body.phone ?? "").trim();
  if (!venueId) return json({ ok: false, error: "venueId is required" }, 400);
  if (channel !== "whatsapp" && channel !== "sms") {
    return json({ ok: false, error: "channel must be whatsapp or sms" }, 400);
  }
  if (!phone || !/^\+?\d{7,15}$/.test(phone.replace(/[^0-9+]/g, ""))) {
    return json({ ok: false, error: "phone must be E.164-ish (7–15 digits)" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Membership gate.
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

  // Twilio integration arrives in a few days. Until then we just
  // pretend the ping went out — the manager UI labels it as a mock.
  return json({
    ok: true,
    channel,
    to: phone,
    sent: false,
    mock: true,
    note: "Twilio not wired yet — message was not actually sent.",
  });
});
