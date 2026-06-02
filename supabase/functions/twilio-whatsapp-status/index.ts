// Supabase Edge Function — twilio-whatsapp-status (external caller)
//
// Delivery/read receipts for outbound WhatsApp. Configure as status
// callback URL on each WhatsApp Sender in Twilio Console.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
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
    return new Response("Twilio not configured", { status: 500 });
  }

  const raw = await req.clone().text();
  const params = Object.fromEntries(new URLSearchParams(raw));
  const url = webhookUrlForFunction("twilio-whatsapp-status");
  const valid = await validateTwilioRequest(
    twilio.env.authToken,
    req.headers.get("X-Twilio-Signature"),
    url,
    params,
  );
  if (!valid) {
    return new Response("Forbidden", { status: 403 });
  }

  console.info("[twilio-whatsapp-status]", {
    messageSid: params.MessageSid,
    status: params.MessageStatus,
    to: params.To,
    from: params.From,
    errorCode: params.ErrorCode ?? null,
  });

  return new Response(null, { status: 204 });
});
