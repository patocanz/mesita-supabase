// Supabase Edge Function — twilio-whatsapp-inbound (external caller)
//
// Public webhook (verify_jwt = false). Routes inbound WhatsApp to:
//   • Mesita Ops (Staff) — Type A discount billing via LLM + session state
//   • Mesita Consumers — acknowledgement (support flows later)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  emptyMessagingTwiml,
  normaliseWhatsAppFrom,
  parseTwilioForm,
  readTwilioEnv,
  sendWhatsAppText,
  validateTwilioRequest,
  webhookUrlForFunction,
} from "../_shared/twilio.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import {
  handleStaffInboundMessage,
  resolveStaffFromPhone,
} from "../_shared/staff-whatsapp-flow.ts";

function phoneFromWhatsAppAddress(addr: string): string {
  const raw = addr.replace(/^whatsapp:/i, "").trim();
  return raw.startsWith("+") ? raw : `+${raw}`;
}

function isStaffLine(to: string, staffFrom: string): boolean {
  const a = normaliseWhatsAppFrom(to);
  const b = normaliseWhatsAppFrom(staffFrom);
  return a === b;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const twilio = readTwilioEnv();
  if (!twilio.ok) {
    console.error("[twilio-whatsapp-inbound]", twilio.error);
    return new Response("Twilio not configured", { status: 500 });
  }

  const params = await parseTwilioForm(req);
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

  const body = (params.Body ?? "").trim();
  const fromPhone = phoneFromWhatsAppAddress(params.From ?? "");
  const toLine = params.To ?? "";

  console.info("[twilio-whatsapp-inbound]", {
    messageSid: params.MessageSid,
    from: fromPhone,
    to: toLine,
    body: body.slice(0, 200),
  });

  if (!body) {
    return emptyMessagingTwiml();
  }

  const envRes = readEFEnv();
  if (!envRes.ok) {
    console.error("[twilio-whatsapp-inbound] supabase env", envRes.error);
    return emptyMessagingTwiml();
  }
  const admin = adminClient(envRes.env);

  try {
    if (isStaffLine(toLine, twilio.env.whatsappFromStaff)) {
      const staff = await resolveStaffFromPhone(admin, fromPhone);
      if (!staff) {
        await sendWhatsAppText({
          env: twilio.env,
          from: twilio.env.whatsappFromStaff,
          to: fromPhone,
          body:
            "This number isn't linked to a Mesita staff account. Accept your venue invite in the app first, then try again.",
        });
      } else {
        await handleStaffInboundMessage({
          admin,
          twilio: twilio.env,
          staff,
          body,
        });
      }
    } else {
      await sendWhatsAppText({
        env: twilio.env,
        from: twilio.env.whatsappFromConsumers,
        to: fromPhone,
        body:
          "Thanks for messaging Mesita. For dining rewards, use the Mesita app. This line is for account support coming soon.",
      });
    }
  } catch (err) {
    console.error("[twilio-whatsapp-inbound] handler error", err);
    if (isStaffLine(toLine, twilio.env.whatsappFromStaff)) {
      await sendWhatsAppText({
        env: twilio.env,
        from: twilio.env.whatsappFromStaff,
        to: fromPhone,
        body: "Something went wrong on our side. Please try again in a moment.",
      }).catch(() => {});
    }
  }

  return emptyMessagingTwiml();
});
