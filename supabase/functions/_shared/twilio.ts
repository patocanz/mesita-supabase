// Twilio helpers for WhatsApp (and future SMS) from Edge Functions.
// Webhook security: HMAC-SHA1 per Twilio docs (no SDK required).

export type TwilioEnv = {
  accountSid: string;
  authToken: string;
  whatsappFromStaff: string;
  whatsappFromConsumers: string;
};

export function readTwilioEnv():
  | { ok: true; env: TwilioEnv }
  | { ok: false; error: string } {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID")?.trim();
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN")?.trim();
  if (!accountSid || !authToken) {
    return { ok: false, error: "Twilio not configured" };
  }
  const staff =
    Deno.env.get("TWILIO_WHATSAPP_FROM_STAFF")?.trim() ||
    "whatsapp:+16282968794";
  const consumers =
    Deno.env.get("TWILIO_WHATSAPP_FROM_CONSUMERS")?.trim() ||
    "whatsapp:+16282964968";
  return {
    ok: true,
    env: {
      accountSid,
      authToken,
      whatsappFromStaff: normaliseWhatsAppFrom(staff),
      whatsappFromConsumers: normaliseWhatsAppFrom(consumers),
    },
  };
}

export function normaliseWhatsAppFrom(value: string): string {
  const v = value.trim();
  return v.startsWith("whatsapp:") ? v : `whatsapp:${v.replace(/^\+?/, "+")}`;
}

export function normaliseWhatsAppTo(e164: string): string {
  const digits = e164.replace(/[^\d+]/g, "");
  const withPlus = digits.startsWith("+") ? digits : `+${digits}`;
  return `whatsapp:${withPlus}`;
}

export async function parseTwilioForm(
  req: Request,
): Promise<Record<string, string>> {
  const raw = await req.text();
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    params[key] = value;
  }
  return params;
}

/** Reconstruct the public URL Twilio POSTed to (set TWILIO_WEBHOOK_URL if needed). */
export function webhookUrlForFunction(functionName: string): string {
  const explicit = Deno.env.get(`TWILIO_WEBHOOK_URL_${functionName.toUpperCase().replace(/-/g, "_")}`);
  if (explicit?.trim()) return explicit.trim();
  const base = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  if (!base) throw new Error("SUPABASE_URL missing");
  return `${base}/functions/v1/${functionName}`;
}

export async function validateTwilioRequest(
  authToken: string,
  signature: string | null,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  if (!signature) return false;
  const sorted = Object.keys(params).sort();
  let payload = url;
  for (const key of sorted) payload += key + params[key];
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function emptyMessagingTwiml(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

export async function sendWhatsAppText(opts: {
  env: TwilioEnv;
  from: string;
  to: string;
  body: string;
}): Promise<{ ok: true; sid: string } | { ok: false; error: string }> {
  const { env, from, to, body } = opts;
  const auth = btoa(`${env.accountSid}:${env.authToken}`);
  const form = new URLSearchParams({
    From: normaliseWhatsAppFrom(from),
    To: normaliseWhatsAppTo(to),
    Body: body,
  });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { message?: string }).message ?? res.statusText;
    return { ok: false, error: msg };
  }
  return { ok: true, sid: (data as { sid: string }).sid };
}
