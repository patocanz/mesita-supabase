// Supabase Edge Function — twilio-whatsapp-inbound (external caller)
//
// Public webhook (verify_jwt = false). Twilio POSTs inbound WhatsApp
// messages here when configured on each WhatsApp Sender. Security:
// X-Twilio-Signature HMAC validation.
//
// v1: acknowledge + log. Reply routing (staff invites, consumer support)
// lands in a later iteration.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  emptyMessagingTwiml,
  readTwilioEnv,
  validateTwilioRequest,
  webhookUrlForFunction,
} from "../_shared/twilio.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const twilio = readTwilioEnv();
  if (!twilio.ok) {
    console.error("[twilio-whatsapp-inbound]", twilio.error);
    return new Response("Twilio not configured", { status: 500 });
  }

  const raw = await req.clone().text();
  const params = Object.fromEntries(new URLSearchParams(raw));
  const url = webhookUrlForFunction("twilio-whatsapp-inbound");
  const valid = await validateTwilioRequest(
    twilio.env.authToken,
    req.headers.get("X-Twilio-Signature"),
    url,
    params,
  );
  if (!valid) {
    console.warn("[twilio-whatsapp-inbound] invalid signature", { url });
    return new Response("Forbidden", { status: 403 });
  }

  console.info("[twilio-whatsapp-inbound]", {
    messageSid: params.MessageSid,
    from: params.From,
    to: params.To,
    body: params.Body?.slice(0, 200),
    numMedia: params.NumMedia ?? "0",
  });

  return emptyMessagingTwiml();
});
