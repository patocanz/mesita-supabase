# WhatsApp (Twilio) — runbook

Operational detail for Mesita WhatsApp. Architecture overview: [README.md](../README.md).

## IDs

| | ID |
|---|---|
| Meta Business Portfolio (Mesita) | `1180640363250622` |
| WABA | `1389123139178386` |
| Staff sender | `+1 628 296 8794` — Mesita Ops |
| Consumer sender | `+1 628 296 4968` — Mesita Notifications |
| Recording TwiML bin | `EHfd33bff85448c2a934494625fb70d808` |

## Webhook URLs (prod)

Base: `https://yjalywfzdelacdzccpgb.supabase.co/functions/v1`

| Endpoint | Function |
|---|---|
| `/twilio-whatsapp-inbound` | Inbound messages |
| `/twilio-whatsapp-status` | Delivery receipts |

Apply via `./scripts/sync-twilio-whatsapp-webhooks.sh` or Twilio Console → WhatsApp Senders.

## Secrets

```bash
supabase secrets set \
  TWILIO_ACCOUNT_SID=AC... \
  TWILIO_AUTH_TOKEN=... \
  TWILIO_WHATSAPP_FROM_STAFF='whatsapp:+16282968794' \
  TWILIO_WHATSAPP_FROM_CONSUMERS='whatsapp:+16282964968'
```

Local scripts: `.env.twilio.local` (see `.env.twilio.local.example`).

## Templates

Definitions: `integrations/twilio/templates/`. Create in Twilio Content Builder or via future apply script — **not** in Meta UI alone.

## Meta (manual)

- [Business Verification](https://business.facebook.com/latest/settings/security_center?business_id=1180640363250622)
- OBA (green ✓): optional, WhatsApp Manager per number

## Voice OTP tip

For Twilio-owned numbers, use **phone call** verification in Meta signup; SMS OTP lands in Twilio Messaging Logs.
